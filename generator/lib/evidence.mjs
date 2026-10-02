// Verification evidence lives in shard files beside the cache, never inside
// data/ai-summaries.json.
//
// Why: every verified record used to carry a full copy of the material its
// check read -- the release window plus that row's own delivered evidence,
// ~95 KB on average and up to ~835 KB. At ~2,600 records the cache passed
// 57 MiB and was adding several MiB an hour; GitHub blocks any push carrying a
// file over 100 MiB, so the relay's next data push would have been rejected
// and ingestion would have stopped. Sharded, the same bytes cost the cache
// nothing: one small file per material, content-addressed by the same `hash`
// the record already stores. data/diffs/ already works this way for the same
// reason.
//
// The bundle keeps its exact meaning: `hash` is the fingerprint every reader
// verifies against, and `resolveEvidence` puts the material back for them. An
// inline `material` (a pre-shard record, or a fixture) still wins, so the old
// shape keeps working while it ages out.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shortHash } from './util.mjs'

export const EVIDENCE_DIR = 'evidence'

// The shard name is the record's own `hash` (12 hex chars of sha1), so the path
// is derivable from the record alone and the schema gains nothing. Two
// materials with the same 12-char prefix would collide; that makes the second
// one unreadable, never wrong, because every reader compares the file's content
// hash against the stored one before trusting it.
export function evidencePath (dataDir, hash) {
  return join(dataDir, EVIDENCE_DIR, `${hash}.txt`)
}

// Persist material (if any) and return the bundle the record stores. Writing is
// idempotent: equal material hashes to the same name, and an existing shard is
// never rewritten.
export async function storeEvidence (dataDir, material) {
  const hash = shortHash(material)
  // No dataDir means a direct unit call (the writers' own tests): the bundle
  // still carries its hash, there is just no shard to write.
  if (dataDir && typeof material === 'string' && material.length) {
    const path = evidencePath(dataDir, hash)
    if (!existsSync(path)) {
      await mkdir(join(dataDir, EVIDENCE_DIR), { recursive: true })
      await writeFile(path, material, 'utf8')
    }
  }
  return { hash }
}

// A bundle with its material attached, for readers. Inline material is used
// as-is; otherwise the shard file is read. A missing file yields the bundle
// without material -- exactly what a reader sees today when stored material is
// gone -- so the existing guards (`!bundle?.material`) keep deciding.
export async function resolveEvidence (dataDir, bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle
  if (typeof bundle.material === 'string' && bundle.material.length) return bundle
  if (!bundle.hash) return bundle
  try {
    return { ...bundle, material: await readFile(evidencePath(dataDir, bundle.hash), 'utf8') }
  } catch {
    return bundle
  }
}

// Move one holder's inline material into a shard, counting into `acc`. The
// hash is recomputed from the material -- the material is the source of truth
// and the stored hash is its fingerprint -- which also repairs a corrupt hash
// instead of pinning a record to evidence it can never resolve.
async function spillHolder (dataDir, holder, key, acc, dryRun) {
  const bundle = holder?.[key]
  if (!bundle || typeof bundle.material !== 'string' || !bundle.material.length) return
  acc.spilled++
  acc.bytes += Buffer.byteLength(bundle.material, 'utf8')
  if (dryRun) return
  const { hash } = await storeEvidence(dataDir, bundle.material)
  holder[key] = { hash }
}

// Move every inline material in a cache into data/evidence/. Runs on every
// merge write (see persistMerged), so a union merge can never resurrect the
// monolith, and backs the one-shot `compact-evidence` command.
export async function spillEvidence (dataDir, cache, { dryRun = false } = {}) {
  const acc = { spilled: 0, bytes: 0 }
  for (const rec of Object.values(cache || {})) await spillHolder(dataDir, rec, 'evidenceBundle', acc, dryRun)
  return acc
}

// The same for a changelog document: every entry keeps a copy of its `ai` and
// `eli5` records, and a copy can carry the bundle too (measured: 107 ai + 135
// eli5 copies holding ~21 MiB in August's file). Nothing reads an entry-copied
// bundle -- the cache record is the one re-checks resolve -- so the copy keeps
// its hash exactly like the cache does.
export async function spillEntryEvidence (dataDir, doc, { dryRun = false } = {}) {
  const acc = { spilled: 0, bytes: 0 }
  for (const e of doc?.entries || []) {
    await spillHolder(dataDir, e?.ai, 'evidenceBundle', acc, dryRun)
    await spillHolder(dataDir, e?.eli5, 'evidenceBundle', acc, dryRun)
  }
  return acc
}
