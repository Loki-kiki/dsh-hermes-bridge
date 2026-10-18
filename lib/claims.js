/**
 * One process-wide registry of tool names a bridge row has claimed.
 *
 * Two rows in this bundle can describe the *same* backend: `viking` hand-writes
 * an OpenViking client, and `provider` forwards whatever provider Hermes has
 * configured — which, on an OpenViking setup, is OpenViking. Registering one
 * tool name twice is a hard error in DSH's tool registry (`tool "x" is already
 * registered`), not a merge, so one of them has to yield.
 *
 * The claim set lives in module scope rather than in a cordis service on
 * purpose: rows are separate plugin contexts, and whether a service provided by
 * one row is visible to a sibling depends on load order and isolation options.
 * A module-level set is the same for every row in this process, which is exactly
 * the scope the tool registry itself has.
 *
 * The rule the rows follow: **the specialised row claims first** (`viking`
 * registers `viking_*` before `provider` mounts), and `provider` skips anything
 * already claimed, reporting the count. So enabling both is safe and the user
 * gets one tool set, not a boot failure.
 *
 * @module dsh-hermes-bridge/claims
 */

const claimed = new Map()

/**
 * Record that a row owns these tool names.
 * @param {string} row - row id, for diagnostics.
 * @param {string[]} names - tool names.
 * @returns {void}
 */
export function claim(row, names) {
  for (const name of names) claimed.set(name, row)
}

/**
 * Which row owns a tool name, if any.
 * @param {string} name - tool name.
 * @returns {string|undefined} owning row id.
 */
export function ownerOf(name) {
  return claimed.get(name)
}

/**
 * Drop one row's claims, so a recompose can re-claim cleanly.
 * @param {string} row - row id.
 * @returns {void}
 */
export function release(row) {
  for (const [name, owner] of [...claimed]) {
    if (owner === row) claimed.delete(name)
  }
}

/** Everything currently claimed, for the settings page and the CLI. */
export function snapshot() {
  return Object.fromEntries(claimed)
}
