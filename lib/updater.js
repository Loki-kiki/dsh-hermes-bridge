/**
 * `hermes-bridge/updater` — 检查并安装本插件自己的新版本。
 *
 * 这个插件装在 DSH 的 profile 里，用的是 pnpm。要更新它，本质上就是「把
 * profile 里那一条依赖换成新的」，然后让 DSH 重新加载。麻烦有三处：
 *
 * 1. **不能走 `pluginManager.installBundle()`**。它对已安装的包直接抛
 *    `already-installed`（那是安装语义，不是更新语义）。所以更新走 pnpm
 *    自己的 `add <spec>` —— 和用户在插件页点「安装」时跑的是同一个包管理器。
 *
 * 2. **装完要重载，但重载不一定能做到**。DSH 有 `hmr` 服务，`reconcileProfile()`
 *    能替换模块；可它依赖 ESM 模块缓存，打包 worker 里没有这个缓存，那时
 *    只能报「需要重启」。**这种情况必须如实返回，不能假装已经热更新了。**
 *
 * 3. **检查更新不能把界面卡住**。GitHub API 在国内经常慢或不通，所以检查
 *    有超时、有缓存、失败只是「不知道」，不是「出错」。
 *
 * 版本来源：GitHub 的 `raw.githubusercontent.com` 上那份 `package.json`。
 * 不用 GitHub API 是因为它匿名调用有速率限制（60 次/小时/IP），而 6 小时一次的
 * 自动检查会一直撞它；raw 没有这个限制，且拿到的就是仓库里的真实文件。
 *
 * @module dsh-hermes-bridge/updater
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, optionalBoolean, optionalNumber, optionalString, rejectUnknownKeys, report } from './util.js'

export const name = 'hermes-bridge/updater'

/** 默认检查的仓库；用户可以在行配置里换成自己的 fork。 */
const DEFAULT_REPO = 'Loki-kiki/dsh-hermes-bridge'
/** 默认分支。 */
const DEFAULT_BRANCH = 'main'

/** 6 小时。写成常量而不是魔法数字，因为设置页要把它显示出来。 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 检查更新的最短间隔：防止配置写错成 0 之后每秒打一次 GitHub。 */
const MIN_INTERVAL_MS = 60 * 1000

/** 一次版本检查的网络预算。国内直连 raw 经常要几秒。 */
const CHECK_TIMEOUT_MS = 20_000

/**
 * 读这一行的配置。
 *
 * `intervalHours` 而不是毫秒：配置文件是给人读的，写 `6` 比写 `21600000` 更
 * 不容易错。转换只在这里发生一次。
 *
 * @param {Record<string, unknown>} raw - 行配置。
 * @returns {{repo: string, branch: string, intervalHours: number, autoCheck: boolean, autoInstall: boolean, timeoutMs: number}} 配置。
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  rejectUnknownKeys('updater', config, ['repo', 'branch', 'intervalHours', 'autoCheck', 'autoInstall', 'timeoutMs'])
  const repo = optionalString('updater', config, 'repo', DEFAULT_REPO)
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) {
    throw new ConfigError('updater', `repo must look like "owner/name", got ${JSON.stringify(repo)}`)
  }
  const branch = optionalString('updater', config, 'branch', DEFAULT_BRANCH)
  const intervalHours = optionalNumber('updater', config, 'intervalHours', DEFAULT_INTERVAL_MS / 3_600_000)
  if (!(intervalHours > 0)) throw new ConfigError('updater', `intervalHours must be positive, got ${intervalHours}`)
  return {
    repo,
    branch,
    intervalHours,
    // 自动检查默认开：它只读一个 JSON，不装任何东西。
    autoCheck: optionalBoolean('updater', config, 'autoCheck', true),
    // 自动安装默认关：装新代码等于换掉正在跑的模块，这该由人拍板。
    autoInstall: optionalBoolean('updater', config, 'autoInstall', false),
    timeoutMs: optionalNumber('updater', config, 'timeoutMs', CHECK_TIMEOUT_MS),
  }
}

/**
 * 比较两个 semver 版本，只关心「新版是否严格更大」。
 *
 * 不引 semver 包：这里只需要 `<major>.<minor>.<patch>` 加可选的预发布段，
 * 而多一个运行依赖就多一份装不上的可能。预发布版本按 semver 规则小于同号正式版。
 *
 * @param {string} candidate - 候选版本。
 * @param {string} current - 当前版本。
 * @returns {number} 负数表示候选更旧，0 表示相同，正数表示候选更新。
 */
function compareVersions(candidate, current) {
  const parse = (text) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(text).trim())
    if (match === null) return undefined
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? undefined : match[4].split('.'),
    }
  }
  const left = parse(candidate)
  const right = parse(current)
  if (left === undefined || right === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index]
  }
  // 同号时，有预发布段的一方更旧（1.0.0-rc.1 < 1.0.0）。
  if (left.pre === undefined && right.pre === undefined) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = /^\d+$/u.test(a)
    const bNumber = /^\d+$/u.test(b)
    if (aNumber && bNumber) {
      if (Number(a) !== Number(b)) return Number(a) - Number(b)
    } else if (aNumber !== bNumber) {
      // 数字标识符低于字母标识符（semver 11.4.3）。
      return aNumber ? -1 : 1
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

/**
 * 取仓库里那份 `package.json` 的版本。
 *
 * 失败一律返回 `{ok:false, error}` 而不是抛：检查更新失败不是错误状态，只是
 * 「现在不知道」，界面该照常工作。
 *
 * @param {object} config - resolveConfig 的结果。
 * @param {string} [etag] - 上次的 ETag，命中 304 时省一次传输。
 * @returns {Promise<{ok: boolean, version?: string, error?: string, notModified?: boolean, etag?: string}>} 结果。
 */
async function fetchRemoteVersion(config, etag) {
  const url = `https://raw.githubusercontent.com/${config.repo}/${config.branch}/package.json`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), config.timeoutMs)
  try {
    const headers = { 'user-agent': 'dsh-hermes-bridge-updater' }
    if (etag !== undefined && etag !== '') headers['if-none-match'] = etag
    const response = await fetch(url, { headers, signal: controller.signal })
    if (response.status === 304) return { ok: true, notModified: true, etag }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} from ${url}` }
    const text = await response.text()
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      return { ok: false, error: `${url} did not return JSON` }
    }
    if (typeof manifest.version !== 'string') return { ok: false, error: `${url} has no version field` }
    return { ok: true, version: manifest.version, etag: response.headers.get('etag') ?? '' }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timed out after ${config.timeoutMs} ms` : (error?.message ?? String(error))
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把一段子进程输出解成可读文本。
 *
 * 为什么要猜编码：Windows 上 cmd 与 pnpm 的输出编码取决于控制台代码页，中文
 * 系统默认是 GBK（936）。Node 只认 UTF-8，直接把 GBK 字节按 UTF-8 解会得到
 * 一串 U+FFFD，而这段文本的全部用途就是让用户看懂哪里错了。
 *
 * 判断方法不是「看起来像不像乱码」，而是**往返一致性**：UTF-8 是自校验编码，
 * 合法 UTF-8 解码再编码一定得到原字节；GBK 中文按 UTF-8 解则不会（会出现
 * U+FFFD 或不同字节）。所以先试 UTF-8，往返失败再按 GBK 解。
 *
 * @param {Buffer} buffer - 原始字节。
 * @returns {string} 解码后的文本。
 */
function decodeOutput(buffer) {
  if (buffer.length === 0) return ''
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  // 往返一致 = 本来就是 UTF-8（含纯 ASCII）。
  if (Buffer.from(utf8, 'utf8').equals(buffer)) return utf8
  try {
    // Node 默认带 full-icu，GBK 可用；精简构建里没有就退回 UTF-8 的结果，
    // 至少不会抛错让整次安装失败。
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/**
 * 跑一次 pnpm，把输出收集起来。
 *
 * 用 `spawn` 而不是 `exec`：pnpm 的输出可能很长（依赖树），`exec` 的默认缓冲
 * 会截断，而截断的日志恰好会丢掉真正的错误行。
 *
 * @param {string[]} args - pnpm 参数。
 * @param {{cwd: string, timeoutMs: number}} options - 运行参数。
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error?: string}>} 结果。
 */
function runPnpm(args, options) {
  return new Promise((resolve) => {
    // Windows 上 pnpm 是 .cmd，必须经 shell 才能找到；其他平台直接 spawn 更安全。
    // `shell:true` 会把参数拼进命令行，所以每个参数都要自己引号 —— 不引的话
    // 含空格的 spec 会被拆成两个参数，装错包。Node 对这一点有弃用告警，正是提醒。
    const shell = process.platform === 'win32'
    const quoted = args.map((arg) => (/[\s"]/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg))
    // Windows 控制台默认代码页是 936（GBK），而 Node 按 UTF-8 解码子进程输出 ——
    // 结果就是 pnpm 的每一句中文诊断都变成乱码，而诊断正是这个函数存在的理由。
    // `chcp 65001` 只影响这一个子进程，不改用户的系统设置。
    const command = shell ? 'pnpm.cmd' : 'pnpm'
    const child = spawn(command, quoted, {
      cwd: options.cwd,
      shell,
      windowsHide: true,
      env: { ...process.env, CI: '1' },
    })
    const stdoutChunks = []
    const stderrChunks = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, code: null, stdout: decodeOutput(Buffer.concat(stdoutChunks)), stderr: decodeOutput(Buffer.concat(stderrChunks)), error: `pnpm timed out after ${options.timeoutMs} ms` })
    }, options.timeoutMs)
    // 不收字符串，收 Buffer：Windows 上 cmd/pnpm 的诊断可能是 GBK（代码页 936）
    // 也可能是 UTF-8，只有拿到原始字节才能判断 —— 一旦 setEncoding 成 utf8，
    // GBK 的中文就永久变成乱码，而那句乱码正是要显示给用户的诊断。
    child.stdout?.on('data', (chunk) => { stdoutChunks.push(chunk) })
    child.stderr?.on('data', (chunk) => { stderrChunks.push(chunk) })
    child.on('error', (error) => finish({ ok: false, code: null, stdout: decodeOutput(Buffer.concat(stdoutChunks)), stderr: decodeOutput(Buffer.concat(stderrChunks)), error: error.message }))
    child.on('close', (code) => {
      const out = decodeOutput(Buffer.concat(stdoutChunks))
      const err = decodeOutput(Buffer.concat(stderrChunks))
      // 非 0 退出时把 stderr 的最后几行提成 error：否则调用方只能看到「失败」，
      // 而真正的信息（pnpm 不在 PATH / registry 不通 / peer 冲突）全在 stderr 里。
      // 最常见的第一种情况是 pnpm 根本没装 —— cmd 会说「不是内部或外部命令」，
      // 那句话本身就是最该显示给用户的诊断。
      const tail = err.trim().split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(10)).filter((line) => line !== '').slice(-3).join(' · ')
      finish({
        ok: code === 0,
        code,
        stdout: out,
        stderr: err,
        ...(code === 0 ? {} : { error: tail === '' ? `pnpm exited with code ${code}` : tail }),
      })
    })
  })
}

/**
 * 本插件自己装在哪个目录、当前是什么版本。
 *
 * 从 `import.meta.url` 往上找 `package.json`，而不是从配置里读：插件可能被
 * `link:` 到一个工作副本，也可能被 pnpm 装进虚拟 store，只有模块自己的位置
 * 能可靠说明「现在跑的是哪一份」。
 *
 * @returns {Promise<{dir: string, version: string, name: string}>} 自身信息。
 */
async function selfInfo() {
  // `fileURLToPath` 而不是手剥 pathname：Windows 上 URL 的 pathname 是
  // `/E:/AI/...`，还要处理百分号编码（路径里有空格时 `%20`），自己写必错。
  const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
  return { dir, version: String(manifest.version ?? '0.0.0'), name: String(manifest.name ?? 'dsh-hermes-bridge') }
}

/**
 * 装一个新版本。
 *
 * 三种来源，选哪一种由「现在这份是怎么装的」决定，不能一律用 registry：
 * 用户从 GitHub 装的、用 `link:` 指向工作副本的、从 npm 装的，更新方式不同。
 * 猜错会得到一个「装上了但没变」的目录。
 *
 * @param {object} config - 行配置。
 * @param {{dir: string, version: string, name: string}} self - 自身信息。
 * @param {string} version - 目标版本。
 * @param {string} profileDir - profile 目录（pnpm 的 cwd）。
 * @returns {Promise<{ok: boolean, spec: string, stdout: string, stderr: string, error?: string}>} 结果。
 */
async function installVersion(config, self, version, profileDir) {
  const manifest = await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8')
  const dependency = JSON.parse(manifest).dependencies?.[self.name]
  let spec
  if (typeof dependency === 'string' && dependency.startsWith('link:')) {
    // `link:` 指向一个工作副本 —— 那里是 git 仓库，用 git 拉，pnpm 不用管。
    return { ok: false, spec: dependency, stdout: '', stderr: '', error: 'installed from a local link; update that working copy with git instead' }
  }
  if (typeof dependency === 'string' && /github:|git\+|\.git/u.test(dependency)) {
    // 从 git 装的：重新按同一来源装，pnpm 会拉到最新提交。
    spec = dependency
  } else {
    spec = `${self.name}@${version}`
  }
  const result = await runPnpm(['add', spec], { cwd: profileDir, timeoutMs: 180_000 })
  return { ...result, spec }
}

/**
 * 让 DSH 重新加载这个 bundle。
 *
 * 优先用 HMR（真正的热更新）；拿不到就返回「需要重启」，**绝不假装成功**。
 * 调用方拿到 `applied:false` 时应当告诉用户去重启，而不是说「已更新」。
 *
 * @param {object} ctx - 插件上下文。
 * @returns {Promise<{applied: boolean, reason?: string, warnings?: string[]}>} 结果。
 */
async function reloadSelf(ctx) {
  const hmr = ctx.get?.('hmr')
  if (hmr === undefined || typeof hmr.runExclusive !== 'function') {
    return { applied: false, reason: 'HMR service is not available in this profile' }
  }
  try {
    const outcome = await hmr.runExclusive(async () => hmr.reconcileProfile())
    if (outcome?.restartReason !== undefined) {
      return { applied: false, reason: outcome.restartReason, warnings: outcome.warnings ?? [] }
    }
    return { applied: true, warnings: outcome?.warnings ?? [] }
  } catch (error) {
    return { applied: false, reason: error?.message ?? String(error) }
  }
}

/**
 * 更新器的状态机，活在这行的作用域里。
 *
 * 为什么要有状态而不是每次现算：设置页会频繁读状态（打开页面、切页签），
 * 而每次检查都要打一次网络。所以结果带缓存和 TTL，定时器只负责在到期时刷新。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 行配置。
 * @returns {object} 控制器。
 */
function createUpdater(ctx, config) {
  const state = {
    /** @type {'idle'|'checking'|'installing'} */
    phase: 'idle',
    checkedAt: 0,
    remoteVersion: '',
    error: '',
    /** @type {object|undefined} 最近一次安装的结果。 */
    lastInstall: undefined,
    etag: '',
  }
  let timer
  let checking

  const snapshot = async () => {
    const self = await selfInfo()
    const behind = state.remoteVersion !== '' && compareVersions(state.remoteVersion, self.version) > 0
    return {
      currentVersion: self.version,
      installDir: self.dir,
      remoteVersion: state.remoteVersion,
      updateAvailable: behind,
      checkedAt: state.checkedAt,
      error: state.error,
      phase: state.phase,
      repo: config.repo,
      branch: config.branch,
      intervalHours: config.intervalHours,
      autoCheck: config.autoCheck,
      autoInstall: config.autoInstall,
      lastInstall: state.lastInstall,
    }
  }

  /**
   * 检查一次远端版本。
   *
   * 并发安全：同一时刻只跑一个检查，后来的调用复用同一个 Promise。否则设置页
   * 每次重渲染都可能再打一次 GitHub。
   *
   * @param {boolean} [force] - 忽略缓存。
   * @returns {Promise<object>} 状态快照。
   */
  const check = async (force = false) => {
    const fresh = state.checkedAt !== 0 && Date.now() - state.checkedAt < MIN_INTERVAL_MS
    if (checking !== undefined) return checking
    if (fresh && !force) return snapshot()
    checking = (async () => {
      state.phase = 'checking'
      try {
        const remote = await fetchRemoteVersion(config, state.etag)
        state.checkedAt = Date.now()
        if (remote.ok && remote.notModified !== true) {
          state.remoteVersion = remote.version ?? ''
          state.etag = remote.etag ?? ''
          state.error = ''
        } else if (remote.ok) {
          state.error = ''
        } else {
          state.error = remote.error ?? 'check failed'
        }
      } finally {
        state.phase = 'idle'
        checking = undefined
      }
      return snapshot()
    })()
    return checking
  }

  /**
   * 装新版本，然后尝试热重载。
   *
   * 顺序不能反：先装再重载，重载才是「读新代码」。装失败时绝不重载 —— 那只会
   * 让正在跑的东西重启一遍，什么也没变。
   *
   * @param {string} [target] - 目标版本；省略则用最近一次检查到的版本。
   * @returns {Promise<object>} 含安装与重载两段结果的状态快照。
   */
  const install = async (target) => {
    if (state.phase === 'installing') throw new ConfigError('updater', 'an install is already running')
    const version = target ?? state.remoteVersion
    if (version === '') throw new ConfigError('updater', 'no target version; run a check first')
    const profileDir = ctx.get?.('profileContext')?.dir
    if (typeof profileDir !== 'string' || profileDir === '') {
      throw new ConfigError('updater', 'cannot locate this profile directory; install manually with `dsh plugin --profile <name> add <pkg>@<version>`')
    }
    state.phase = 'installing'
    try {
      const self = await selfInfo()
      const installed = await installVersion(config, self, version, profileDir)
      const reload = installed.ok ? await reloadSelf(ctx) : { applied: false, reason: 'install did not succeed' }
      state.lastInstall = {
        at: Date.now(),
        target: version,
        from: self.version,
        ok: installed.ok,
        spec: installed.spec,
        stdout: installed.stdout.slice(-4000),
        stderr: installed.stderr.slice(-4000),
        error: installed.error ?? '',
        reload,
      }
      if (installed.ok) {
        state.remoteVersion = version
        state.checkedAt = Date.now()
      }
      return snapshot()
    } finally {
      state.phase = 'idle'
    }
  }

  /**
   * 起定时器。
   *
   * 用 `unref()`：一个「定时检查更新」不应该让 DSH 进程关不掉。这是后台维护
   * 工作，不是用户正在等的东西。
   *
   * @returns {() => void} 停止函数。
   */
  const start = () => {
    if (!config.autoCheck) return () => {}
    const intervalMs = Math.max(MIN_INTERVAL_MS, config.intervalHours * 3_600_000)
    // 启动时不立刻打网络：DSH 刚起来时最忙，等一个间隔再说。第一次检查由
    // 设置页打开时触发，那里有用户在等，值得花那几百毫秒。
    timer = setInterval(() => {
      check().then((result) => {
        if (result.updateAvailable && config.autoInstall) {
          return install()
        }
        if (result.updateAvailable) {
          report(ctx, `updater: ${result.remoteVersion} is available (running ${result.currentVersion})`)
        }
        return undefined
      }).catch((error) => {
        report(ctx, `updater: check failed — ${error?.message ?? error}`)
      })
    }, intervalMs)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }

  return { check, install, snapshot, start, state }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const updater = createUpdater(ctx, config)

  // 设置页通过这个服务读状态、触发检查与安装。没有 webServer 时它照样提供，
  // 只是没人读 —— 这行不依赖 Web 才能工作。
  ctx.provide?.('hermesBridgeUpdater', updater)

  // `effect` 挂在 scope 上，不是 ctx 上（真 DSH 里 ctx 没有这个方法）。用空注入
  // 拿一个只做生命周期管理的 scope，定时器就随这行一起被清掉。
  ctx.inject([], (scope) => {
    scope.effect(() => {
      const stop = updater.start()
      return () => { stop() }
    }, 'hermes-bridge: updater timer')
  })

  report(ctx, `updater: watching ${config.repo}@${config.branch}, every ${config.intervalHours}h (auto-install ${config.autoInstall ? 'on' : 'off'})`)
}

export { compareVersions, fetchRemoteVersion, resolveConfig, selfInfo }
