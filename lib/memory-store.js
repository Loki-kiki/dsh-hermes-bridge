/**
 * Hermes memory files: read, write, and tag entries by which agent wrote them.
 *
 * Hermes keeps `MEMORY.md` (agent notes) and `USER.md` (who the user is) as a
 * `\n§\n`-delimited list of entries. The bridge exposes them so a DSH session can
 * read *and write* the same store, which is what makes the persona continuous
 * instead of one-way.
 *
 * ## Why entries carry an origin tag
 *
 * Two agents write into one file now, so "who said this" stops being obvious.
 * A tag is the smallest thing that answers it. It must be tiny, because
 * `MEMORY.md` is a hard-capped budget (Hermes refuses writes past the limit) and
 * every byte of tag is a byte of memory the agent loses.
 *
 * Format: `[hermes]` / `[dsh]` prefix inside the entry, before the text.
 *
 *   `[dsh] DSH 的设置页在 设置 → Hermes 桥接`
 *
 * Entries written before tagging existed have no prefix. Those are Hermes' own
 * (it wrote them all), so they read as `[hermes]` — the tag is inferred, not
 * backfilled. Backfilling would spend budget the file may not have left and
 * could break Hermes' own writes. Untagged stays untagged, and only new writes
 * carry a prefix.
 *
 * @module dsh-hermes-bridge/memory-store
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Hermes' entry delimiter, as it writes it (LF). */
export const ENTRY_DELIMITER = '\n§\n'

/**
 * Matches the delimiter in either line-ending style.
 *
 * Hermes writes LF, but the files on Windows carry CRLF (`\r\n§\r\n`) because
 * they have been edited by Windows tools. Splitting on the LF form alone would
 * read the whole file as one entry — and writing that back collapses 34 entries
 * into 1, destroying the memory.
 */
const ENTRY_SPLIT = /\r?\n§\r?\n/u

/** The two files Hermes keeps, and which one each target maps to. */
export const TARGETS = {
  memory: 'MEMORY.md',
  user: 'USER.md',
}

/**
 * Origin tags. `dsh` is this bridge; `hermes` is the CLI/desktop app.
 * Kept short on purpose — see the module note about the budget.
 */
export const ORIGINS = ['hermes', 'dsh']

const ORIGIN_PATTERN = /^\[(hermes|dsh)\]\s+/u

/**
 * Split a memory file into entries, the same way Hermes does.
 *
 * Hermes splits on `\n§\n`. On Windows the file is written with CRLF, so the
 * delimiter on disk is `\r\n§\r\n` — matching only the LF form treats the whole
 * file as ONE entry, and writing it back would collapse every entry into one.
 * Both forms are accepted here, and the original separator is preserved on
 * write so the file keeps its line endings instead of being rewritten to LF.
 *
 * @param {string} raw - file contents.
 * @returns {string[]} non-empty entries.
 */
export function parseEntries(raw) {
  if (typeof raw !== 'string' || raw === '') return []
  return raw
    .split(ENTRY_SPLIT)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Join entries back into file contents, preserving the file's line endings.
 *
 * @param {string[]} entries - entries.
 * @param {string} [delimiter] - delimiter to use; defaults to Hermes' LF form.
 * @returns {string} file contents.
 */
export function joinEntries(entries, delimiter = ENTRY_DELIMITER) {
  return entries.join(delimiter)
}

/**
 * Read an entry's origin tag.
 *
 * An untagged entry predates the tag and was written by Hermes, so it reports
 * `hermes` with `tagged: false` — the distinction lets a caller show "assumed"
 * rather than claiming a prefix that is not in the text.
 *
 * @param {string} entry - one entry.
 * @returns {{origin: string, tagged: boolean, text: string}} origin and body.
 */
export function readOrigin(entry) {
  const match = ORIGIN_PATTERN.exec(entry)
  if (match === null) return { origin: 'hermes', tagged: false, text: entry }
  return { origin: match[1], tagged: true, text: entry.slice(match[0].length) }
}

/**
 * Put an origin tag on entry text, unless it already carries one.
 *
 * A caller passing text that already starts with a tag keeps its own tag: the
 * model may be re-adding an entry it just read, and silently relabelling it
 * would launder Hermes' words into DSH's.
 *
 * @param {string} text - entry text, possibly already tagged.
 * @param {string} origin - origin to apply when the text is untagged.
 * @returns {string} tagged entry.
 */
export function withOrigin(text, origin) {
  const body = String(text ?? '').trim()
  if (body === '') return ''
  if (ORIGIN_PATTERN.test(body)) return body
  return `[${origin}] ${body}`
}

/**
 * Character count the way Hermes counts it: the joined entries, delimiters
 * included. Used to warn before a write that Hermes would reject.
 * @param {string[]} entries - entries.
 * @returns {number} characters.
 */
export function charCount(entries) {
  return joinEntries(entries).length
}

/**
 * Hermes' own per-file caps, read from its config so this module cannot drift
 * from what the app actually enforces.
 *
 * Hermes' documented defaults are 2200/1375, and they are the fallback here.
 * Hardcoding anything else would make the bridge refuse writes the app would
 * accept, or accept writes it would then reject.
 *
 * @param {string} hermesHome - Hermes home directory.
 * @returns {{memory: number, user: number}} limits per target.
 */
export async function readLimits(hermesHome) {
  const limits = { memory: 2200, user: 1375 }
  let raw
  try {
    raw = await fsp.readFile(path.join(hermesHome, 'config.yaml'), 'utf8')
  } catch {
    // No config or unreadable: the documented defaults are the best guess, and
    // a wrong guess only changes the warning, never the write itself.
    return limits
  }
  // Walk lines rather than regex a block: a block regex has to decide where
  // `memory:` ends, and every choice mis-parses either a following top-level key
  // or a nested map (`memory.provider` is a scalar sibling, not a child).
  const lines = raw.split(/\r?\n/u)
  let inMemory = false
  let memoryIndent = 0
  for (const line of lines) {
    if (/^\s*#/u.test(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const key = /^\s*([A-Za-z_][\w-]*)\s*:/u.exec(line)
    if (key === null) continue
    if (indent === 0) {
      inMemory = key[1] === 'memory'
      memoryIndent = indent
      continue
    }
    if (!inMemory || indent <= memoryIndent) continue
    if (key[1] === 'memory_char_limit') {
      const value = Number.parseInt(line.slice(line.indexOf(':') + 1).trim(), 10)
      if (Number.isFinite(value)) limits.memory = value
    } else if (key[1] === 'user_char_limit') {
      const value = Number.parseInt(line.slice(line.indexOf(':') + 1).trim(), 10)
      if (Number.isFinite(value)) limits.user = value
    }
  }
  return limits
}

/**
 * Resolve the file behind a target name.
 * @param {string} hermesHome - Hermes home.
 * @param {string} target - `memory` or `user`.
 * @returns {string} absolute file path.
 */
export function fileFor(hermesHome, target) {
  const file = TARGETS[target]
  if (file === undefined) {
    throw new Error(`unknown memory target "${target}" — use "memory" or "user"`)
  }
  return path.join(hermesHome, 'memories', file)
}

/**
 * Read entries for a target, with each entry's origin resolved.
 * @param {string} hermesHome - Hermes home.
 * @param {string} target - `memory` or `user`.
 * @returns {Promise<{entries: Array<{index: number, origin: string, tagged: boolean, text: string}>, path: string, chars: number, limit: number}>} snapshot.
 */
export async function readTarget(hermesHome, target) {
  const file = fileFor(hermesHome, target)
  let raw = ''
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const parsed = parseEntries(raw)
  const limits = await readLimits(hermesHome)
  return {
    path: file,
    chars: charCount(parsed),
    limit: limits[target],
    entries: parsed.map((entry, index) => ({ index, ...readOrigin(entry) })),
  }
}

/**
 * Read-modify-write with a version check, so a concurrent Hermes write is never
 * silently dropped.
 *
 * A cross-process advisory lock is not available from Node on Windows, and a
 * fake one is worse than none: Hermes creates `<file>.lock` with `O_CREAT` and
 * leaves it behind, so a lock-by-existence scheme either blocks forever or
 * deletes the file Hermes is still holding, after which both sides believe they
 * are exclusive and one entry is lost.
 *
 * Instead the caller supplies a mutation function and this retries it whenever
 * the file changed underneath. Every attempt re-reads, so the last writer's
 * entries are always present. `attempts` bounds a hot loop against a writer that
 * never stops.
 *
 * @param {string} file - memory file.
 * @param {(entries: string[]) => string[] | null} mutate - returns new entries, or null to abort.
 * @param {{attempts?: number}} [options] - retry bound.
 * @returns {Promise<{entries: string[], retries: number}>} written entries.
 */
export async function updateEntries(file, mutate, options = {}) {
  const attempts = options.attempts ?? 5
  // Serialize in-process callers on the same file first. The version check below
  // catches a *cross-process* write (Hermes), but it cannot catch our own
  // concurrent callers: they all read the same pre-write version and then all
  // believe their write is safe, so N appends collapse into one. A per-file
  // promise chain is the only way to make our own calls mutually exclusive.
  const previous = writeQueues.get(file) ?? Promise.resolve()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  writeQueues.set(file, previous.then(() => gate))
  await previous.catch(() => {})
  try {
    return await updateEntriesLocked(file, mutate, attempts)
  } finally {
    release()
    // Drop the queue once nothing is waiting, so a long-lived process does not
    // accumulate one entry per file ever touched.
    if (writeQueues.get(file) === undefined) writeQueues.delete(file)
  }
}

/** Per-file promise chain making this process' own writes mutually exclusive. */
const writeQueues = new Map()

/**
 * The version-checked body of {@link updateEntries}.
 * @param {string} file - memory file.
 * @param {(entries: string[]) => string[] | null} mutate - mutation.
 * @param {number} attempts - retry bound.
 * @returns {Promise<{entries: string[], retries: number}>} written entries.
 */
async function updateEntriesLocked(file, mutate, attempts) {
  let retries = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await readVersion(file)
    if (before === 'absent') {
      // Refuse instead of creating the file. A missing MEMORY.md/USER.md means
      // hermesHome is almost certainly wrong, and creating it would bury that
      // mistake in a fresh directory nobody thinks to look at. Hermes creates
      // these files itself the first time it writes memory.
      throw new Error(
        `${file} does not exist — refusing to create it. This usually means hermesHome points at the `
          + 'wrong directory; Hermes creates MEMORY.md/USER.md itself, so check the row config.',
      )
    }
    const current = await readRawEntries(file)
    const next = mutate(current)
    if (next === null) throw new Error('mutation aborted')
    if (attempt > 0) retries += 1
    const after = await readVersion(file)
    // Version unchanged since the read: nobody else wrote, so this write is
    // safe. `mtimeMs` alone is too coarse on NTFS, hence the size+content hash.
    if (before === after) {
      await writeAtomic(file, next)
      return { entries: next, retries }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(
    `${file} kept changing while writing (another agent is writing it); retry the call`,
  )
}

/**
 * Fingerprint a file's current state for the optimistic check.
 * @param {string} file - memory file.
 * @returns {Promise<string>} version token.
 */
async function readVersion(file) {
  try {
    const stat = await fsp.stat(file)
    const body = await fsp.readFile(file, 'utf8')
    // Size + mtime catch the common case cheaply; the body hash catches a
    // same-size same-tick rewrite that mtime cannot see.
    return `${stat.size}:${stat.mtimeMs}:${hashString(body)}`
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}

/**
 * Cheap non-cryptographic hash, used only to detect change.
 * @param {string} text - input.
 * @returns {string} 32-bit hex digest.
 */
function hashString(text) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

/**
 * Write entries atomically: temp file in the same directory, then rename.
 * @param {string} file - destination.
 * @param {string[]} entries - entries to write.
 * @returns {Promise<void>} resolves once renamed.
 */
export async function writeAtomic(file, entries) {
  // Match the file's existing line endings. Rewriting a CRLF file as LF turns
  // every line into a diff and makes Hermes' own drift detection fire; on a
  // 5 KB memory file that is 300+ changed lines for one appended entry.
  const delimiter = await detectDelimiter(file)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await fsp.writeFile(tmp, joinEntries(entries, delimiter), 'utf8')
  // Rename is atomic on NTFS and POSIX for same-volume paths, so a reader sees
  // either the old file or the new one, never a half-written list.
  await fsp.rename(tmp, file)
}

/**
 * Pick the delimiter that matches the file's current line endings.
 * @param {string} file - memory file.
 * @returns {Promise<string>} `\r\n§\r\n` for a CRLF file, `\n§\n` otherwise.
 */
async function detectDelimiter(file) {
  try {
    const body = await fsp.readFile(file, 'utf8')
    return body.includes('\r\n') ? '\r\n§\r\n' : ENTRY_DELIMITER
  } catch {
    return ENTRY_DELIMITER
  }
}

/**
 * `add` — append one entry.
 *
 * The budget check mirrors Hermes': it refuses before writing rather than
 * writing an over-limit file Hermes would then treat as external drift.
 *
 * @param {string} hermesHome - Hermes home.
 * @param {string} target - target file.
 * @param {string} text - entry text.
 * @param {string} origin - origin tag to apply.
 * @returns {Promise<object>} result summary.
 */
export async function addEntry(hermesHome, target, text, origin) {
  const file = fileFor(hermesHome, target)
  const entry = withOrigin(text, origin)
  if (entry === '') throw new Error('entry text is empty')
  const limits = await readLimits(hermesHome)
  let merged = []
  const result = await updateEntries(file, (current) => {
    // Append to the raw list: rebuilding from `readOrigin` would re-tag legacy
    // untagged entries and rewrite text Hermes wrote.
    merged = [...current, entry]
    const chars = charCount(merged)
    if (chars > limits[target]) {
      throw new Error(
        `refusing to write: ${chars} chars would exceed Hermes' limit of ${limits[target]} for ${target}. ` +
          `Consolidate existing entries first (remove or shorten some), then retry.`,
      )
    }
    return merged
  })
  return {
    path: file,
    target,
    origin,
    chars: charCount(result.entries),
    limit: limits[target],
    entries: result.entries.length,
    added: entry,
    retries: result.retries,
  }
}

/**
 * `patch` — replace the text of one entry, keeping its origin unless overridden.
 * @param {string} hermesHome - Hermes home.
 * @param {string} target - target file.
 * @param {string} oldText - substring identifying exactly one entry.
 * @param {string} newText - replacement text (tag applied if absent).
 * @param {string} origin - origin for the rewritten entry.
 * @returns {Promise<object>} result summary.
 */
export async function patchEntry(hermesHome, target, oldText, newText, origin) {
  const file = fileFor(hermesHome, target)
  const needle = String(oldText ?? '').trim()
  if (needle === '') throw new Error('old_text is empty')
  const limits = await readLimits(hermesHome)
  const replacement = withOrigin(newText, origin)
  let replaced = ''
  const result = await updateEntries(file, (current) => {
    const hits = current.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(needle))
    if (hits.length === 0) throw new Error(`no entry contains "${needle}"`)
    if (hits.length > 1) {
      throw new Error(
        `"${needle}" matches ${hits.length} entries — old_text must identify exactly one entry. ` +
          `Use a longer, unique substring.`,
      )
    }
    replaced = hits[0].entry
    const next = current.slice()
    next[hits[0].index] = replacement
    const chars = charCount(next)
    if (chars > limits[target]) {
      throw new Error(
        `refusing to write: ${chars} chars would exceed Hermes' limit of ${limits[target]} for ${target}`,
      )
    }
    return next
  })
  return {
    path: file,
    target,
    origin,
    chars: charCount(result.entries),
    limit: limits[target],
    entries: result.entries.length,
    replaced,
    with: replacement,
    retries: result.retries,
  }
}

/**
 * `remove` — delete one entry.
 * @param {string} hermesHome - Hermes home.
 * @param {string} target - target file.
 * @param {string} oldText - substring identifying exactly one entry.
 * @returns {Promise<object>} result summary.
 */
export async function removeEntry(hermesHome, target, oldText) {
  const file = fileFor(hermesHome, target)
  const needle = String(oldText ?? '').trim()
  if (needle === '') throw new Error('old_text is empty')
  let removed = ''
  const result = await updateEntries(file, (current) => {
    const hits = current.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(needle))
    if (hits.length === 0) throw new Error(`no entry contains "${needle}"`)
    if (hits.length > 1) {
      throw new Error(`"${needle}" matches ${hits.length} entries — old_text must identify exactly one entry`)
    }
    removed = hits[0].entry
    return current.filter((_, index) => index !== hits[0].index)
  })
  return {
    path: file,
    target,
    removed,
    entries: result.entries.length,
    chars: charCount(result.entries),
    retries: result.retries,
  }
}

/**
 * Read raw entry strings (tags intact), refusing an unreadable file so a
 * mutation never overwrites content it could not see.
 * @param {string} file - memory file.
 * @returns {Promise<string[]>} raw entries.
 */
async function readRawEntries(file) {
  try {
    return parseEntries(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`cannot read ${file}: ${error?.message ?? error}`)
  }
}

/**
 * Cheap existence check used by the settings page.
 * @param {string} file - memory file.
 * @returns {boolean} whether it exists.
 */
export function exists(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
