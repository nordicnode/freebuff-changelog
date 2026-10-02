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
// Shards are fanned out under a two-character prefix of their own hash
// (data/evidence/ab/abcdef123456.txt): the flat layout held every shard in one
// directory, and a listing thousands of entries wide is slow for git, the
// runner and every GC scan. The fan-out is derivable from the record alone; a
// pre-fan-out flat shard is still read (resolveEvidence falls back to it) and
// gcEvidence moves it into place, so no reader has to know which layout a
// checkout is on.
//
// gcEvidence also deletes shards no stored record points at any more -- a
// pruned cache record, a re-check superseded by a fresh bundle. The live set
// is every hash named by the cache and by the changelog's ai/eli5 copies; the
// walk is by filename, because the name is the content hash.
//
// The bundle keeps its exact meaning: `hash` is the fingerprint every reader
// verifies against, and `resolveEvidence` puts the material back for them. An
// inline `material` (a pre-shard record, or a fixture) still wins, so the old
// shape keeps working while it ages out.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { shortHash } from './util.mjs'

export const EVIDENCE_DIR = 'evidence'

// One fan-out level, two hex characters: 256 directories, each holding about
// total/256 shards -- ~2 today, ~12 at the 3,000-shard width guidance. The
// directory name is a pure function of the hash in the file name.
export const EVIDENCE_FANOUT = 2

// A shard's name is its content hash, exactly as shortHash produces it. GC
// never touches a file that does not match: the store lives in the repository
// and a human's stray file is not ours to collect.
const SHARD_HASH = /^[0-9a-f]{12}$/
const SHARD_NAME = /^([0-9a-f]{12})\.txt$/

// A directory past this width is slow enough that the fan-out is not keeping
// up; check-size reports the widest one so a regression is visible before the
// listing cost becomes a problem. The guidance comes from the sharding work
// that motivated the fan-out.
export const EVIDENCE_WIDTH_WARN = 3000

// The canonical location: data/evidence/<2-char prefix>/<hash>.txt.
export function evidencePath (dataDir, hash) {
  return join(dataDir, EVIDENCE_DIR, hash.slice(0, EVIDENCE_FANOUT), `${hash}.txt`)
}

// The pre-fan-out location. Still read (so a checkout mid-migration works) and
// moved, never deleted, by gcEvidence.
export function legacyEvidencePath (dataDir, hash) {
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
    // A legacy flat shard already holds these exact bytes, and writing the
    // fan-out copy too would double them until gcEvidence migrates the flat
    // one. Either hit counts as stored.
    if (!existsSync(path) && !existsSync(legacyEvidencePath(dataDir, hash))) {
      await mkdir(join(dataDir, EVIDENCE_DIR, hash.slice(0, EVIDENCE_FANOUT)), { recursive: true })
      await writeFile(path, material, 'utf8')
    }
  }
  return { hash }
}

// A bundle with its material attached, for readers. Inline material is used
// as-is; otherwise the shard file is read, canonical layout first and the
// pre-fan-out flat name second. A missing file yields the bundle without
// material -- exactly what a reader sees today when stored material is gone --
// so the existing guards (`!bundle?.material`) keep deciding.
export async function resolveEvidence (dataDir, bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle
  if (typeof bundle.material === 'string' && bundle.material.length) return bundle
  if (typeof bundle.hash !== 'string' || !SHARD_HASH.test(bundle.hash)) return bundle
  for (const path of [evidencePath(dataDir, bundle.hash), legacyEvidencePath(dataDir, bundle.hash)]) {
    try {
      return { ...bundle, material: await readFile(path, 'utf8') }
    } catch { /* try the other layout */ }
  }
  return bundle
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

// Every hash a stored record still points at. The cache record is the copy a
// re-check resolves; the changelog's ai/eli5 copies are kept too, so a shard
// any of them names is never collected. An inline-material record still names
// its hash, which keeps a just-written shard alive while the record that will
// point at it is still in memory.
export function liveEvidenceHashes (cache, doc) {
  const live = new Set()
  for (const rec of Object.values(cache || {})) {
    const hash = rec?.evidenceBundle?.hash
    if (hash) live.add(hash)
  }
  for (const entry of doc?.entries || []) {
    for (const key of ['ai', 'eli5']) {
      const hash = entry?.[key]?.evidenceBundle?.hash
      if (hash) live.add(hash)
    }
  }
  return live
}

// Every file in the store, flat or fanned out, as { path, name, dir } with dir
// '' for the legacy flat layout. A missing store is an empty one (direct unit
// calls, or a checkout that has not stored evidence yet).
async function walkEvidence (dataDir) {
  const root = join(dataDir, EVIDENCE_DIR)
  const out = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const names = await readdir(join(root, ent.name), { withFileTypes: true }).catch(() => [])
      for (const name of names) {
        if (name.isFile()) out.push({ path: join(root, ent.name, name.name), name: name.name, dir: ent.name })
      }
    } else if (ent.isFile()) {
      out.push({ path: join(root, ent.name), name: ent.name, dir: '' })
    }
  }
  return out
}

const sizeOf = (path) => stat(path).then(s => s.size).catch(() => 0)

// Shard count and directory width, for check-size. `widest` covers the legacy
// flat directory while any shard is still in it, which is exactly the number
// the fan-out exists to bound.
export async function evidenceStats (dataDir) {
  const widths = new Map()
  let files = 0
  for (const f of await walkEvidence(dataDir)) {
    if (!SHARD_NAME.test(f.name)) continue
    files++
    widths.set(f.dir, (widths.get(f.dir) || 0) + 1)
  }
  return {
    files,
    flat: widths.get('') || 0,
    dirs: [...widths.keys()].filter(dir => dir).length,
    widest: widths.size ? Math.max(...widths.values()) : 0
  }
}

/**
 * Collect the evidence store: delete shards nothing references and move
 * pre-fan-out flat shards into their prefix directories.
 *
 * `live` must come from liveEvidenceHashes over the data as it is on disk, and
 * callers must hold the writer lock. A shard is written moments before the
 * record naming it is persisted; only the lock makes "unreferenced" mean
 * orphan instead of mid-write.
 *
 * A shard's name is its content hash, so liveness is a name comparison and a
 * dry run costs the same walk without touching anything. A live file already
 * at its canonical path is kept; a live file elsewhere is moved there (if a
 * canonical copy already exists, the extra one is a redundant duplicate and is
 * dropped); an unreferenced file is deleted. Files whose names are not shard
 * names are never touched.
 */
export async function gcEvidence (dataDir, live, { dryRun = false } = {}) {
  const acc = { scanned: 0, kept: 0, orphans: 0, orphanBytes: 0, duplicates: 0, duplicateBytes: 0, moved: 0, movedBytes: 0, unrecognized: 0 }
  for (const file of await walkEvidence(dataDir)) {
    const match = SHARD_NAME.exec(file.name)
    if (!match) { acc.unrecognized++; continue }
    const hash = match[1]
    acc.scanned++
    const bytes = await sizeOf(file.path)
    if (!live.has(hash)) {
      acc.orphans++
      acc.orphanBytes += bytes
      if (!dryRun) await rm(file.path, { force: true })
      continue
    }
    const dest = evidencePath(dataDir, hash)
    if (file.path === dest) { acc.kept++; continue }
    // Live, but not where the fan-out says it belongs. A canonical shard
    // already holding this hash makes this copy redundant; otherwise it is a
    // legacy flat shard (or one in the wrong prefix directory) to move, not
    // delete -- migration never costs evidence.
    if (existsSync(dest)) {
      acc.duplicates++
      acc.duplicateBytes += bytes
      if (!dryRun) await rm(file.path, { force: true })
      continue
    }
    acc.moved++
    acc.movedBytes += bytes
    if (!dryRun) {
      await mkdir(dirname(dest), { recursive: true })
      await rename(file.path, dest)
    }
  }
  return acc
}
