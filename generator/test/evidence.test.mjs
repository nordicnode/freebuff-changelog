import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidencePath, resolveEvidence, spillEntryEvidence, spillEvidence, storeEvidence } from '../lib/evidence.mjs'
import { shortHash } from '../lib/util.mjs'

async function withDir (fn) {
  const dir = await mkdtemp(join(tmpdir(), 'evidence-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const MATERIAL = 'Date: 2026-10-02\nRelease: 0.2.9\n\nUpdates included in this release:\n- one change\n'

test('storeEvidence writes a shard named by the material hash', () => withDir(async dir => {
  const bundle = await storeEvidence(dir, MATERIAL)
  assert.deepEqual(bundle, { hash: shortHash(MATERIAL) })
  assert.equal(await readFile(evidencePath(dir, bundle.hash), 'utf8'), MATERIAL)
}))

test('storeEvidence never rewrites an existing shard, and empty material writes nothing', () => withDir(async dir => {
  await storeEvidence(dir, 'same bytes')
  const path = evidencePath(dir, shortHash('same bytes'))
  await writeFile(path, 'POISONED')
  await storeEvidence(dir, 'same bytes')
  assert.equal(await readFile(path, 'utf8'), 'POISONED', 'equal material addresses the same shard; a later write must not overwrite it')
  assert.deepEqual(await storeEvidence(dir, ''), { hash: shortHash('') })
  await assert.rejects(readFile(evidencePath(dir, shortHash('')), 'utf8'), 'empty material has no shard to read')
}))

test('resolveEvidence reads the shard back and keeps the stored hash', () => withDir(async dir => {
  const stored = await storeEvidence(dir, MATERIAL)
  const resolved = await resolveEvidence(dir, { ...stored })
  assert.equal(resolved.material, MATERIAL)
  assert.equal(resolved.hash, stored.hash)
  assert.equal(shortHash(resolved.material), resolved.hash, 'a resolved bundle still passes every reader guard')
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
