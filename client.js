/**
 * dsh-hermes-bridge — browser half.
 *
 * One settings section (`settings.section` id `hermes-bridge`) that shows what
 * the bridge is actually wired to and lets the user change it without leaving
 * DSH:
 *
 * - the five row switches (persona / memory / skills / OpenViking / MCP), written
 *   to the profile's own patch layer so they mean the same thing the plugin
 *   manager's switches mean;
 * - every file the bridge reads, with real size and mtime, so "is my memory even
 *   being loaded" is answerable without opening a terminal;
 * - the skill inventory with per-skill switches that take effect on the next
 *   turn, not the next restart;
 * - the OpenViking endpoint's live health, and the Hermes-side memory settings
 *   that decide whether OpenViking participates at all;
 * - a preview of exactly what gets injected into the prompt, rendered from the
 *   same files the rows read.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from the host's
 * `--dsw-alias-*` tokens, so the page follows the app theme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hermes-bridge',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useMemo, useCallback, useRef } = React

    const NS = 'settings.hermesBridge'
    const inject = ['slots', 'locale']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: 'Hermes 桥接',
        title: 'Hermes 桥接',
        subtitle: '把 Hermes 的人设、长期记忆、技能库、MCP 服务器与 OpenViking 知识库原生接进 DeepSeek Harness。每一项都是一个可独立启停的行。',
        loading: '正在读取桥接状态…',
        loadFailed: '读不到桥接状态',
        retry: '重试',
        refresh: '刷新',
        refreshed: '已刷新',
        tabOverview: '总览',
        tabSkills: '技能',
        tabPreview: '预览',
        tabDiagnostics: '诊断',

        'row.persona': '人设',
        'row.memory': '长期记忆',
        'row.memory-write': '记忆写入',
        'row.skills': '技能库',
        'row.viking': 'OpenViking',
        'row.mcp': 'MCP 服务器',
        'row.hermes-data': 'Hermes 数据',
        'row.persona.desc': 'SOUL.md 作为系统提示词段注入，每次请求都在上下文里。',
        'row.memory.desc': 'MEMORY.md + USER.md 常驻注入，每条带来源标记；文件改动下一次组装即生效。',
        'row.memory-write.desc': '给模型一个 memory 工具（增删改查）。写出的条目带 [dsh] 前缀，和 Hermes 自己写的区分开。',
        'row.skills.desc': '把 Hermes 的分类嵌套技能库注册成 DSH 自己的 skill provider。',
        'row.viking.desc': 'OpenViking 知识库的四个工具，按需检索，不占空转 token。',
        'row.mcp.desc': 'Hermes 的 MCP 服务器，每个服务器一条独立行。',
        'row.hermes-data.desc': '只读：Hermes 的 cron 任务清单 + 会话历史全文检索。',
        'row.on': '已启用',
        'row.off': '已停用',
        'row.default': '默认',
        'row.override': '覆盖层',

        origins: '记忆来源',
        originsHint: '两条记忆写入路径共用同一份文件，这里看谁写了多少条。',
        originsCount: '{n} 条',
        'origin.hermes': 'Hermes 写',
        'origin.dsh': 'DSH 写',
        'origin.assumed': 'Hermes（推断）',

        files: '读取的文件',
        filesHint: '桥接真正会读的路径。大小与修改时间取自磁盘，不是配置里的声明。',
        missing: '不存在',
        dir: '目录',
        modified: '修改于',

        hermes: 'Hermes 侧设置',
        hermesHint: '这些值决定 Hermes 自己怎么用记忆。OpenViking 只有在 provider 指向它、且没被禁用名单挡住时才真正参与。',
        memoryProvider: '记忆 provider',
        memoryEnabled: '记忆注入',
        userProfile: '用户画像',
        pluginsDisabled: '禁用插件',
        mcpServers: 'MCP 服务器',
        none: '（无）',
        builtinOnly: '内置（仅 MEMORY.md / USER.md）',

        viking: 'OpenViking',
        vikingReachable: '可达',
        vikingUnreachable: '连不上',
        vikingHint: '这是按需检索的知识库：模型主动搜索才看得到内容，平时不占上下文。',
        vikingEndpoint: '端点',
        vikingVersion: '版本',
        vikingAuth: '鉴权模式',
        vikingDisabledWarn: '⚠ OpenViking 在 Hermes 的 plugins.disabled 里，provider 设了也不会加载。',

        skills: '技能库',
        skillsHint: '开关立即生效：下一次对话就会看到新的清单，不用重启。',
        skillsTotal: '共 {n} 个',
        skillsOn: '启用 {n}',
        skillsOff: '停用 {n}',
        searchSkills: '搜索名称或描述…',
        allOn: '全部启用',
        allOff: '全部停用',
        noSkills: '没有匹配的技能',
        category: '分类',
        allCategories: '全部分类',
        enabling: '应用中…',

        preview: '提示词预览',
        previewHint: '下面就是行注入到系统提示词里的实际内容（人设与记忆）。技能不常驻，靠 skill 工具按需加载。',
        previewPersona: '人设段',
        previewMemory: '记忆段',
        chars: '{n} 字符',
        empty: '（空）',
        expand: '展开全文',
        collapse: '收起',

        diagnostics: '诊断',
        diagnosticsHint: '出问题时先看这里：路径、覆盖层、状态文件。',
        patchPath: '覆盖层路径',
        statePath: '技能状态文件',
        hermesHome: 'Hermes 主目录',
        dshHome: 'DSH 主目录',
        profile: 'Profile',
        copy: '复制',
        copied: '已复制',
        generatedAt: '读取于',

        tabConnection: '连接',
        setupTitle: '没找到 Hermes',
        setupBody: '在 {path} 下没有找到可用的 Hermes 主目录。先安装 Hermes Agent，或者在下面填入正确路径并保存。',
        setupSaved: '已保存。行配置经热重载生效，无需重启。',
        configTitle: '连接设置',
        configHint: '写入本 profile 的覆盖层（cordis.patch.yml），行配置经热重载生效。',
        fieldHermesHome: 'Hermes 主目录',
        fieldHermesHomeHint: '留空 = 自动解析（$HERMES_HOME → 平台默认）',
        fieldVikingEndpoint: 'OpenViking 端点',
        fieldAccount: 'OpenViking 账户',
        fieldUser: 'OpenViking 用户',
        fieldAgent: 'Agent 名',
        probe: '测试路径',
        probing: '测试中…',
        probeOk: '是 Hermes',
        probeMiss: '这里没有',
        save: '保存',
        saving: '保存中…',
        revert: '恢复默认',
        mcpTitle: 'MCP 服务器',
        mcpHermesSide: 'Hermes 声明 {n} 个服务器',
        mcpMounted: '已挂载 {n} 行',
        mcpNeedsSync: 'Hermes 有未挂载的 MCP 服务器，点一下即可生成。',
        mcpSync: '立即同步',
        mcpSyncing: '同步中…',
        mcpSynced: '已写入 {n} 行 MCP 配置；重启 DSH 后生效。',
        mcpClear: '移除受管块',
        mcpCleared: '受管块已移除；重启 DSH 后生效。',
        mcpNoServers: '（Hermes 配置里没有 MCP 服务器）',
        vikingIdentity: 'OpenViking 身份',
        vikingIdentityHint: 'user 是 OpenViking 里的租户名，和 Hermes 侧 config.yaml 的 memory.openviking.user 保持一致才能查到同一批记忆。',
      },
      en: {
        nav: 'Hermes Bridge',
        title: 'Hermes Bridge',
        subtitle: 'Brings Hermes\'s persona, long-term memory, skill library, MCP servers and OpenViking knowledge base into DeepSeek Harness natively. Every capability is its own row.',
        loading: 'Reading bridge status…',
        loadFailed: 'Cannot read bridge status',
        retry: 'Retry',
        refresh: 'Refresh',
        refreshed: 'Refreshed',
        tabOverview: 'Overview',
        tabSkills: 'Skills',
        tabPreview: 'Preview',
        tabDiagnostics: 'Diagnostics',
        'row.persona': 'Persona',
        'row.memory': 'Long-term memory',
        'row.memory-write': 'Memory writes',
        'row.skills': 'Skill library',
        'row.viking': 'OpenViking',
        'row.mcp': 'MCP servers',
        'row.hermes-data': 'Hermes data',
        'row.persona.desc': 'SOUL.md as a system prompt section, present on every request.',
        'row.memory.desc': 'MEMORY.md + USER.md injected on every request, each entry tagged with its origin; edits land on the next assembly.',
        'row.memory-write.desc': 'A `memory` tool (list/add/patch/remove). Entries it writes carry a [dsh] prefix so they read apart from Hermes\' own.',
        'row.skills.desc': 'Registers the category-nested Hermes skill tree as a real DSH skill provider.',
        'row.viking.desc': 'Four tools over the OpenViking knowledge base, retrieved on demand.',
        'row.mcp.desc': 'Hermes MCP servers, one independent row each.',
        'row.hermes-data.desc': 'Read-only: Hermes cron job list plus full-text search over its session history.',
        'row.on': 'Enabled',
        'row.off': 'Disabled',
        'row.default': 'default',
        'row.override': 'override',

        origins: 'Memory origins',
        originsHint: 'Two writers share the same files; this shows how many entries each one wrote.',
        originsCount: '{n} entries',
        'origin.hermes': 'Hermes',
        'origin.dsh': 'DSH',
        'origin.assumed': 'Hermes (inferred)',
        files: 'Files read',
        filesHint: 'The paths the bridge actually reads. Size and mtime come from disk, not from configuration.',
        missing: 'missing',
        dir: 'dir',
        modified: 'modified',
        hermes: 'Hermes-side settings',
        hermesHint: 'These decide how Hermes itself uses memory. OpenViking only participates when the provider names it and it is not parked in the disabled list.',
        memoryProvider: 'Memory provider',
        memoryEnabled: 'Memory injection',
        userProfile: 'User profile',
        pluginsDisabled: 'Disabled plugins',
        mcpServers: 'MCP servers',
        none: '(none)',
        builtinOnly: 'built-in (MEMORY.md / USER.md only)',
        viking: 'OpenViking',
        vikingReachable: 'reachable',
        vikingUnreachable: 'unreachable',
        vikingHint: 'A retrieval-on-demand knowledge base: the model must search to see anything, so it costs nothing while idle.',
        vikingEndpoint: 'Endpoint',
        vikingVersion: 'Version',
        vikingAuth: 'Auth mode',
        vikingDisabledWarn: '⚠ OpenViking sits in Hermes\' plugins.disabled, so setting the provider does nothing.',
        skills: 'Skill library',
        skillsHint: 'Switches apply immediately: the next turn sees the new list, no restart.',
        skillsTotal: '{n} total',
        skillsOn: '{n} on',
        skillsOff: '{n} off',
        searchSkills: 'Search name or description…',
        allOn: 'Enable all',
        allOff: 'Disable all',
        noSkills: 'No matching skills',
        category: 'Category',
        allCategories: 'All categories',
        enabling: 'Applying…',
        preview: 'Prompt preview',
        previewHint: 'This is the actual text the rows inject into the system prompt (persona and memory). Skills are not resident — the skill tool loads them on demand.',
        previewPersona: 'Persona section',
        previewMemory: 'Memory section',
        chars: '{n} chars',
        empty: '(empty)',
        expand: 'Show all',
        collapse: 'Collapse',
        diagnostics: 'Diagnostics',
        diagnosticsHint: 'When something is wrong, look here first: paths, patch layer, state file.',
        patchPath: 'Patch layer',
        statePath: 'Skill state file',
        hermesHome: 'Hermes home',
        dshHome: 'DSH home',
        profile: 'Profile',
        copy: 'Copy',
        copied: 'Copied',
        generatedAt: 'Read at',

        tabConnection: 'Connection',
        setupTitle: 'Hermes not found',
        setupBody: 'No usable Hermes home under {path}. Install Hermes Agent first, or type the correct path below and save.',
        setupSaved: 'Saved. Row config hot-reloads; no restart needed.',
        configTitle: 'Connection settings',
        configHint: 'Written to this profile\'s overlay (cordis.patch.yml); rows hot-reload the config.',
        fieldHermesHome: 'Hermes home',
        fieldHermesHomeHint: 'empty = auto-resolve ($HERMES_HOME → platform default)',
        fieldVikingEndpoint: 'OpenViking endpoint',
        fieldAccount: 'OpenViking account',
        fieldUser: 'OpenViking user',
        fieldAgent: 'Agent name',
        probe: 'Test path',
        probing: 'Probing…',
        probeOk: 'looks like Hermes',
        probeMiss: 'not here',
        save: 'Save',
        saving: 'Saving…',
        revert: 'Reset to default',
        mcpTitle: 'MCP servers',
        mcpHermesSide: 'Hermes declares {n} servers',
        mcpMounted: '{n} rows mounted',
        mcpNeedsSync: 'Hermes has MCP servers not yet mounted — one click generates the rows.',
        mcpSync: 'Sync now',
        mcpSyncing: 'Syncing…',
        mcpSynced: '{n} MCP rows written; effective after a DSH restart.',
        mcpClear: 'Remove managed block',
        mcpCleared: 'Managed block removed; effective after a DSH restart.',
        mcpNoServers: '(no MCP servers in the Hermes config)',
        vikingIdentity: 'OpenViking identity',
        vikingIdentityHint: 'user is the OpenViking tenant name; keep it equal to memory.openviking.user in Hermes\' config.yaml so both sides query the same memories.',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = `
.hb_root{--ease:cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;gap:16px;max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.hb_root *{box-sizing:border-box}
.hb_root ::-webkit-scrollbar{width:10px;height:10px}
.hb_root ::-webkit-scrollbar-track{background:transparent}
.hb_root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 30%,transparent);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
.hb_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px}

.hb_hero{position:relative;display:flex;flex-direction:column;gap:12px;padding:22px 24px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.hb_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%)}
.hb_hero>*{position:relative}
.hb_pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.hb_pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.hb_pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.hb_pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:72ch}
.hb_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;align-items:center}
.hb_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.hb_pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.hb_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes hb-breathe{0%,100%{opacity:1}50%{opacity:.5}}
.hb_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:hb-breathe 2.6s ease-in-out infinite}
.hb_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.hb_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}

.hb_tabs{display:flex;gap:2px;padding:3px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);align-self:flex-start;flex-wrap:wrap}
.hb_tab{font:inherit;font-size:12px;font-weight:560;padding:6px 15px;border-radius:9px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .18s var(--ease),color .18s var(--ease)}
.hb_tab:hover{color:var(--dsw-alias-label-primary)}
.hb_tab.active{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgb(0 0 0 / 8%),inset 0 1px 0 rgb(255 255 255 / 6%)}

.hb_sec{display:flex;flex-direction:column;gap:10px}
.hb_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hb_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.hb_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto;max-width:60ch;text-align:right}

.hb_panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);display:flex;flex-direction:column;gap:12px}
.hb_paneltitle{font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}

.hb_rows{display:flex;flex-direction:column;gap:0}
.hb_row{display:flex;align-items:center;gap:14px;padding:13px 4px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent)}
.hb_row:last-child{border-bottom:none}
.hb_rowmain{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.hb_rowname{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:640}
.hb_rowdesc{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.hb_rowid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);opacity:.8}
.hb_rowstate{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-weight:500}

.hb_origin{padding:12px 4px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent)}
.hb_origin:last-child{border-bottom:none}
.hb_originhead{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.hb_originname{font-size:12.5px;font-weight:640;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hb_originmeta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.hb_bar{display:flex;height:7px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent)}
.hb_barfill{display:block;height:100%;transition:width .25s ease}
.hb_barfill.hermes{background:var(--dsw-alias-state-business-primary)}
.hb_barfill.dsh{background:var(--dsw-alias-state-success-primary)}
.hb_barfill.assumed{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent)}
.hb_barfill.empty{width:100%;background:transparent}
.hb_legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px}
.hb_legenditem{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.hb_dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.hb_dot.hermes{background:var(--dsw-alias-state-business-primary)}
.hb_dot.dsh{background:var(--dsw-alias-state-success-primary)}
.hb_dot.assumed{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent)}

.hb_switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;flex:none}
.hb_switch input{position:absolute;opacity:0;width:0;height:0}
.hb_switch i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);position:relative;transition:background .2s ease,border-color .2s ease;flex:none;display:block}
.hb_switch i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease}
.hb_switch[aria-checked="true"] i{background:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000)}
.hb_switch[aria-checked="true"] i::after{transform:translateX(16px);background:#fff}
.hb_switch[aria-disabled="true"]{opacity:.45;cursor:not-allowed}
.hb_switch.sm i{width:30px;height:17px}
.hb_switch.sm i::after{width:11px;height:11px}
.hb_switch.sm[aria-checked="true"] i::after{transform:translateX(13px)}

.hb_kv{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;font-size:11.5px;align-items:baseline}
.hb_kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.hb_kv dd{margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;word-break:break-all}
.hb_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}

.hb_file{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 52%,transparent);font-size:11.5px}
.hb_file+.hb_file{margin-top:6px}
.hb_file.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 26%,var(--dsw-alias-border-l1))}
.hb_file.miss{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l1));opacity:.8}
.hb_filelabel{font-weight:600;flex:none;min-width:96px}
.hb_filepath{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.hb_filemeta{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;font-size:10.5px}

.hb_callout{padding:11px 13px;border-radius:11px;font-size:11.5px;line-height:1.55;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent)}
.hb_callout.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 8%,transparent);color:var(--dsw-alias-label-primary)}
.hb_callout.error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}

.hb_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .18s var(--ease),border-color .2s var(--ease),background .2s var(--ease)}
.hb_btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));transform:translateY(-1px)}
.hb_btn:active:not(:disabled){transform:scale(.985)}
.hb_btn:disabled{opacity:.45;cursor:default;transform:none}
.hb_btn.ghost{background:transparent;border-color:var(--dsw-alias-border-l1);box-shadow:none;color:var(--dsw-alias-label-secondary)}
.hb_btn.ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.hb_btn.sm{padding:3px 10px;font-size:11px;border-radius:7px}

.hb_input{font:inherit;font-size:12px;padding:6px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);color:var(--dsw-alias-label-primary);min-width:0}
.hb_input::placeholder{color:var(--dsw-alias-label-tertiary)}
.hb_input:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));outline:none}
.hb_select{font:inherit;font-size:11.5px;padding:5px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);color:var(--dsw-alias-label-primary)}
.hb_toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hb_toolbar .hb_input{flex:1;min-width:180px}

.hb_skilllist{display:flex;flex-direction:column;gap:0;max-height:min(58vh,620px);overflow-y:auto;padding-right:4px}
.hb_skill{display:flex;align-items:flex-start;gap:11px;padding:9px 6px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent)}
.hb_skill:last-child{border-bottom:none}
.hb_skill.off{opacity:.55}
.hb_skillmain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.hb_skillname{font-size:12.5px;font-weight:620;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.hb_skillcat{font-size:9.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-weight:500;white-space:nowrap}
.hb_skilldesc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hb_skill.on .hb_skillname{color:var(--dsw-alias-label-primary)}
.hb_skill.off .hb_skillname{color:var(--dsw-alias-label-secondary)}

.hb_preview{border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);overflow:hidden}
.hb_previewhead{display:flex;align-items:center;gap:9px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:600}
.hb_previewhead .hb_btn{margin-left:auto}
.hb_previewbody{margin:0;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);max-height:340px;overflow:auto}
.hb_empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.hb_loading{padding:34px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}

.hb_field{display:flex;flex-direction:column;gap:6px}
.hb_fieldlabel{font-size:12px;font-weight:640;color:var(--dsw-alias-label-secondary)}
.hb_fieldhint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.hb_fieldrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hb_fieldrow .hb_input{flex:1;min-width:220px}
.hb_fieldrow.tight .hb_input{min-width:110px}
.hb_callout p{margin:0}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    const API = (() => {
      try { return new URL('api/hermes-bridge', document.baseURI).pathname } catch { return '/api/hermes-bridge' }
    })()

    /**
     * One fetch against the bridge API.
     *
     * Every call carries a timeout: a settings page that hangs on a wedged route
     * is worse than one that says it failed. The status route probes OpenViking,
     * which can take a couple of seconds, so its budget is wider than a write.
     */
    async function api(route, options) {
      const { timeout = 12000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout)
      try {
        const response = await fetch(`${API}${route}`, {
          ...rest,
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
        })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { throw new Error(`bad response (HTTP ${response.status}): ${text.slice(0, 200)}`) }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (route, body) => api(route, { method: 'POST', body: JSON.stringify(body) })

    function localeTag(ctx) {
      try { return typeof ctx?.locale?.current === 'string' ? ctx.locale.current : document.documentElement.lang || 'zh' } catch { return 'zh' }
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Relative age, because "3 minutes ago" answers "did my edit land" faster than a timestamp. */
    function formatAgo(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
      return `${Math.round(seconds / 86400)}d`
    }

    // ── primitives ────────────────────────────────────────────────────────────
    function Switch({ checked, onChange, disabled, small, label }) {
      return h('label', {
        className: `hb_switch${small ? ' sm' : ''}`,
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-disabled': disabled ? 'true' : 'false',
        'aria-label': label,
        onClick: event => { event.preventDefault(); if (!disabled) onChange(!checked) },
      }, h('i', null))
    }

    function Pill({ tone, children, strong }) {
      return h('span', { className: `hb_pill${strong ? ' strong' : ''}` },
        tone === undefined ? null : h('span', { className: `hb_dot ${tone}` }),
        children)
    }

    function Section({ title, hint, children, action }) {
      return h('div', { className: 'hb_sec' },
        h('div', { className: 'hb_sechead' },
          h('span', { className: 'hb_sec_title' }, title),
          action ?? null,
          hint === undefined ? null : h('span', { className: 'hb_sec_hint' }, hint)),
        children)
    }

    function Panel({ title, hint, children }) {
      return h('div', { className: 'hb_panel' },
        title === undefined ? null : h('div', { className: 'hb_paneltitle' }, title, hint === undefined ? null : h('span', { className: 'hb_sec_hint' }, hint)),
        children)
    }

    // ── data hook ─────────────────────────────────────────────────────────────
    /**
     * Status loader with an explicit state machine, so the page can tell
     * "still loading" from "loaded but empty" from "failed".
     */
    function useStatus() {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const load = useCallback(async (quiet) => {
        if (!quiet) setState(current => ({ ...current, status: current.data === undefined ? 'loading' : 'refreshing' }))
        try {
          const data = await api('/status')
          if (alive.current) setState({ status: 'ready', data, error: '' })
        } catch (error) {
          if (alive.current) setState(current => ({ status: current.data === undefined ? 'error' : 'ready', data: current.data, error: error?.message ?? String(error) }))
        }
      }, [])
      useEffect(() => { void load(false) }, [load])
      return { ...state, reload: load }
    }

    // ── rows page ─────────────────────────────────────────────────────────────
    const ROW_ORDER = [
      { id: 'hermes-bridge-persona', key: 'persona' },
      { id: 'hermes-bridge-memory', key: 'memory' },
      { id: 'hermes-bridge-memory-write', key: 'memory-write' },
      { id: 'hermes-bridge-skills', key: 'skills' },
      { id: 'hermes-bridge-viking', key: 'viking' },
      { id: 'hermes-bridge-mcp', key: 'mcp' },
      { id: 'hermes-bridge-hermes-data', key: 'hermes-data' },
    ]

    function RowsPage({ t, data, onToggle, busyId }) {
      return h(Section, { title: t('nav'), hint: t('subtitle') },
        h(Panel, null,
          h('div', { className: 'hb_rows' },
            ROW_ORDER.map(({ id, key }) => {
              const row = data.rows.find(entry => entry.id === id) ?? { id, enabled: true, overridden: false }
              return h('div', { className: 'hb_row', key: id },
                h('div', { className: 'hb_rowmain' },
                  h('div', { className: 'hb_rowname' },
                    t(`row.${key}`),
                    h('span', { className: 'hb_rowstate' }, row.overridden ? t('row.override') : t('row.default')),
                    h('span', { className: 'hb_rowid' }, id)),
                  h('div', { className: 'hb_rowdesc' }, t(`row.${key}.desc`))),
                h(Switch, {
                  checked: row.enabled,
                  disabled: busyId === id,
                  label: t(`row.${key}`),
                  onChange: next => onToggle(id, next),
                }))
            }))))
    }

    // ── memory origins ────────────────────────────────────────────────────────
    // Two agents write the same files now, so "who wrote this" has to be visible
    // somewhere. The bar shows the split per file; `assumed` are the untagged
    // entries that predate tagging (Hermes' own, by inference — marked with a `?`
    // everywhere they appear so an assumption never reads as a recorded fact).
    function OriginsPage({ t, data }) {
      const origins = data.memoryOrigins ?? {}
      const rows = [
        { key: 'memory', label: 'MEMORY.md', stats: origins.memory },
        { key: 'user', label: 'USER.md', stats: origins.user },
      ].filter(row => row.stats !== undefined)
      if (rows.length === 0) return null

      return h(Section, { title: t('origins'), hint: t('originsHint') },
        h(Panel, null,
          rows.map(({ key, label, stats }) => {
            const total = Math.max(1, stats.total ?? 0)
            const segments = [
              { key: 'hermes', count: stats.hermes ?? 0, cls: 'hermes' },
              { key: 'dsh', count: stats.dsh ?? 0, cls: 'dsh' },
              { key: 'assumed', count: stats.assumed ?? 0, cls: 'assumed' },
            ].filter(segment => segment.count > 0)
            return h('div', { className: 'hb_origin', key },
              h('div', { className: 'hb_originhead' },
                h('span', { className: 'hb_originname' }, label),
                h('span', { className: 'hb_originmeta' },
                  t('originsCount').replace('{n}', String(stats.total ?? 0)),
                  ` · ${stats.chars ?? 0}/${stats.limit ?? 0}`)),
              h('div', { className: 'hb_bar' },
                segments.length === 0
                  ? h('span', { className: 'hb_barfill empty' })
                  : segments.map(segment => h('span', {
                    key: segment.key,
                    className: `hb_barfill ${segment.cls}`,
                    style: { width: `${(segment.count / total) * 100}%` },
                    title: `${t(`origin.${segment.key}`)}: ${segment.count}`,
                  }))),
              h('div', { className: 'hb_legend' },
                segments.length === 0
                  ? h('span', { className: 'hb_legenditem' }, t('none'))
                  : segments.map(segment => h('span', { className: 'hb_legenditem', key: segment.key },
                    h('i', { className: `hb_dot ${segment.cls}` }),
                    `${t(`origin.${segment.key}`)} ${segment.count}`))))
          })))
    }

    // ── files + hermes settings ───────────────────────────────────────────────
    function FilesPage({ t, data }) {
      return h(Section, { title: t('files'), hint: t('filesHint') },
        h(Panel, null,
          data.files.map(file => h('div', { className: `hb_file ${file.exists ? 'ok' : 'miss'}`, key: file.path },
            h('span', { className: 'hb_filelabel' }, file.label),
            h('span', { className: 'hb_filepath', title: file.path }, file.path),
            h('span', { className: 'hb_filemeta' },
              file.exists
                ? `${file.directory ? t('dir') : formatBytes(file.bytes)}${file.mtime > 0 ? ` · ${formatAgo(file.mtime)}` : ''}`
                : t('missing'))))))
    }

    function HermesPage({ t, data }) {
      const config = data.hermes ?? {}
      const provider = typeof config.memoryProvider === 'string' ? config.memoryProvider : ''
      const disabled = Array.isArray(config.pluginsDisabled) ? config.pluginsDisabled : []
      const vikingBlocked = provider === 'openviking' && disabled.includes('openviking')
      const viking = data.viking ?? {}
      return h(Section, { title: t('hermes'), hint: t('hermesHint') },
        vikingBlocked ? h('div', { className: 'hb_callout warn' }, t('vikingDisabledWarn')) : null,
        config.error === undefined ? null : h('div', { className: 'hb_callout error' }, config.error),
        h(Panel, null,
          h('dl', { className: 'hb_kv' },
            h('dt', null, t('memoryProvider')),
            h('dd', null, provider === '' ? t('builtinOnly') : h('span', { className: 'hb_mono' }, provider)),
            h('dt', null, t('memoryEnabled')),
            h('dd', null, config.memoryEnabled === false ? t('row.off') : t('row.on')),
            h('dt', null, t('userProfile')),
            h('dd', null, config.userProfileEnabled === false ? t('row.off') : t('row.on')),
            h('dt', null, t('pluginsDisabled')),
            h('dd', null, disabled.length === 0 ? t('none') : disabled.join(', ')),
            h('dt', null, t('mcpServers')),
            h('dd', null, Array.isArray(config.mcpServers) && config.mcpServers.length > 0 ? config.mcpServers.join(', ') : t('none')))),
        h(Section, { title: t('viking'), hint: t('vikingHint') },
          h(Panel, null,
            h('dl', { className: 'hb_kv' },
              h('dt', null, ''),
              h('dd', null, h(Pill, { tone: viking.reachable ? 'ok' : 'err', strong: true }, viking.reachable ? t('vikingReachable') : t('vikingUnreachable'))),
              h('dt', null, t('vikingEndpoint')),
              h('dd', { className: 'hb_mono' }, viking.endpoint ?? ''),
              h('dt', null, t('vikingVersion')),
              h('dd', null, viking.version === '' || viking.version === undefined ? t('none') : viking.version),
              h('dt', null, t('vikingAuth')),
              h('dd', null, viking.authMode === '' || viking.authMode === undefined ? t('none') : viking.authMode),
              viking.error === undefined ? null : h('dt', null, 'error'),
              viking.error === undefined ? null : h('dd', { className: 'hb_mono' }, viking.error)))))
    }

    // ── skills page ───────────────────────────────────────────────────────────
    function SkillsPage({ t, data, onSkillToggle, onBulk, pending }) {
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const disabled = useMemo(() => new Set(data.skills?.disabled ?? []), [data.skills])
      const inventory = data.skillInventory ?? []
      const categories = useMemo(() => [...new Set(inventory.map(entry => entry.category).filter(Boolean))].sort(), [inventory])
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return inventory.filter(entry => {
          if (category !== '' && entry.category !== category) return false
          if (needle === '') return true
          return entry.name.toLowerCase().includes(needle) || String(entry.description ?? '').toLowerCase().includes(needle)
        })
      }, [inventory, query, category])
      const onCount = inventory.filter(entry => !disabled.has(entry.name)).length
      const offCount = inventory.length - onCount

      return h(Section, {
        title: t('skills'),
        hint: t('skillsHint'),
        action: h('div', { className: 'hb_toolbar' },
          h(Pill, null, t('skillsTotal').replace('{n}', String(inventory.length))),
          h(Pill, { tone: 'ok' }, t('skillsOn').replace('{n}', String(onCount))),
          offCount > 0 ? h(Pill, { tone: 'warn' }, t('skillsOff').replace('{n}', String(offCount))) : null),
      },
        h(Panel, null,
          h('div', { className: 'hb_toolbar' },
            h('input', {
              className: 'hb_input',
              placeholder: t('searchSkills'),
              value: query,
              onChange: event => setQuery(event.target.value),
            }),
            categories.length > 0 ? h('select', {
              className: 'hb_select',
              value: category,
              onChange: event => setCategory(event.target.value),
            },
              h('option', { value: '' }, t('allCategories')),
              categories.map(name => h('option', { value: name, key: name }, name))) : null,
            h('button', {
              className: 'hb_btn sm',
              disabled: pending,
              onClick: () => onBulk(filtered.map(entry => entry.name), true),
            }, t('allOn')),
            h('button', {
              className: 'hb_btn sm ghost',
              disabled: pending,
              onClick: () => onBulk(filtered.map(entry => entry.name), false),
            }, t('allOff'))),
          filtered.length === 0
            ? h('div', { className: 'hb_empty' }, t('noSkills'))
            : h('div', { className: 'hb_skilllist' },
              filtered.map(entry => {
                const on = !disabled.has(entry.name)
                return h('div', { className: `hb_skill ${on ? 'on' : 'off'}`, key: entry.name },
                  h('div', { className: 'hb_skillmain' },
                    h('div', { className: 'hb_skillname' },
                      entry.name,
                      entry.category === undefined || entry.category === '' ? null : h('span', { className: 'hb_skillcat' }, entry.category)),
                    h('div', { className: 'hb_skilldesc', title: entry.description }, entry.description)),
                  h(Switch, {
                    small: true,
                    checked: on,
                    disabled: pending,
                    label: entry.name,
                    onChange: next => onSkillToggle(entry.name, next),
                  }))
              }))))
    }

    // ── preview page ──────────────────────────────────────────────────────────
    function PreviewPage({ t, data }) {
      const [expanded, setExpanded] = useState({})
      const blocks = [
        { key: 'persona', label: t('previewPersona'), text: data.preview?.persona ?? '' },
        { key: 'memory', label: t('previewMemory'), text: data.preview?.memory ?? '' },
      ]
      return h(Section, { title: t('preview'), hint: t('previewHint') },
        blocks.map(block => h('div', { className: 'hb_preview', key: block.key },
          h('div', { className: 'hb_previewhead' },
            block.label,
            h('span', { className: 'hb_pill' }, t('chars').replace('{n}', String(block.text.length))),
            h('button', {
              className: 'hb_btn sm ghost',
              onClick: () => setExpanded(current => ({ ...current, [block.key]: !current[block.key] })),
            }, expanded[block.key] ? t('collapse') : t('expand'))),
          h('pre', {
            className: 'hb_previewbody',
            style: expanded[block.key] ? { maxHeight: 'none' } : undefined,
          }, block.text === '' ? t('empty') : block.text))))
    }

    // ── connection page (first-run guidance + writable config) ────────────────
    /**
     * The writable face of the settings page. A first-time user lands here from
     * the setup callout: probe a path, save it, sync MCP rows — all without a
     * terminal. Values prefill from `status.config` (package defaults overlaid
     * by the profile patch, the same layering the loader applies).
     */
    function ConnectionPage({ t, data, onSaved }) {
      const rows = data.config ?? {}
      const viking = rows['hermes-bridge-viking'] ?? {}
      const setup = data.setup ?? {}

      const [home, setHome] = useState(rows['hermes-bridge-persona']?.hermesHome ?? '')
      const [endpoint, setEndpoint] = useState(viking.endpoint ?? '')
      const [account, setAccount] = useState(viking.account ?? '')
      const [user, setUser] = useState(viking.user ?? '')
      const [agent, setAgent] = useState(viking.agent ?? '')
      const [probe, setProbe] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')

      const run = useCallback(async (key, value, after) => {
        setBusy(key)
        setNotice('')
        try {
          const payload = await post('/config', { key, value })
          if (after) after(payload)
          await onSaved()
        } catch (failure) {
          setNotice(failure?.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }, [onSaved])

      const doProbe = useCallback(async () => {
        setBusy('probe')
        setProbe(undefined)
        try {
          setProbe(await api(`/probe-hermes?path=${encodeURIComponent(home)}`))
        } catch (failure) {
          setNotice(failure?.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }, [home])

      const mcp = data.mcp ?? {}

      return h('div', { className: 'hb_sec', style: { gap: '18px' } },
        setup.hermesFound ? null : h('div', { className: 'hb_callout error' },
          h('b', null, t('setupTitle')), ' — ', t('setupBody').replace('{path}', data.hermesHome ?? '')),

        h(Section, { title: t('configTitle'), hint: t('configHint') },
          h(Panel, null,
            h(Field, { t, label: t('fieldHermesHome'), hint: t('fieldHermesHomeHint'), value: home, onChange: setHome, busy, keyName: 'hermesHome',
              onSave: () => run('hermesHome', home), onProbe: doProbe, probe })),
          h(Panel, null,
            h('div', { className: 'hb_field' },
              h('label', { className: 'hb_fieldlabel' }, t('fieldVikingEndpoint')),
              h('div', { className: 'hb_fieldrow' },
                h('input', { className: 'hb_input', placeholder: 'http://127.0.0.1:1933', value: endpoint, onChange: event => setEndpoint(event.target.value) }),
                h('button', { className: 'hb_btn', disabled: busy !== '', onClick: () => run('vikingEndpoint', endpoint) }, busy === 'vikingEndpoint' ? t('saving') : t('save')))),
            h('div', { className: 'hb_field' },
              h('label', { className: 'hb_fieldlabel' }, t('vikingIdentity')),
              h('div', { className: 'hb_fieldhint' }, t('vikingIdentityHint')),
              h('div', { className: 'hb_fieldrow hb_fieldrow.tight' },
                h('input', { className: 'hb_input', placeholder: 'account', value: account, onChange: event => setAccount(event.target.value) }),
                h('input', { className: 'hb_input', placeholder: 'user', value: user, onChange: event => setUser(event.target.value) }),
                h('input', { className: 'hb_input', placeholder: 'agent', value: agent, onChange: event => setAgent(event.target.value) }),
                h('button', { className: 'hb_btn', disabled: busy !== '', onClick: async () => {
                  setBusy('identity')
                  try {
                    await post('/config', { key: 'account', value: account })
                    await post('/config', { key: 'user', value: user })
                    await post('/config', { key: 'agent', value: agent })
                    await onSaved()
                  } catch (failure) {
                    setNotice(failure?.message ?? String(failure))
                  } finally { setBusy('') }
                } }, busy === 'identity' ? t('saving') : t('save')))))),

        h(Section, { title: t('mcpTitle') },
          h(Panel, null,
            h('div', { className: 'hb_toolbar' },
              h(Pill, null, t('mcpHermesSide').replace('{n}', String(mcp.hermesServers?.length ?? 0))),
              h(Pill, { tone: (mcp.mounted ?? 0) > 0 ? 'ok' : 'warn' }, t('mcpMounted').replace('{n}', String(mcp.mounted ?? 0)))),
            mcp.needsSync ? h('div', { className: 'hb_callout warn' }, t('mcpNeedsSync')) : null,
            (mcp.hermesServers?.length ?? 0) === 0 ? h('div', { className: 'hb_empty' }, mcp.error !== '' ? mcp.error : t('mcpNoServers')) : null,
            h('div', { className: 'hb_toolbar' },
              h('button', { className: 'hb_btn', disabled: busy !== '', onClick: async () => {
                setBusy('mcp')
                try {
                  const payload = await post('/mcp/sync', {})
                  setNotice(t('mcpSynced').replace('{n}', String(payload.rows?.length ?? 0)))
                  await onSaved()
                } catch (failure) {
                  setNotice(failure?.message ?? String(failure))
                } finally { setBusy('') }
              } }, busy === 'mcp' ? t('mcpSyncing') : t('mcpSync')),
              (mcp.mounted ?? 0) > 0 ? h('button', { className: 'hb_btn ghost', disabled: busy !== '', onClick: async () => {
                setBusy('mcp')
                try {
                  await post('/mcp/clear', {})
                  setNotice(t('mcpCleared'))
                  await onSaved()
                } catch (failure) {
                  setNotice(failure?.message ?? String(failure))
                } finally { setBusy('') }
              } }, t('mcpClear')) : null))),
        notice === '' ? null : h('div', { className: 'hb_callout warn' }, notice))
    }

    /** One labeled text field with save/probe buttons. */
    function Field({ t, label, hint, value, onChange, busy, keyName, onSave, onProbe, probe }) {
      return h('div', { className: 'hb_field' },
        h('label', { className: 'hb_fieldlabel' }, label),
        hint === undefined ? null : h('div', { className: 'hb_fieldhint' }, hint),
        h('div', { className: 'hb_fieldrow' },
          h('input', { className: 'hb_input', placeholder: '', value, onChange: event => onChange(event.target.value) }),
          onProbe === undefined ? null : h('button', { className: 'hb_btn ghost', disabled: busy !== '', onClick: onProbe },
            busy === 'probe' ? t('probing') : t('probe')),
          h('button', { className: 'hb_btn', disabled: busy !== '', onClick: onSave },
            busy === keyName ? t('saving') : t('save'))),
        probe === undefined ? null : h('div', { className: `hb_callout ${probe.looksLikeHermes ? '' : 'warn'}`, style: { marginTop: '8px' } },
          `${probe.path} — ${probe.checks.map(check => `${check.name}${check.exists ? '✓' : '✗'}`).join('  ')}`))
    }

    // ── diagnostics page ──────────────────────────────────────────────────────
    function DiagnosticsPage({ t, data }) {
      const [copied, setCopied] = useState('')
      const copy = useCallback(async (label, value) => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(label)
          setTimeout(() => setCopied(current => (current === label ? '' : current)), 1600)
        } catch { /* clipboard unavailable */ }
      }, [])
      const rows = [
        [t('profile'), data.profile],
        [t('hermesHome'), data.hermesHome],
        [t('dshHome'), data.dshHome],
        [t('patchPath'), data.patchPath ?? (data.files.find(file => file.label === 'cordis.patch.yml')?.path ?? '')],
        [t('statePath'), data.skills?.stateFile ?? ''],
        [t('generatedAt'), formatTime(data.generatedAt)],
      ]
      return h(Section, { title: t('diagnostics'), hint: t('diagnosticsHint') },
        h(Panel, null,
          h('dl', { className: 'hb_kv' },
            rows.map(([label, value]) => [
              h('dt', { key: `k-${label}` }, label),
              h('dd', { key: `v-${label}` },
                h('span', { className: 'hb_mono' }, String(value ?? '—')),
                ' ',
                h('button', {
                  className: 'hb_btn sm ghost',
                  onClick: () => copy(label, String(value ?? '')),
                }, copied === label ? t('copied') : t('copy'))),
            ]).flat())))
    }

    // ── page ──────────────────────────────────────────────────────────────────
    const TAB_KEY = 'hb.tab'

    function SettingsPage(props) {
      const tagged = props.locale === undefined ? props.t : Object.assign(value => props.t(value), { locale: props.locale })
      const t = tagged
      const { status, data, error, reload } = useStatus()
      const [tab, setTab] = useState(() => {
        try {
          const saved = window.localStorage?.getItem(TAB_KEY)
          return ['overview', 'connection', 'skills', 'preview', 'diagnostics'].includes(saved) ? saved : 'overview'
        } catch { return 'overview' }
      })
      const [busyId, setBusyId] = useState('')
      const [skillPending, setSkillPending] = useState(false)
      const [inventory, setInventory] = useState(undefined)
      const [notice, setNotice] = useState('')

      const rememberTab = useCallback(next => {
        setTab(next)
        try { window.localStorage?.setItem(TAB_KEY, next) } catch { /* storage unavailable */ }
      }, [])

      // The skill inventory is a separate, larger read than status, so it is
      // fetched once when the skills tab is first opened instead of on every
      // page load. `reloadSkills` re-runs it after a switch.
      const loadSkills = useCallback(async () => {
        try {
          const payload = await api('/skills?limit=400', { timeout: 20000 })
          setInventory(payload.skills ?? [])
        } catch {
          setInventory([])
        }
      }, [])

      useEffect(() => {
        if (tab === 'skills' && inventory === undefined) void loadSkills()
      }, [tab, inventory, loadSkills])

      const toggleRow = useCallback(async (id, enabled) => {
        setBusyId(id)
        try {
          await post('/toggles', { id, enabled })
          await reload(true)
        } catch (failure) {
          setNotice(failure?.message ?? String(failure))
        } finally {
          setBusyId('')
        }
      }, [reload])

      const toggleSkill = useCallback(async (name, enabled) => {
        setSkillPending(true)
        try {
          await post('/skills', { name, enabled })
          await Promise.all([reload(true), loadSkills()])
        } catch (failure) {
          setNotice(failure?.message ?? String(failure))
        } finally {
          setSkillPending(false)
        }
      }, [reload, loadSkills])

      const bulkSkills = useCallback(async (names, enabled) => {
        setSkillPending(true)
        try {
          await post('/skills/bulk', { names, enabled })
          await Promise.all([reload(true), loadSkills()])
        } catch (failure) {
          setNotice(failure?.message ?? String(failure))
        } finally {
          setSkillPending(false)
        }
      }, [reload, loadSkills])

      if (status === 'loading') return h('div', { className: 'hb_root' }, h('div', { className: 'hb_loading' }, t('loading')))
      if (status === 'error') {
        return h('div', { className: 'hb_root' },
          h('div', { className: 'hb_callout error' }, h('b', null, t('loadFailed')), h('div', null, error)),
          h('div', null, h('button', { className: 'hb_btn', onClick: () => reload(false) }, t('retry'))))
      }

      const enriched = { ...data, skillInventory: inventory }
      const tabs = [
        ['overview', t('tabOverview')],
        ['connection', t('tabConnection')],
        ['skills', t('tabSkills')],
        ['preview', t('tabPreview')],
        ['diagnostics', t('tabDiagnostics')],
      ]
      const viking = data.viking ?? {}
      const enabledCount = data.rows.filter(row => row.enabled).length

      // The host settings pane already prints the section label above us, so this
      // block is a compact status strip rather than a second page title: repeating
      // the name and subtitle directly under the host's own heading reads as a
      // rendering bug even when both are correct.
      return h('div', { className: 'hb_root' },
        h('div', { className: 'hb_hero' },
          h('div', { className: 'hb_pagehead' },
            h('div', { className: 'hb_pagetitle' },
              h('p', { className: 'hb_pagesub' }, t('subtitle'))),
            h('div', { className: 'hb_pills' },
              h(Pill, { tone: enabledCount > 0 ? 'ok' : 'warn', strong: true }, `${enabledCount}/${data.rows.length}`),
              h(Pill, { tone: data.setup?.hermesFound === false ? 'err' : 'ok' }, 'Hermes'),
              h(Pill, { tone: viking.reachable ? 'ok' : 'err' }, 'OpenViking'),
              h(Pill, null, data.profile),
              h('button', { className: 'hb_btn sm', onClick: () => reload(false) }, t('refresh'))))),
        data.setup?.hermesFound === false ? h('div', { className: 'hb_callout error' },
          h('b', null, t('setupTitle')), ' — ', t('setupBody').replace('{path}', data.hermesHome ?? ''), ' ',
          h('button', { className: 'hb_btn sm', style: { marginLeft: '6px' }, onClick: () => rememberTab('connection') }, t('tabConnection')), ' →') : null,
        notice === '' ? null : h('div', { className: 'hb_callout error' }, notice, h('button', {
          className: 'hb_btn sm ghost', style: { marginLeft: '10px' }, onClick: () => setNotice(''),
        }, '✕')),
        h('div', { className: 'hb_tabs' },
          tabs.map(([key, label]) => h('button', {
            className: `hb_tab${tab === key ? ' active' : ''}`,
            key,
            onClick: () => rememberTab(key),
          }, label))),
        tab === 'overview'
          ? h('div', { className: 'hb_sec', style: { gap: '18px' } },
            h(RowsPage, { t, data, onToggle: toggleRow, busyId }),
            h(OriginsPage, { t, data }),
            h(FilesPage, { t, data }),
            h(HermesPage, { t, data }))
          : null,
        tab === 'connection' ? h(ConnectionPage, { t, data, onSaved: () => reload(true) }) : null,
        tab === 'skills' ? h(SkillsPage, { t, data: enriched, onSkillToggle: toggleSkill, onBulk: bulkSkills, pending: skillPending }) : null,
        tab === 'preview' ? h(PreviewPage, { t, data }) : null,
        tab === 'diagnostics' ? h(DiagnosticsPage, { t, data }) : null)
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'hermes-bridge: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-hermes-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'hermes-bridge: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'hermes-bridge',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(ctx), ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-hermes-bridge'
    return module.exports
  },
})
