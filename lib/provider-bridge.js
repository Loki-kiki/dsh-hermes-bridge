/**
 * Talk to Hermes' own memory provider through `lib/py/provider_bridge.py`.
 *
 * The point of going through Python at all is that Hermes' providers are Python
 * plugins behind one contract (`get_tool_schemas()` + `handle_tool_call()`), and
 * the set keeps growing: openviking, retaindb and byterover ship in-tree today,
 * and the plugin catalog carries dozens more (honcho, mem0, hindsight,
 * supermemory, lancedb, …). Re-implementing each one's REST or CLI client here
 * would mean every new provider — and every endpoint change — needs a matching
 * JavaScript edit, and any drift fails as a tool that quietly returns the wrong
 * thing. Loading the provider Hermes itself would load removes that class of bug
 * entirely: whatever the user configured, and whatever Hermes gains later, works
 * without a new line of bridge code.
 *
 * Two process-level rules live here:
 *
 * - **The worker is lazy and long-lived.** Booting it costs a Python import of
 *   Hermes' agent tree, so it starts on first use and is reused afterwards.
 * - **A hung call must not wedge the session.** A provider that stops answering
 *   gets its worker killed and respawned on the next call, which is the only
 *   recovery that does not leave a half-read pipe behind.
 *
 * @module dsh-hermes-bridge/provider-bridge
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the Python worker shipped with this package. */
export const WORKER_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'py', 'provider_bridge.py')

/**
 * Default Hermes agent root for a given Hermes home.
 *
 * Hermes installs its Python tree as `<hermes-home>/hermes-agent`; that is the
 * directory whose `plugins/memory` module owns the provider registry.
 *
 * @param {string} hermesHome - resolved Hermes home.
 * @returns {string} candidate agent root.
 */
export function defaultAgentRoot(hermesHome) {
  return path.join(hermesHome, 'hermes-agent')
}

/**
 * Default Python interpreter for a given agent root.
 *
 * Hermes' own venv is the one with the provider dependencies installed
 * (`httpx`, `requests`, the provider SDKs). Falling back to a bare `python`
 * would import fine and then fail inside a provider at call time, so the venv is
 * checked for existence before it is preferred.
 *
 * @param {string} agentRoot - Hermes agent root.
 * @returns {string} interpreter path or command name.
 */
export function defaultPython(agentRoot) {
  const win = process.platform === 'win32'
  const candidate = win
    ? path.join(agentRoot, 'venv', 'Scripts', 'python.exe')
    : path.join(agentRoot, 'venv', 'bin', 'python')
  if (fs.existsSync(candidate)) return candidate
  return win ? 'python' : 'python3'
}

/**
 * Environment for the worker.
 *
 * `PYTHONPATH` / `PYTHONHOME` are cleared on purpose: Hermes' own launch
 * environment points them at its bundled packages, and inheriting that into a
 * second interpreter is the documented way to get `No module named
 * 'pydantic_core._pydantic_core'`-class failures. `PYTHONUTF8` keeps Chinese
 * content from dying on a cp936 stdout.
 *
 * @param {object} config - resolved row config.
 * @returns {NodeJS.ProcessEnv} environment.
 */
function workerEnv(config) {
  const env = { ...process.env }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  return {
    ...env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    HERMES_AGENT_ROOT: config.agentRoot,
    HERMES_HOME: config.hermesHome,
    HERMES_BRIDGE_PROVIDER: config.provider,
    HERMES_BRIDGE_SESSION: `dsh-hermes-bridge-${process.pid}`,
  }
}

/**
 * Shape one request line for the worker.
 * @param {number} id - request id.
 * @param {string} op - operation name.
 * @param {object} [extra] - additional fields.
 * @returns {string} a single JSON line.
 */
function requestLine(id, op, extra) {
  return `${JSON.stringify({ id, op, ...(extra ?? {}) })}\n`
}

/**
 * Parse the worker's answer, tolerating log noise on the wire.
 *
 * The worker moves its own stdout to stderr precisely so this stays clean, but
 * a provider (or a native library it loads) can still write to fd 1 before the
 * redirect takes effect. Skipping unparsable lines costs nothing and keeps a
 * chatty dependency from breaking every call.
 *
 * @param {string} line - one line of worker output.
 * @returns {object|undefined} parsed message, if it was one.
 */
function parseLine(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * A reusable worker process with request/response matching.
 */
export class ProviderWorker {
  /**
   * @param {object} config - resolved row config.
   * @param {(message: string, level?: 'info'|'warn'|'error') => void} [log] - sink for worker diagnostics.
   */
  constructor(config, log) {
    this.config = config
    this.log = log ?? (() => {})
    this.child = undefined
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.stderrTail = []
  }

  /** Spawn the worker if it is not running. */
  ensure() {
    if (this.child !== undefined) return
    const child = spawn(this.config.python, [WORKER_SCRIPT], {
      env: workerEnv(this.config),
      cwd: this.config.agentRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // The worker serves calls; it must never be the reason a host process stays
    // alive after the row that owns it is gone (DSH recomposes profiles, tests
    // end). In-flight calls keep the loop alive through their own timers, so
    // unref here costs nothing — `kill()` / `shutdown()` still reap it explicitly.
    child.unref()
    child.stdin.unref?.()
    child.stdout.unref?.()
    child.stderr.unref?.()
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk) => this.#onStderr(chunk))
    child.on('exit', (code, signal) => this.#onExit(code, signal))
    child.on('error', (error) => {
      this.log(`provider worker failed to start: ${error?.message ?? error}`, 'error')
      this.#failAll(`provider worker failed to start: ${error?.message ?? error}`)
    })
    this.child = child
  }

  /**
   * Feed one stdout chunk through the line buffer.
   * @param {string} chunk - stdout text.
   */
  #onStdout(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      const message = parseLine(line)
      if (message === undefined) {
        if (line.trim() !== '') this.log(`worker stdout: ${line.trim()}`)
      } else {
        const waiter = this.pending.get(message.id)
        if (waiter !== undefined) {
          this.pending.delete(message.id)
          clearTimeout(waiter.timer)
          waiter.resolve(message)
        }
      }
      index = this.buffer.indexOf('\n')
    }
  }

  /**
   * Keep the last stderr lines: they are the only explanation when the worker
   * dies mid-call, and a stack trace is worth more than "exited with 1".
   * @param {string} chunk - stderr text.
   */
  #onStderr(chunk) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      this.stderrTail.push(trimmed)
      if (this.stderrTail.length > 40) this.stderrTail.shift()
      this.log(trimmed, 'info')
    }
  }

  /**
   * Fail every in-flight request when the process goes away.
   * @param {number|null} code - exit code.
   * @param {string|null} signal - exit signal.
   */
  #onExit(code, signal) {
    this.child = undefined
    this.buffer = ''
    const tail = this.stderrTail.slice(-5).join(' | ')
    this.#failAll(
      `provider worker exited (code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`})`
        + (tail === '' ? '' : ` — last output: ${tail}`),
    )
  }

  /**
   * Reject all pending requests with one message.
   * @param {string} reason - error text.
   */
  #failAll(reason) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.resolve({ id: waiter.id, ok: false, error: reason })
    }
    this.pending.clear()
  }

  /**
   * Send one request and wait for its answer.
   * @param {string} op - operation name.
   * @param {object} [extra] - additional request fields.
   * @param {number} [timeoutMs] - budget.
   * @returns {Promise<object>} the worker's answer (never throws).
   */
  request(op, extra, timeoutMs) {
    this.ensure()
    const child = this.child
    if (child === undefined || child.stdin.destroyed) {
      return Promise.resolve({ ok: false, error: 'provider worker is not running' })
    }
    const id = this.nextId
    this.nextId += 1
    const budget = timeoutMs ?? this.config.timeoutMs
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A provider that stopped answering holds the pipe; killing the worker
        // is the only way the next call gets a clean process.
        this.kill()
        resolve({ id, ok: false, error: `provider did not answer within ${budget} ms (worker restarted)` })
      }, budget)
      // Deliberately NOT unref'd: an in-flight provider call is work the caller is
      // waiting on, and a timer that cannot keep the loop alive turns a slow
      // provider into a silent "unsettled await" instead of a timeout error.
      this.pending.set(id, { id, resolve, timer })
      try {
        child.stdin.write(requestLine(id, op, extra))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ id, ok: false, error: `cannot write to provider worker: ${error?.message ?? error}` })
      }
    })
  }

  /** Stop the worker, ignoring a process that already exited. */
  kill() {
    const child = this.child
    this.child = undefined
    this.buffer = ''
    this.#failAll('provider worker was stopped')
    if (child === undefined) return
    try {
      child.stdin.end()
      child.kill()
    } catch {
      /* already gone */
    }
  }

  /** Ask the worker to shut its provider down, then stop it. */
  async shutdown() {
    if (this.child !== undefined) {
      await this.request('shutdown', {}, 5000).catch(() => undefined)
    }
    this.kill()
  }
}

/**
 * Run the worker once, synchronously, to learn which tools the provider exposes.
 *
 * Tool schemas have to exist before the first prompt is assembled, so this is the
 * one blocking call in the row. It is deliberately synchronous: registering tools
 * from a promise would land after boot, and a tool set that appears late is far
 * harder to reason about than a boot that costs a second.
 *
 * @param {object} config - resolved row config.
 * @returns {{ok: boolean, provider: string, available: boolean, reason: string, tools: object[], error?: string}} probe result.
 */
export function probeProviderSync(config) {
  const script = [
    requestLine(1, 'tools'),
    requestLine(2, 'shutdown'),
  ].join('')
  const result = spawnSync(config.python, [WORKER_SCRIPT], {
    env: workerEnv(config),
    cwd: config.agentRoot,
    input: script,
    encoding: 'utf8',
    timeout: config.probeTimeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const stderr = String(result.stderr ?? '')
  if (result.error !== undefined) {
    return {
      ok: false,
      provider: '',
      available: false,
      reason: `cannot start ${config.python}: ${result.error?.message ?? result.error}`,
      tools: [],
      error: stderr,
    }
  }
  const lines = String(result.stdout ?? '').split('\n')
  const answer = lines.map(parseLine).find((message) => message?.id === 1)
  if (answer === undefined) {
    const tail = stderr.split('\n').filter((line) => line.trim() !== '').slice(-6).join(' | ')
    return {
      ok: false,
      provider: '',
      available: false,
      reason: 'the provider worker produced no answer'
        + (tail === '' ? '' : ` — ${tail}`),
      tools: [],
      error: stderr,
    }
  }
  return {
    ok: answer.ok === true,
    provider: answer.provider ?? '',
    available: answer.available === true,
    reason: answer.reason ?? '',
    prompt: typeof answer.prompt === 'string' ? answer.prompt : '',
    tools: Array.isArray(answer.tools) ? answer.tools : [],
    error: answer.ok === true ? '' : String(answer.error ?? ''),
  }
}

/**
 * Locate an executable the way a shell would, so a misconfigured path is
 * reported before the worker is spawned.
 * @param {string} command - path or command name.
 * @returns {boolean} true when it looks runnable.
 */
export function isRunnable(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return fs.existsSync(command)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, `${command}${ext}`))) return true
    }
  }
  return false
}

/** Re-exported so the settings page and CLI share one home resolution. */
export const homeDir = os.homedir
