// generator/test/mergedata.test.mjs - the two-writer merge rules.
//
// Regression shape: the backfill loop holds a changelog.json snapshot across
// minutes of LLM calls, while the hourly analyze pass pushes a newer headSha.
// Writing the snapshot back reverted generatedAt/headSha, so the deployed site
// reported "[stale 184m]" forever even though git kept receiving commits.
// Merges must be commutative: neither writer's push may undo the other's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeChangelog, mergeAiCache, mergeSyncState, capturePendingWrites, persistMerged } from '../lib/mergedata.mjs'
import { syncReason, syncStaleMs, DEFAULT_SYNC_STALE_MIN } from '../lib/sync.mjs'
import { withLock, writeJson, shortHash, eli5Source } from '../lib/util.mjs'

const withEli5 = (e, text) => ({ ...e, eli5: { text, v: 1, src: shortHash(eli5Source(e)) } })

const entry = (sha, date, ai = null) => ({ sha, date, kind: 'sync', ...(ai ? { ai } : {}) })

const doc = (generatedAt, headSha, entries) => ({
  version: 1, generatedAt, headSha, counts: { entries: entries.length }, entries
})

test('mergeChangelog keeps the newer headSha and stamp from the analyze pass', () => {
  // Snapshot the backfill loop carried (old stamp) + what disk has now (new).
  const ours = doc('2026-09-14T11:21:46.000Z', '44616e1e8c', [entry('a', '2026-09-14T10:00:00Z')])
  const disk = doc('2026-09-14T14:30:00.000Z', '69030b56b3', [
    entry('a', '2026-09-14T10:00:00Z'),
    entry('b', '2026-09-14T13:00:00Z')
  ])
  const merged = mergeChangelog(ours, disk)
  assert.equal(merged.headSha, '69030b56b3', 'headSha must not regress')
  assert.equal(merged.generatedAt, '2026-09-14T14:30:00.000Z', 'generatedAt must not regress')
  assert.deepEqual(merged.entries.map(e => e.sha), ['a', 'b'], 'union of entries')
})

test('mergeChangelog grafts this cycle’s AI summaries onto the newer document', () => {
  const ai = { v: 5, title: 'Adds gemini-3', summary: 'Swaps the default model.' }
  const ours = doc('2026-09-14T11:21:46.000Z', '44616e1e8c', [entry('a', '2026-09-14T10:00:00Z', ai)])
  const disk = doc('2026-09-14T14:30:00.000Z', '69030b56b3', [
    entry('a', '2026-09-14T10:00:00Z'),
    entry('b', '2026-09-14T13:00:00Z')
  ])
  const merged = mergeChangelog(ours, disk)
  assert.deepEqual(merged.entries.find(e => e.sha === 'a').ai, ai)
  assert.equal(merged.headSha, '69030b56b3')
})

test('mergeChangelog is commutative (commit order cannot lose data)', () => {
  const ours = doc('2026-09-14T11:21:46.000Z', '44616e1e8c', [
    entry('a', '2026-09-14T10:00:00Z', { v: 5, title: 'A', summary: 'aaa' })
  ])
  const disk = doc('2026-09-14T14:30:00.000Z', '69030b56b3', [
    entry('a', '2026-09-14T10:00:00Z'),
    entry('b', '2026-09-14T13:00:00Z', { v: 5, title: 'B', summary: 'bbb' })
  ])
  const norm = (m) => JSON.stringify({
    head: m.headSha, stamp: m.generatedAt, count: m.entries.length,
    ai: m.entries.map(e => [e.sha, !!e.ai]).sort()
  })
  assert.equal(norm(mergeChangelog(ours, disk)), norm(mergeChangelog(disk, ours)))
})

test('mergeChangelog prefers a higher prompt version, never an empty stub', () => {
  const ours = doc('2026-09-14T14:00:00.000Z', 'h2', [entry('a', 'd1', { v: 5, title: 'new', summary: 'new prompt' })])
  const disk = doc('2026-09-14T13:00:00.000Z', 'h1', [entry('a', 'd1', { v: 3, title: 'old', summary: 'old prompt' })])
  assert.equal(mergeChangelog(ours, disk).entries[0].ai.v, 5)

  // A summary-less entry must not wipe a real one.
  const blank = doc('2026-09-14T15:00:00.000Z', 'h3', [entry('a', 'd1')])
  assert.equal(mergeChangelog(blank, disk).entries[0].ai.title, 'old')
})

test('mergeChangelog tolerates a missing side', () => {
  const d = doc('2026-09-14T14:00:00.000Z', 'h', [entry('a', 'd1')])
  assert.equal(mergeChangelog(d, null), d)
  assert.equal(mergeChangelog(null, d), d)
  assert.equal(mergeChangelog(d, undefined).headSha, 'h')
})

test('mergeAiCache unions keys and prefers a real summary over an error stub', () => {
  const ours = {
    'a:5:p1': { title: 'A', at: '2026-09-14T10:00:00Z' },
    'b:5:p2': { error: 'timeout', at: '2026-09-14T10:00:00Z' }
  }
  const disk = {
    'c:5:p3': { title: 'C', at: '2026-09-14T09:00:00Z' },
    'b:5:p2': { title: 'B recovered', at: '2026-09-14T11:00:00Z' }
  }
  const merged = mergeAiCache(ours, disk)
  assert.deepEqual(Object.keys(merged).sort(), ['a:5:p1', 'b:5:p2', 'c:5:p3'])
  assert.equal(merged['b:5:p2'].title, 'B recovered', 'error stub loses to a real summary')
})

test('mergeAiCache takes the newer write between two real summaries', () => {
  const ours = { 'a:5:p': { title: 'old', at: '2026-09-14T09:00:00Z' } }
  const disk = { 'a:5:p': { title: 'new', at: '2026-09-14T12:00:00Z' } }
  assert.equal(mergeAiCache(ours, disk)['a:5:p'].title, 'new')
  assert.equal(mergeAiCache(disk, ours)['a:5:p'].title, 'new', 'commutative')
})

test('mergeSyncState never moves lastSha backward', () => {
  const fresh = { lastSha: 'new', runs: 3, updatedAt: '2026-09-14T14:00:00Z' }
  const stale = { lastSha: 'old', runs: 2, updatedAt: '2026-09-14T11:00:00Z' }
  assert.equal(mergeSyncState(stale, fresh).lastSha, 'new')
  assert.equal(mergeSyncState(fresh, stale).lastSha, 'new')
})

test('persistMerged re-reads disk and cannot revert a newer analyze result', async () => {
  const DATA = await mkdtemp(join(tmpdir(), 'fb-merge-'))
  const path = `${DATA}/changelog.json`
  const write = (obj) => writeJson(path, obj)
  // Disk was updated by the other writer while this process was working.
  await write(doc('2026-09-14T14:30:00.000Z', '69030b56b3', [entry('a', 'd1'), entry('b', 'd2')]))

  const inMemorySnapshot = doc('2026-09-14T11:21:46.000Z', '44616e1e8c', [
    entry('a', 'd1', { v: 5, title: 'A', summary: 's' })
  ])
  await persistMerged(await capturePendingWrites(DATA, { [path]: inMemorySnapshot }))

  const result = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(result.headSha, '69030b56b3', 'newer head survived the stale write')
  assert.equal(result.generatedAt, '2026-09-14T14:30:00.000Z')
  assert.deepEqual(result.entries.map(e => e.sha), ['a', 'b'], 'entries from disk survived')
  assert.ok(result.entries[0].ai, 'this cycle summary survived')
})

test('capturePendingWrites + persistMerged are a no-op on an empty data dir', async () => {
  const DATA = await mkdtemp(join(tmpdir(), 'fb-empty-'))
  const pending = await capturePendingWrites(DATA)
  assert.deepEqual(pending, {}, 'nothing on disk, nothing to carry')
  await persistMerged(pending)
  assert.deepEqual((await readdir(DATA)), [], 'a quiet cycle must not materialize data files')

  // An override still writes through, so a first-ever run is not blocked.
  await persistMerged(await capturePendingWrites(DATA, {
    [`${DATA}/changelog.json`]: doc('2026-09-14T14:00:00.000Z', 'h', [entry('a', 'd1')])
  }))
  assert.ok((await readdir(DATA)).includes('changelog.json'))
})

test('syncStaleMs honours env and falls back on garbage', () => {
  assert.equal(syncStaleMs({}), DEFAULT_SYNC_STALE_MIN * 60000)
  assert.equal(syncStaleMs({ CHANGELOG_SYNC_STALE_MIN: '10' }), 10 * 60000)
  assert.equal(syncStaleMs({ CHANGELOG_SYNC_STALE_MIN: 'abc' }), DEFAULT_SYNC_STALE_MIN * 60000)
})

test('syncReason fires on an upstream move', () => {
  const now = Date.parse('2026-09-14T14:30:00Z')
  const reason = syncReason({
    head: '69030b56b3335f412cdde0af81e379be2da4a4ce',
    lastSha: '44616e1e8cbc975b693b136b98b301ccc157d7d1',
    generatedAt: '2026-09-14T14:29:00Z', now, staleMs: 45 * 60000
  })
  assert.match(reason, /upstream advanced 44616e1e -> 69030b56/)
})

test('syncReason fires on the 184m idle-upstream stall', () => {
  const now = Date.parse('2026-09-14T14:29:00Z')
  const reason = syncReason({
    head: '44616e1e8c', lastSha: '44616e1e8c',
    generatedAt: '2026-09-14T11:21:46.378Z', now, staleMs: 45 * 60000
  })
  assert.match(reason, /last sync 187m ago exceeded 45m budget/)
})

test('syncReason stays silent when the data is fresh and upstream is idle', () => {
  const now = Date.parse('2026-09-14T14:29:00Z')
  assert.equal(syncReason({
    head: 'abc', lastSha: 'abc', generatedAt: '2026-09-14T14:20:00Z', now, staleMs: 45 * 60000
  }), '')
  // A failed fetch must not trigger a sync on its own.
  assert.equal(syncReason({ head: null, lastSha: 'abc', generatedAt: '2026-09-14T01:00:00Z', now }), '')
})

test('syncReason resyncs on an unreadable timestamp or missing state', () => {
  const now = Date.parse('2026-09-14T14:29:00Z')
  assert.match(syncReason({ head: 'abc', lastSha: null, generatedAt: 'x', now }), /no prior sync/)
  assert.match(syncReason({ head: 'abc', lastSha: 'abc', generatedAt: 'garbage', now }), /unreadable/)
})

test('withLock serializes overlapping runs in one worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-lock-'))
  const lockDir = join(dir, 'generator.lock')
  let firstRelease
  const hold = withLock(lockDir, () => new Promise(r => { firstRelease = r }))
  await new Promise(r => setTimeout(r, 20))
  const second = await withLock(lockDir, async () => 'ran')
  assert.equal(second.acquired, false, 'second run must not enter while held')
  firstRelease()
  await hold
  const third = await withLock(lockDir, async () => 'ran')
  assert.equal(third.acquired, true, 'lock released after the first run')
  assert.equal(third.result, 'ran')
})

test('withLock releases on throw and takes over a stale lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-lock2-'))
  const lockDir = join(dir, 'generator.lock')
  await assert.rejects(() => withLock(lockDir, () => { throw new Error('boom') }).then(() => { throw new Error('should throw') }))
  const after = await withLock(lockDir, async () => 'ok')
  assert.equal(after.acquired, true, 'lock freed after a throwing run')

  // Backdate beyond the stale window: a killed daemon must not wedge the loop.
  const held = await withLock(lockDir, async () => {
    const old = (Date.now() - 60 * 60000) / 1000
    await utimes(lockDir, old, old)
    return 'held'
  })
  assert.equal(held.result, 'held')
  const taken = await withLock(lockDir, async () => 'took over', { staleMs: 30 * 60000 })
  assert.equal(taken.acquired, true)
})

// The plain-English line is produced by the writer that holds the summary, which
// is usually *not* the writer whose document wins the scalars. Losing it in the
// merge would mean paying for the call again; keeping one that explains a
// summary nobody has would be worse than having none.
test('mergeChangelog carries the ELI5 line from whichever side produced it', () => {
  const ai = { v: 5, title: 'Adds gemini-3', summary: 'Swaps the default model.' }
  // Backfill snapshot (older stamp) holds the summary and its ELI5; disk has the
  // entry with neither, because analyze re-derived it.
  const ours = doc('2026-09-14T11:21:46.000Z', 'a1', [withEli5(entry('a', '2026-09-14T10:00:00Z', ai), 'The assistant can use a new model now.')])
  const disk = doc('2026-09-14T14:30:00.000Z', 'b2', [entry('a', '2026-09-14T10:00:00Z')])
  const merged = mergeChangelog(ours, disk)
  assert.match(merged.entries[0].ai.title, /gemini/, 'the summary survives')
  assert.match(merged.entries[0].eli5.text, /new model/, 'the ELI5 survives with it')
  assert.equal(mergeChangelog(disk, ours).entries[0].eli5.text, merged.entries[0].eli5.text,
    'commutative: push order must not decide who keeps their text')
})

test('mergeChangelog keeps the ELI5 that matches the surviving summary', () => {
  const olderAi = { v: 5, title: 'Older', summary: 'An older summary.' }
  const newerAi = { v: 6, title: 'Newer', summary: 'A newer summary.' }
  // The document that wins the entry carries a line explaining a summary that
  // loses; the other side holds a better summary and the line written from it.
  const stalePair = () => ({
    ...entry('a', '2026-09-14T10:00:00Z', olderAi),
    eli5: { text: 'Explains the older summary.', v: 1, src: shortHash(eli5Source({ ai: olderAi })) }
  })
  const freshPair = withEli5(entry('a', '2026-09-14T10:00:00Z', newerAi), 'Explains this summary.')
  const rounds = [
    [doc('2026-09-14T14:30:00.000Z', 'b2', [stalePair()]), doc('2026-09-14T11:21:46.000Z', 'a1', [freshPair])],
    [doc('2026-09-14T11:21:46.000Z', 'a1', [freshPair]), doc('2026-09-14T14:30:00.000Z', 'b2', [stalePair()])]
  ]
  for (const [x, y] of rounds) {
    const m = mergeChangelog(x, y)
    assert.equal(m.entries[0].ai.v, 6, 'the better summary wins')
    assert.match(m.entries[0].eli5.text, /this summary/, 'and the line that explains it follows')
  }
})

test('mergeChangelog is deterministic when two different ELI5 lines are equally stale', () => {
  const ai = { v: 5, title: 'T', summary: 'S' }
  const a = { ...entry('a', '2026-09-14T10:00:00Z', ai), eli5: { text: 'one', v: 1, src: 'aaaaaaaaaaaa' } }
  const b = { ...entry('a', '2026-09-14T10:00:00Z', ai), eli5: { text: 'two', v: 1, src: 'bbbbbbbbbbbb' } }
  const one = mergeChangelog(doc('2026-09-14T14:00:00.000Z', 'x', [a]), doc('2026-09-14T11:00:00.000Z', 'y', [b]))
  const two = mergeChangelog(doc('2026-09-14T11:00:00.000Z', 'y', [b]), doc('2026-09-14T14:00:00.000Z', 'x', [a]))
  assert.equal(one.entries[0].eli5.src, two.entries[0].eli5.src, 'same answer whichever writer pushed first')
})
