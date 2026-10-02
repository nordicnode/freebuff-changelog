// data/changelog.json is the manifest; the entries live in
// data/changelog/<day>.json, one small file per day.
//
// Why: the single document was 50 MiB and growing ~1 MiB/h with the relay
// writing a new copy every cycle -- the same shape that put ai-summaries.json
// hours from GitHub's 100 MiB per-file push limit, where a rejected push stops
// ingestion. Day shards keep every tracked file small forever (measured: 743
// days, 30 KiB average, 306 KiB worst) and match the day sharding the serving
// layer already uses for api/records/<day>.json.
//
// The store is the only thing that knows the layout. Everything else keeps
// working with the same document shape it always had: loadChangelog reassembles
// manifest + shards, saveChangelog splits and writes back only the shards whose
// bytes changed. A legacy monolith (entries inline in changelog.json) still
// loads as itself and migrates on the first save -- forward-only, no history
// rewrite.
//
// Meta fields (version, repo, generatedAt, headSha, counts) stay in the
// manifest, so readers that only need freshness -- the deploy gate's inline
// check, cli.mjs freshness -- never touch a shard.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJson } from './util.mjs'

export const SHARD_DIR = 'changelog'
export const SHARD_LAYOUT = 'day-shards'
const MANIFEST = 'changelog.json'

// The one ordering every surface assumes: oldest first, SHA breaking ties
// within a day. Lives here (not mergedata) so the store can reassemble shards
// in the same order a monolith was written in, and mergedata imports it.
export function sortEntries (entries = []) {
  return entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sha < b.sha ? -1 : 1))
}

// An entry's shard is its derived `day`; a row so old it predates the day key
// falls back to its date prefix, and a row with neither lands in `unknown`.
export function shardNameOf (e) {
  return e?.day || String(e?.date || '').slice(0, 10) || 'unknown'
}

export function splitEntries (entries = []) {
  const by = new Map()
  for (const e of entries) {
    const day = shardNameOf(e)
    if (!by.has(day)) by.set(day, [])
    by.get(day).push(e)
  }
  return by
}

// A document that still carries its entries inline is the pre-shard monolith.
export function isLegacyDoc (doc) {
  return Array.isArray(doc?.entries)
}

/**
 * The full document: manifest fields plus every shard's entries, or the legacy
 * monolith while one is still on disk. Returns null when there is no changelog
 * at all, exactly like a failed readJson did before.
 */
export async function loadChangelog (dataDir) {
  const manifest = await readJson(join(dataDir, MANIFEST), null)
  if (!manifest) return null
  if (isLegacyDoc(manifest)) return manifest
  const dir = join(dataDir, SHARD_DIR)
  let names = []
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort()
  } catch { /* a manifest with no shard directory yet reads as zero entries */ }
  const entries = []
  for (const name of names) {
    const shard = await readJson(join(dir, name), null)
    if (Array.isArray(shard?.entries)) entries.push(...shard.entries)
  }
  return { ...manifest, entries: sortEntries(entries) }
}

const shardBytes = shard => JSON.stringify(shard, null, 2) + '\n'

// Rewriting an unchanged shard churns the worktree for nothing, so compare the
// exact bytes first: a quiet cycle must not dirty 743 files.
async function writeShard (path, shard) {
  const next = shardBytes(shard)
  try {
    if ((await readFile(path, 'utf8')) === next) return
  } catch { /* new shard */ }
  await writeJson(path, shard)
}

/**
 * Write a document back as a manifest plus day shards. Only changed shards hit
 * the disk, and a day whose entries left loses its shard -- load unions the
 * directory, so a stale file would resurrect entries a merge dropped.
 */
export async function saveChangelog (dataDir, doc) {
  const entries = Array.isArray(doc?.entries) ? doc.entries : []
  const by = splitEntries(entries)
  const dir = join(dataDir, SHARD_DIR)
  await mkdir(dir, { recursive: true })
  const wanted = new Set()
  for (const [day, list] of by) {
    const name = `${day}.json`
    wanted.add(name)
    await writeShard(join(dir, name), { day, entries: sortEntries(list.slice()) })
  }
  for (const name of await readdir(dir)) {
    if (name.endsWith('.json') && !wanted.has(name)) await rm(join(dir, name), { force: true })
  }
  const { entries: _inline, ...meta } = doc || {}
  await writeJson(join(dataDir, MANIFEST), {
    ...meta,
    layout: SHARD_LAYOUT,
    counts: { ...(doc?.counts || {}), entries: entries.length }
  })
}

// Total bytes of the manifest + shards, for commands that report what a
// compaction moved. Not used by writers.
export async function changelogBytes (dataDir) {
  let bytes = 0
  const manifest = join(dataDir, MANIFEST)
  if (existsSync(manifest)) bytes += (await readFile(manifest)).length
  const dir = join(dataDir, SHARD_DIR)
  let names = []
  try { names = await readdir(dir) } catch { return bytes }
  for (const name of names) {
    try { bytes += (await readFile(join(dir, name))).length } catch { /* unreadable shard: skip its size */ }
  }
  return bytes
}
