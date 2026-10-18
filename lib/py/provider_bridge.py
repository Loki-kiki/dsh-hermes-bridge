#!/usr/bin/env python3
"""Hermes memory-provider bridge — a JSON-lines worker spoken to by the DSH plugin.

Why this exists
---------------
Hermes ships memory providers as *Python plugins* behind one uniform contract
(``MemoryProvider.get_tool_schemas()`` + ``handle_tool_call(name, args)``).
Today that is `openviking`, `retaindb` and `byterover` in-tree, plus 60-odd
catalog-installed ones (honcho, mem0, hindsight, supermemory, lancedb, …), and
the set keeps growing.

Re-implementing each provider's REST/CLI client in JavaScript would be a
permanent game of catch-up: every new provider, every changed endpoint, every
schema tweak would need a matching JS edit, and any drift would show up as a
tool that silently returns the wrong thing. So this worker does the opposite —
it *loads the provider Hermes itself would load* and forwards the two calls that
matter. Whatever the user has configured, and whatever Hermes gains later, works
here without a line of new bridge code.

Protocol (one JSON object per line, request → response, same ``id``)
-------------------------------------------------------------------
    {"id":1,"op":"hello"}
        → {"id":1,"ok":true,"python":"3.11.9","agentRoot":"…","providers":[…],"configured":"openviking"}
    {"id":2,"op":"tools"}
        → {"id":2,"ok":true,"provider":"openviking","available":true,"reason":"","tools":[…]}
    {"id":3,"op":"call","name":"viking_search","args":{"query":"x"}}
        → {"id":3,"ok":true,"result":{…}}         (or {"ok":false,"error":"…"})
    {"id":4,"op":"shutdown"}
        → {"id":4,"ok":true}   then exit

Two invariants that are easy to get wrong and expensive to debug:

1. **stdout is the wire.** Hermes' providers print, log, and occasionally write
   progress to stdout; any stray byte corrupts the protocol. So fd 1 is
   duplicated for our own writes and then *replaced by fd 2* — everything else
   in the process (including ``print``) lands on stderr, which the plugin reads
   as log lines.
2. **Nothing heavy at import time.** The plugin starts this worker lazily on the
   first tool call, so the import cost is paid once, off the boot path.

Failure policy: this worker never dies on a provider error. A provider that
cannot be loaded, is unconfigured, or raises inside a tool call answers with
``ok:false`` and a sentence the model can relay. The plugin row stays mounted.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

# ── wire setup: keep our own handle, then make fd 1 safe for everyone else ────
_WIRE = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1, newline="\n")
try:
    os.dup2(2, 1)
except OSError:  # pragma: no cover - exotic platforms without dup2
    pass


def _emit(payload: dict) -> None:
    """Write one protocol line, tolerating a closed pipe (plugin went away)."""
    try:
        _WIRE.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        _WIRE.flush()
    except (BrokenPipeError, ValueError):
        os._exit(0)


def _log(message: str) -> None:
    """Diagnostics go to stderr; the plugin forwards them to its own logger."""
    try:
        sys.stderr.write(f"[provider-bridge] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


class Bridge:
    """Holds the one provider instance this process is allowed to own."""

    def __init__(self, agent_root: str, hermes_home: str, requested: str) -> None:
        self.agent_root = agent_root
        self.hermes_home = hermes_home
        self.requested = requested
        self.provider = None
        self.provider_name = ""
        self.available = False
        self.reason = ""
        self.tools: list[dict] = []
        self.loaded = False

    # -- loading ------------------------------------------------------------
    def prepare(self) -> None:
        """Make Hermes' packages importable, and load its .env for credentials.

        Runs once, before any op: `hello` needs `plugins.memory` importable too,
        and Hermes' modules expect the agent root as cwd (several resolve data
        paths relative to it).
        """
        if self.agent_root not in sys.path:
            sys.path.insert(0, self.agent_root)
        os.chdir(self.agent_root)

        # Hermes' own .env supplies the provider credentials. Without this the
        # cloud providers report "not configured" even though Hermes works —
        # the keys live in <hermes-home>/.env, not in the DSH process env.
        try:
            from hermes_cli.env_loader import load_hermes_dotenv

            load_hermes_dotenv(hermes_home=self.hermes_home)
        except Exception as exc:  # a missing dotenv must not stop a local provider
            _log(f"dotenv load skipped: {exc}")
    def _configured_name(self) -> str:
        """`memory.provider` from the profile's config.yaml, or the row override."""
        if self.requested:
            return self.requested
        config_path = os.path.join(self.hermes_home, "config.yaml")
        try:
            import yaml

            with open(config_path, "r", encoding="utf-8") as handle:
                parsed = yaml.safe_load(handle) or {}
            value = (parsed.get("memory") or {}).get("provider")
            return str(value or "").strip()
        except FileNotFoundError:
            return ""
        except Exception as exc:
            _log(f"cannot read {config_path}: {exc}")
            return ""

    def load(self) -> None:
        """Import Hermes' provider loader, instantiate the configured provider.

        Idempotent: the plugin calls `tools` once per process, but a reload of
        the row must not pay the import again.
        """
        if self.loaded:
            return
        self.loaded = True
        self.prepare()

        from plugins.memory import load_memory_provider, list_memory_provider_names

        self.provider_name = self._configured_name()
        if not self.provider_name:
            self.reason = (
                "Hermes has no external memory provider configured "
                "(memory.provider is empty — the built-in MEMORY.md/USER.md store is in use). "
                "Set it with `hermes config set memory.provider <name>`, then restart Hermes."
            )
            return

        try:
            self.provider = load_memory_provider(self.provider_name, register_skills=False)
        except Exception as exc:
            self.reason = f"loading provider {self.provider_name!r} failed: {exc}"
            return
        if self.provider is None:
            known = ", ".join(list_memory_provider_names()) or "(none installed)"
            self.reason = (
                f"provider {self.provider_name!r} is not installed or is disabled in Hermes "
                f"(plugins.disabled). Installed providers: {known}. "
                "Install it with `hermes plugins install <name> --enable`."
            )
            return

        try:
            self.available = bool(self.provider.is_available())
        except Exception as exc:
            self.available = False
            self.reason = f"{self.provider_name}.is_available() raised: {exc}"
            return
        if not self.available:
            try:
                detail = self.provider.unavailable_reason() or ""
            except Exception:
                detail = ""
            self.reason = (
                f"provider {self.provider_name!r} is installed but not ready"
                + (f": {detail}" if detail else "")
                + ". Configure it in Hermes (hermes memory setup) — the credentials live in "
                  "<hermes-home>/.env."
            )
            return

        try:
            # `platform='cli'` keeps the provider from assuming a transport
            # peer id; `agent_context='primary'` is what allows writes (cron /
            # subagent / flush contexts are read-only by design in Hermes).
            self.provider.initialize(
                session_id=os.environ.get("HERMES_BRIDGE_SESSION", "dsh-hermes-bridge"),
                hermes_home=self.hermes_home,
                platform="cli",
                agent_context="primary",
            )
        except Exception as exc:
            self.reason = f"{self.provider_name}.initialize() raised: {exc}"
            self.provider = None
            return

        try:
            schemas = self.provider.get_tool_schemas() or []
        except Exception as exc:
            self.reason = f"{self.provider_name}.get_tool_schemas() raised: {exc}"
            self.provider = None
            return

        self.tools = [schema for schema in schemas if isinstance(schema, dict) and schema.get("name")]

    # -- operations ---------------------------------------------------------
    def hello(self) -> dict:
        self.prepare()
        try:
            from plugins.memory import list_memory_provider_names

            names = list_memory_provider_names()
        except Exception as exc:
            names = []
            _log(f"provider listing failed: {exc}")
        return {
            "python": sys.version.split()[0],
            "agentRoot": self.agent_root,
            "providers": names,
            "configured": self._configured_name(),
        }

    def describe(self) -> dict:
        self.load()
        return {
            "provider": self.provider_name,
            "available": self.available and self.provider is not None,
            "reason": self.reason,
            "prompt": self._prompt(),
            "tools": [
                {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
                }
                for tool in self.tools
            ],
        }

    def _prompt(self) -> str:
        """The provider's own system-prompt blurb, when it has one.

        Providers use this to tell the model which tools exist and what the
        backend holds ("# RetainDB Memory — Active. Project: …"). Echoing it is
        what makes the bridged provider feel present rather than merely callable.
        """
        if self.provider is None:
            return ""
        try:
            return str(self.provider.system_prompt_block() or "")
        except Exception as exc:
            _log(f"system_prompt_block raised: {exc}")
            return ""

    def call(self, name: str, args: dict) -> dict:
        self.load()
        if self.provider is None:
            return {"ok": False, "error": self.reason or "no memory provider is available"}
        if name not in {tool["name"] for tool in self.tools}:
            known = ", ".join(tool["name"] for tool in self.tools) or "(none)"
            return {"ok": False, "error": f"unknown tool {name!r}; this provider exposes: {known}"}
        try:
            raw = self.provider.handle_tool_call(name, dict(args or {}))
        except Exception as exc:
            _log(traceback.format_exc())
            return {"ok": False, "error": f"{name} raised: {exc}"}
        return {"ok": True, "result": _normalize(raw)}

    def shutdown(self) -> None:
        provider, self.provider = self.provider, None
        if provider is None:
            return
        try:
            provider.shutdown()
        except Exception as exc:
            _log(f"provider shutdown raised: {exc}")


def _normalize(raw: object) -> object:
    """Providers answer with a JSON *string*; hand the plugin structured data.

    A provider that returns plain prose (some do for empty results) keeps its
    text under ``text`` so nothing is lost and the model still sees a sentence.
    """
    if isinstance(raw, (dict, list)):
        return raw
    if raw is None:
        return {}
    text = str(raw)
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    return {"text": text}


def main() -> int:
    agent_root = os.environ.get("HERMES_AGENT_ROOT", "")
    hermes_home = os.environ.get("HERMES_HOME", "")
    if not agent_root or not os.path.isdir(agent_root):
        _emit({"id": 0, "ok": False, "error": f"HERMES_AGENT_ROOT is not a directory: {agent_root!r}"})
        return 2
    bridge = Bridge(agent_root, hermes_home, os.environ.get("HERMES_BRIDGE_PROVIDER", ""))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"id": 0, "ok": False, "error": f"bad request line: {exc}"})
            continue
        request_id = message.get("id", 0)
        op = message.get("op", "")
        try:
            if op == "hello":
                _emit({"id": request_id, "ok": True, **bridge.hello()})
            elif op == "tools":
                _emit({"id": request_id, "ok": True, **bridge.describe()})
            elif op == "call":
                payload = bridge.call(str(message.get("name", "")), message.get("args") or {})
                _emit({"id": request_id, **payload})
            elif op == "shutdown":
                bridge.shutdown()
                _emit({"id": request_id, "ok": True})
                return 0
            else:
                _emit({"id": request_id, "ok": False, "error": f"unknown op {op!r}"})
        except Exception as exc:  # never let one bad request kill the worker
            _log(traceback.format_exc())
            _emit({"id": request_id, "ok": False, "error": f"{op} failed: {exc}"})
    bridge.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
