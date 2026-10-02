// Tracked files must clear GitHub's limits with room to spare.
//
// GitHub warns from 50 MiB and rejects any push carrying a file over 100 MiB
// (docs: "About large files on GitHub"). A rejected push is the whole relay
// cycle, and ingestion stops until a human intervenes. The relay checks this
// budget before it commits (assertDataSizeBudget in cli.mjs) and CI checks it
// on every generator change, so the failure surfaces as our own message while
// the file is still fixable -- with ~15 MiB of runway to shard or trim it.
export const SIZE_WARN_BYTES = 60 * 1024 * 1024
export const SIZE_MAX_BYTES = 85 * 1024 * 1024

// Classify [{ path, bytes }] into files at or over the budget and files inside
// the warning band, both largest first.
export function findOverBudget (files = [], { warn = SIZE_WARN_BYTES, max = SIZE_MAX_BYTES } = {}) {
  const over = []
  const near = []
  for (const f of files) {
    if (!f || typeof f.bytes !== 'number') continue
    if (f.bytes >= max) over.push(f)
    else if (f.bytes >= warn) near.push(f)
  }
  const desc = (a, b) => b.bytes - a.bytes
  return { over: over.sort(desc), near: near.sort(desc) }
}

export function sizeText (bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`
}
