import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changelogBytes, isLegacyDoc, loadChangelog, saveChangelog, shardNameOf, sortEntries, splitEntries } from '../lib/changelog-store.mjs'

async function withDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'fb-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const entry = (sha, day, hour = '10') => ({ sha, date: `${day}T${hour}:00:00Z`, day, kind: 'sync', summary: `s ${sha}` })
const doc = entries => ({ version: 1, repo: 'https://example.invalid/repo', generatedAt: '2026-10-02T00:00:00.000Z', headSha: 'abc123', counts: { entries: entries.length, changes: 7 }, entries })

test('saveChangelog splits by day and loadChangelog reassembles in date order', async t => {
  const dir = await withDir(t)
  await saveChangelog(dir, doc([entry('c', '2026-10-02'), entry('a', '2026-09-30'), entry('b', '2026-09-30'), entry('d', '2024-07-09')]))

  assert.deepEqual((await readdir(join(dir, 'changelog'))).sort(), ['2024-07-09.json', '2026-09-30.json', '2026-10-02.json'])
  const meta = JSON.parse(await readFile(join(dir, 'changelog.json'), 'utf8'))
  assert.ok(!Array.isArray(meta.entries), 'the manifest carries no entries')
  assert.equal(meta.layout, 'day-shards')
  assert.equal(meta.headSha, 'abc123', 'scalar fields stay in the manifest')
  assert.equal(meta.counts.changes, 7, 'counts other than entries are untouched')
  assert.equal(meta.counts.entries, 4)

  const loaded = await loadChangelog(dir)
  assert.deepEqual(loaded.entries.map(e => e.sha), ['d', 'a', 'b', 'c'], 'oldest first, SHA breaking ties within a day')
  assert.equal(loaded.headSha, 'abc123')
  assert.equal(loaded.generatedAt, '2026-10-02T00:00:00.000Z')
})

test('saveChangelog is idempotent and only rewrites shards whose bytes changed', async t => {
  const dir = await withDir(t)
  await saveChangelog(dir, doc([entry('a', '2026-09-30'), entry('b', '2026-10-01')]))
  const snapshot = async () => {
    const names = ['changelog.json', ...(await readdir(join(dir, 'changelog'))).sort().map(n => `changelog/${n}`)]
    const map = new Map()
    for (const f of names) map.set(f, await readFile(join(dir, f), 'utf8'))
    return map
  }
  const before = await snapshot()
  await saveChangelog(dir, await loadChangelog(dir))
  const after = await snapshot()
  assert.deepEqual([...after.keys()], [...before.keys()])
  for (const [f, bytes] of before) assert.equal(after.get(f), bytes, `${f} is byte-identical after a no-change save`)

  // One edited entry must touch exactly one shard (and nothing else).
  const editedDoc = await loadChangelog(dir)
  editedDoc.entries.find(e => e.sha === 'b').summary = 'edited'
  await saveChangelog(dir, editedDoc)
  const edited = await snapshot()
  const changed = [...edited.keys()].filter(f => edited.get(f) !== before.get(f))
  assert.deepEqual(changed, ['changelog/2026-10-01.json'], 'one edited entry, one rewritten shard')
})

test('a legacy monolith loads as itself and migrates on the first save', async t => {
  const dir = await withDir(t)
  await writeFile(join(dir, 'changelog.json'), JSON.stringify(doc([entry('b', '2026-09-30'), entry('a', '2026-09-30')]), null, 2) + '\n')

  const rawBefore = JSON.parse(await readFile(join(dir, 'changelog.json'), 'utf8'))
  assert.equal(isLegacyDoc(rawBefore), true, 'the monolith on disk carries entries inline')
  const loaded = await loadChangelog(dir)
  assert.deepEqual(loaded.entries.map(e => e.sha), ['b', 'a'], 'the monolith loads untouched, original order included')

  await saveChangelog(dir, loaded)
  const rawAfter = JSON.parse(await readFile(join(dir, 'changelog.json'), 'utf8'))
  assert.equal(isLegacyDoc(rawAfter), false, 'the written manifest carries no entries')
  assert.equal(rawAfter.layout, 'day-shards')
  const migrated = await loadChangelog(dir)
  assert.deepEqual(migrated.entries.map(e => e.sha), ['a', 'b'], 'same entries, canonical order')
  assert.equal(migrated.headSha, 'abc123')
  assert.deepEqual(await readdir(join(dir, 'changelog')), ['2026-09-30.json'])
})

test('a shard for a day with no entries left is removed', async t => {
  const dir = await withDir(t)
  await saveChangelog(dir, doc([entry('a', '2026-09-30'), entry('b', '2026-10-01')]))
  await saveChangelog(dir, doc([entry('a', '2026-09-30')]))
  assert.deepEqual(await readdir(join(dir, 'changelog')), ['2026-09-30.json'], 'the emptied day does not linger')
  assert.deepEqual((await loadChangelog(dir)).entries.map(e => e.sha), ['a'])
})

test('rows without a day fall back to the date prefix, then unknown', async t => {
  const dir = await withDir(t)
  assert.equal(shardNameOf({ day: '2026-10-01' }), '2026-10-01')
  assert.equal(shardNameOf({ date: '2024-07-09T12:00:00Z' }), '2024-07-09')
  assert.equal(shardNameOf({}), 'unknown')

  await saveChangelog(dir, doc([{ sha: 'x', date: '2024-07-09T12:00:00Z', summary: 'no day key' }, { sha: 'y', summary: 'no date' }]))
  assert.deepEqual((await readdir(join(dir, 'changelog'))).sort(), ['2024-07-09.json', 'unknown.json'])
  assert.equal((await loadChangelog(dir)).entries.length, 2)
})

test('changelogBytes counts the manifest plus every shard', async t => {
  const dir = await withDir(t)
  await saveChangelog(dir, doc([entry('a', '2026-09-30')]))
  const manifest = (await readFile(join(dir, 'changelog.json'))).length
  const shard = (await readFile(join(dir, 'changelog/2026-09-30.json'))).length
  assert.equal(await changelogBytes(dir), manifest + shard)
})

test('splitEntries and sortEntries keep their published order', () => {
  const by = splitEntries([entry('b', '2026-09-30'), entry('a', '2026-09-30'), entry('c', '2026-10-01')])
  assert.deepEqual([...by.keys()], ['2026-09-30', '2026-10-01'])
  assert.deepEqual(by.get('2026-09-30').map(e => e.sha), ['b', 'a'])
  assert.deepEqual(sortEntries([entry('b', '2026-09-30'), entry('a', '2026-09-30')]).map(e => e.sha), ['a', 'b'])
})
