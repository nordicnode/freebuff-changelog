import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVIDENCE_FANOUT, evidencePath, evidenceStats, gcEvidence, legacyEvidencePath, liveEvidenceHashes, resolveEvidence, spillEntryEvidence, spillEvidence, storeEvidence } from '../lib/evidence.mjs'
import { shortHash } from '../lib/util.mjs'

async function withDir (fn) {
  const dir = await mkdtemp(join(tmpdir(), 'evidence-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const MATERIAL = 'Date: 2026-10-02\nRelease: 0.2.9\n\nUpdates included in this release:\n- one change\n'

// Write a shard the way the store did before the hash fan-out.
async function writeFlat (dir, material) {
  const hash = shortHash(material)
  await mkdir(join(dir, 'evidence'), { recursive: true })
  await writeFile(legacyEvidencePath(dir, hash), material)
  return hash
}

test('evidencePath fans shards out under a hash prefix, and storeEvidence writes only there', () => withDir(async dir => {
  const hash = shortHash(MATERIAL)
  assert.equal(evidencePath(dir, hash), join(dir, 'evidence', hash.slice(0, EVIDENCE_FANOUT), `${hash}.txt`))
  const bundle = await storeEvidence(dir, MATERIAL)
  assert.deepEqual(bundle, { hash })
  assert.equal(await readFile(join(dir, 'evidence', hash.slice(0, EVIDENCE_FANOUT), `${hash}.txt`), 'utf8'), MATERIAL)
  await assert.rejects(readFile(legacyEvidencePath(dir, hash), 'utf8'), 'new writes do not use the flat layout')
}))

test('storeEvidence never rewrites an existing shard, in either layout, and empty material writes nothing', () => withDir(async dir => {
  const path = evidencePath(dir, shortHash('same bytes'))
  await storeEvidence(dir, 'same bytes')
  await writeFile(path, 'POISONED')
  await storeEvidence(dir, 'same bytes')
  assert.equal(await readFile(path, 'utf8'), 'POISONED', 'equal material addresses the same shard; a later write must not overwrite it')

  // A pre-fan-out flat shard already carries these bytes: the fan-out copy
  // must not be written beside it while GC has not moved it yet.
  const flatHash = await writeFlat(dir, 'flat bytes')
  await storeEvidence(dir, 'flat bytes')
  await assert.rejects(readFile(evidencePath(dir, flatHash), 'utf8'), 'the flat shard counts as stored, so it is not duplicated')

  assert.deepEqual(await storeEvidence(dir, ''), { hash: shortHash('') })
  await assert.rejects(readFile(evidencePath(dir, shortHash('')), 'utf8'), 'empty material has no shard to read')
}))

test('storeEvidence throws when material has no dataDir to be stored in', async () => {
  // A missing dataDir used to return a hash-only bundle: the hash named a
  // shard that was never written, so the record could never resolve its
  // evidence. A dropped argument is now a broken call, not a silent loss.
  await assert.rejects(storeEvidence(null, MATERIAL), /needs a dataDir/)
  await assert.rejects(storeEvidence(undefined, MATERIAL), /needs a dataDir/)
  await assert.rejects(storeEvidence('', MATERIAL), /needs a dataDir/)
  assert.deepEqual(await storeEvidence(null, ''), { hash: shortHash('') }, 'empty material has no shard to write, so it needs no directory')
})

test('resolveEvidence reads the shard back and keeps the stored hash', () => withDir(async dir => {
  const stored = await storeEvidence(dir, MATERIAL)
  const resolved = await resolveEvidence(dir, { ...stored })
  assert.equal(resolved.material, MATERIAL)
  assert.equal(resolved.hash, stored.hash)
  assert.equal(shortHash(resolved.material), resolved.hash, 'a resolved bundle still passes every reader guard')
}))

test('resolveEvidence falls back to a pre-fan-out flat shard', () => withDir(async dir => {
  const hash = await writeFlat(dir, MATERIAL)
  const resolved = await resolveEvidence(dir, { hash })
  assert.equal(resolved.material, MATERIAL, 'a checkout mid-migration still reads its evidence')
  assert.equal(resolved.hash, hash)
}))

test('resolveEvidence prefers inline material so pre-shard records keep working', () => withDir(async dir => {
  const bundle = { material: 'legacy inline material', hash: shortHash('legacy inline material') }
  const resolved = await resolveEvidence(dir, bundle)
  assert.equal(resolved, bundle, 'the inline bundle is returned as-is, with no shard lookup')
}))

test('resolveEvidence yields no material when the shard is missing or tampered', () => withDir(async dir => {
  const missing = await resolveEvidence(dir, { hash: shortHash('never stored') })
  assert.equal(missing.material, undefined, 'a missing shard leaves the bundle without material')
  assert.equal(Boolean(missing && !missing.material), true, 'the readers\u2019 !bundle.material guard sees exactly that')

  const stored = await storeEvidence(dir, MATERIAL)
  await writeFile(evidencePath(dir, stored.hash), 'tampered bytes')
  const tampered = await resolveEvidence(dir, { ...stored })
  assert.equal(tampered.material, 'tampered bytes')
  assert.notEqual(shortHash(tampered.material), tampered.hash, 'the tampered material fails the hash check readers already perform')
}))

test('liveEvidenceHashes collects cache records and changelog entry copies', () => {
  const a = 'a'.repeat(12)
  const b = 'b'.repeat(12)
  const c = 'c'.repeat(12)
  const cache = {
    'x:v1:1': { evidenceBundle: { hash: a } },
    'y:v1:1': { evidenceBundle: { material: 'inline', hash: b } },
    'z:v1:1': { title: 'no bundle' },
    'w:v1:1': { error: 'LLM HTTP 429' }
  }
  const doc = { entries: [
    { ai: { evidenceBundle: { hash: b } }, eli5: { evidenceBundle: { hash: c } } },
    { ai: {} },
    {}
  ] }
  assert.deepEqual([...liveEvidenceHashes(cache, doc)].sort(), [a, b, c].sort())
})

test('gcEvidence deletes orphans, migrates flat shards, and leaves strangers alone', () => withDir(async dir => {
  const kept = await storeEvidence(dir, MATERIAL)
  const orphan = await storeEvidence(dir, 'orphaned material')
  const flatLive = await writeFlat(dir, 'flat live material')
  const flatOrphan = await writeFlat(dir, 'flat orphan material')
  await writeFile(join(dir, 'evidence', 'README.txt'), 'not a shard name')

  const acc = await gcEvidence(dir, new Set([kept.hash, flatLive]))
  assert.deepEqual(acc, {
    scanned: 4,
    kept: 1,
    orphans: 2,
    orphanBytes: Buffer.byteLength('orphaned material') + Buffer.byteLength('flat orphan material'),
    duplicates: 0,
    duplicateBytes: 0,
    moved: 1,
    movedBytes: Buffer.byteLength('flat live material'),
    unrecognized: 1
  })
  assert.equal(await readFile(evidencePath(dir, kept.hash), 'utf8'), MATERIAL, 'a live canonical shard is kept')
  await assert.rejects(readFile(evidencePath(dir, orphan.hash), 'utf8'), 'an unreferenced shard is deleted')
  assert.equal(await readFile(evidencePath(dir, flatLive), 'utf8'), 'flat live material', 'a live flat shard moves into its prefix directory')
  await assert.rejects(readFile(legacyEvidencePath(dir, flatLive), 'utf8'), 'and does not stay behind')
  await assert.rejects(readFile(legacyEvidencePath(dir, flatOrphan), 'utf8'), 'an unreferenced flat shard is deleted')
  assert.equal(await readFile(join(dir, 'evidence', 'README.txt'), 'utf8'), 'not a shard name', 'files that are not shard names are never touched')

  const stats = await evidenceStats(dir)
  assert.deepEqual(stats, { files: 2, flat: 0, dirs: 2, widest: 1 }, 'after migration every shard is fanned out and one directory deep')
}))

test('gcEvidence drops a redundant flat copy when the canonical shard exists', () => withDir(async dir => {
  const hash = shortHash(MATERIAL)
  await storeEvidence(dir, MATERIAL)
  await writeFlat(dir, MATERIAL)
  const acc = await gcEvidence(dir, new Set([hash]))
  assert.equal(acc.duplicates, 1)
  assert.equal(acc.orphans, 0)
  assert.equal(acc.moved, 0)
  assert.equal(await readFile(evidencePath(dir, hash), 'utf8'), MATERIAL)
  await assert.rejects(readFile(legacyEvidencePath(dir, hash), 'utf8'), 'the duplicate is gone, the canonical shard stays')
}))

test('gcEvidence dry run reports the same work without changing anything', () => withDir(async dir => {
  const orphan = await storeEvidence(dir, 'orphan')
  const flat = await writeFlat(dir, 'flat live')
  const acc = await gcEvidence(dir, new Set([flat]), { dryRun: true })
  assert.equal(acc.orphans, 1)
  assert.equal(acc.moved, 1)
  assert.equal(await readFile(evidencePath(dir, orphan.hash), 'utf8'), 'orphan', 'dry run keeps orphans')
  assert.equal(await readFile(legacyEvidencePath(dir, flat), 'utf8'), 'flat live', 'dry run keeps the flat layout')
}))

test('spillEntryEvidence moves the ai and eli5 copies on changelog entries', () => withDir(async dir => {
  const plain = 'plain-English evidence material'
  const doc = { entries: [
    { sha: 'a'.repeat(40), ai: { title: 'x', evidenceBundle: { material: MATERIAL, hash: shortHash(MATERIAL) } }, eli5: { text: 'y', evidenceBundle: { material: plain, hash: shortHash(plain) } } },
    { sha: 'b'.repeat(40), ai: { title: 'no bundle' } },
    { sha: 'c'.repeat(40) }
  ] }
  const moved = await spillEntryEvidence(dir, doc)
  assert.deepEqual(moved, { spilled: 2, bytes: Buffer.byteLength(MATERIAL, 'utf8') + Buffer.byteLength(plain, 'utf8') })
  assert.deepEqual(doc.entries[0].ai.evidenceBundle, { hash: shortHash(MATERIAL) })
  assert.deepEqual(doc.entries[0].eli5.evidenceBundle, { hash: shortHash(plain) })
  assert.equal(await readFile(evidencePath(dir, shortHash(MATERIAL)), 'utf8'), MATERIAL)
  assert.deepEqual(doc.entries[1].ai, { title: 'no bundle' }, 'entries without bundles are untouched')
}))

test('spillEvidence moves only inline material, and a dry run moves nothing', () => withDir(async dir => {
  const stored = await storeEvidence(dir, 'already sharded')
  const cache = {
    'a:v11:1': { title: 'inline', evidenceBundle: { material: MATERIAL, hash: shortHash(MATERIAL) } },
    'b:v11:1': { title: 'sharded', evidenceBundle: { ...stored } },
    'c:v11:1': { error: 'LLM HTTP 429', at: '2020-01-01T00:00:00Z' },
    'd:v11:1': { title: 'empty', evidenceBundle: { material: '', hash: shortHash('') } }
  }
  const dry = await spillEvidence(dir, structuredClone(cache), { dryRun: true })
  assert.deepEqual(dry, { spilled: 1, bytes: Buffer.byteLength(MATERIAL, 'utf8') })
  await assert.rejects(readFile(evidencePath(dir, shortHash(MATERIAL)), 'utf8'), 'dry run must not write shards')

  const moved = await spillEvidence(dir, cache)
  assert.deepEqual(moved, { spilled: 1, bytes: Buffer.byteLength(MATERIAL, 'utf8') })
  assert.deepEqual(cache['a:v11:1'].evidenceBundle, { hash: shortHash(MATERIAL) }, 'inline material becomes a hash-only bundle')
  assert.equal(await readFile(evidencePath(dir, shortHash(MATERIAL)), 'utf8'), MATERIAL)
  assert.deepEqual(cache['b:v11:1'].evidenceBundle, { ...stored }, 'sharded bundles are left alone')
  assert.deepEqual(cache['c:v11:1'], { error: 'LLM HTTP 429', at: '2020-01-01T00:00:00Z' }, 'error stubs have no bundle to move')
  assert.deepEqual(cache['d:v11:1'].evidenceBundle, { material: '', hash: shortHash('') }, 'empty material stays inline: it can never grow the file')
}))
