// generator/test/mergedata.test.mjs - the two-writer merge rules.
//
// Regression shape: the backfill loop holds a changelog.json snapshot across
// minutes of LLM calls, while the hourly analyze pass pushes a newer headSha.
// Writing the snapshot back reverted generatedAt/headSha, so the deployed site
// reported "[stale 184m]" forever even though git kept receiving commits.
// Merges must be commutative: neither writer's push may undo the other's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeChangelog, mergeAiCache, mergeSyncState, mergeOpenPrs, capturePendingWrites, persistMerged } from '../lib/mergedata.mjs'
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

test('withLock releases on throw and takes over a lock whose owner is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-lock2-'))
  const lockDir = join(dir, 'generator.lock')
  await assert.rejects(() => withLock(lockDir, () => { throw new Error('boom') }).then(() => { throw new Error('should throw') }))
  const after = await withLock(lockDir, async () => 'ok')
  assert.equal(after.acquired, true, 'lock freed after a throwing run')

  // A run killed by Ctrl+C or pkill leaves the directory with a *fresh* mtime,
  // so age cannot tell a dead owner from a live one. Backdating the clock used
  // to be the only way out, and it meant the daemon logged "another run holds
  // the lock" for half an hour after every restart while publishing nothing.
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'owner'), `999999 ${new Date().toISOString()}\n`)
  const taken = await withLock(lockDir, async () => 'took over')
  assert.equal(taken.acquired, true, 'a lock whose owner pid is dead is taken over at once')

  // A live owner is never evicted, however long its batch runs.
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'owner'), `1 ${new Date().toISOString()}\n`)
  const busy = await withLock(lockDir, async () => 'ran while someone else held it')
  assert.equal(busy.acquired, false, 'a live owner keeps the lock')
  assert.equal(busy.result, undefined)
})

// The lock lives in `.cache/generator.lock`, and `.cache/` is created by the
// upstream clone that runs *inside* the critical section. In a workspace with no
// `.cache/` yet -- a fresh CI runner whose cache read missed -- the non-recursive
// mkdir failed with ENOENT, `err.code !== 'EEXIST'` rethrew it, and every cycle
// of the 24/7 relay died before it could clone the directory that would have
// fixed it: an outage that could not heal itself and never left more evidence
// than a log line, while the deployed site went stale.
test('withLock creates its own parent directory in a fresh worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-lock-parent-'))
  const lockDir = join(dir, '.cache', 'generator.lock')
  const first = await withLock(lockDir, async () => 'ran')
  assert.equal(first.acquired, true, 'a missing parent dir must not block the lock')
  assert.equal(first.result, 'ran')
  assert.equal(existsSync(lockDir), false, 'and it is still cleaned up after the run')

  // Contention must still be contention: creating the parent recursively may
  // not turn a held lock into a second winner.
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'owner'), `1 ${new Date().toISOString()}\n`)
  const blocked = await withLock(lockDir, async () => 'ran while a live owner held it')
  assert.equal(blocked.acquired, false, 'a live owner still wins, parent dir or not')
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

// A snapshot taken before the UTC normalization still carries the author's offset,
// and every day page and release window compares those strings. The merge is the
// one choke point both writers pass through, so it is where a stale row gets healed
// rather than re-published.
test('mergeChangelog rewrites an offset timestamp on the way out', () => {
  const stale = { ...entry('a', '2026-09-14T17:25:50-08:00'), day: '2026-09-14', month: '2026-09' }
  const m = mergeChangelog(
    doc('2026-09-15T00:00:00.000Z', 'x', [stale]),
    doc('2026-09-14T21:00:00.000Z', 'y', [entry('b', '2026-09-14T23:00:00Z')]))
  const a = m.entries.find(e => e.sha === 'a')
  assert.equal(a.date, '2026-09-15T01:25:50.000Z')
  assert.equal(a.day, '2026-09-15', 'the row moves to the UTC day it belongs to')
  assert.equal(m.entries[0].sha, 'b', 'which also puts the two rows in the right order')
})

test('mergeOpenPrs: a short CI list cannot erase the daemon’s complete one', () => {
  // The exact regression: CI's page 2 answered HTTP 500, it published 60 rows,
  // and last-writer-wins took /in-flight/ from 116 open back to 60.
  const full = {
    fetchedAt: '2026-09-15T06:00:00.000Z', total: 116,
    prs: Array.from({ length: 116 }, (_, i) => ({ number: i + 1, created: `2026-09-${String((i % 15) + 1).padStart(2, '0')}T00:00:00Z`, title: `PR ${i + 1}` }))
  }
  const short = {
    fetchedAt: '2026-09-15T06:29:00.000Z',
    prs: full.prs.slice(0, 60).map(p => ({ ...p, title: p.title }))
  }
  const m = mergeOpenPrs(short, full)
  assert.equal(m.prs.length, 116, 'the union is kept, not the shorter write')
  assert.equal(m.total, 116)
  assert.ok(!m.partial, 'and the merged list is complete, so it stops retrying')
  const m2 = mergeOpenPrs(full, short)
  assert.equal(m2.prs.length, 116, 'commutative: commit order cannot lose PRs')
})

test('mergeOpenPrs keeps a filled diffstat and preview against a blanker record', () => {
  const rich = {
    fetchedAt: '2026-09-15T06:00:00.000Z', total: 2, prs: [
      { number: 7, created: '2026-09-07T00:00:00Z', additions: 12, deletions: 3, files: 2, hasDiff: true },
      { number: 8, created: '2026-09-08T00:00:00Z', additions: 1, deletions: 0, files: 1, hasDiff: true }
    ]
  }
  // A list-endpoint row: additions is explicitly null, hasDiff absent.
  const lean = {
    fetchedAt: '2026-09-15T07:00:00.000Z', total: 2, prs: [
      { number: 7, created: '2026-09-07T00:00:00Z', title: 'T7', additions: null, deletions: null, files: null },
      { number: 8, created: '2026-09-08T00:00:00Z', title: 'T8', additions: null, deletions: null, files: null }
    ]
  }
  const m = mergeOpenPrs(rich, lean)
  const p7 = m.prs.find(p => p.number === 7)
  assert.equal(p7.additions, 12, 'a newer but blanker record does not erase a known diffstat')
  assert.equal(p7.hasDiff, true, 'and never loses a preview that is on disk')
  assert.equal(p7.title, 'T7', 'new fields still arrive')
  assert.equal(m.fetchedAt, '2026-09-15T07:00:00.000Z', 'the stamp is the fresher one')
})

test('mergeOpenPrs keeps partial set while the union is short of GitHub’s total', () => {
  const a = { fetchedAt: '2026-09-15T06:00:00.000Z', total: 116, partial: true, prs: [{ number: 1, created: '2026-09-01T00:00:00Z' }] }
  const b = { fetchedAt: '2026-09-15T06:30:00.000Z', total: 116, prs: [{ number: 2, created: '2026-09-02T00:00:00Z' }] }
  const m = mergeOpenPrs(a, b)
  assert.equal(m.prs.length, 2)
  assert.equal(m.partial, true, '1 PR of 116 known: the next run must chase the rest')
})

test('mergeOpenPrs: listComplete is the permission to forget, and a short side revokes it', () => {
  const row = (n) => ({ number: n, created: `2026-09-0${n}T00:00:00Z` })
  const complete = { fetchedAt: '2026-09-15T06:00:00.000Z', total: 2, listComplete: true, prs: [row(1), row(2)] }
  const short = { fetchedAt: '2026-09-15T07:00:00.000Z', total: 3, listComplete: false, prs: [row(3)] }
  assert.equal(mergeOpenPrs(complete, short).listComplete, false, 'the short side may have missed a PR: nothing may be deleted on this list')
  assert.equal(mergeOpenPrs(complete, { ...complete, fetchedAt: '2026-09-15T07:00:00.000Z' }).listComplete, true, 'two complete sightings stay complete')
})

test('persistMerged merges open-prs.json rather than overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-prs-'))
  const path = join(dir, 'open-prs.json')
  const full = {
    fetchedAt: '2026-09-15T06:00:00.000Z', total: 3,
    prs: [1, 2, 3].map(n => ({ number: n, created: `2026-09-0${n}T00:00:00Z` }))
  }
  await writeFile(path, JSON.stringify(full))
  // Our process only ever saw two of them; origin holds three.
  await persistMerged({ [path]: { fetchedAt: '2026-09-15T05:00:00.000Z', total: 3, prs: [{ number: 1, created: '2026-09-01T00:00:00Z' }, { number: 2, created: '2026-09-02T00:00:00Z' }] } })
  const out = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(out.prs.map(p => p.number).sort((x, y) => x - y), [1, 2, 3], 'a push cannot drop a PR the other writer found')
})

test('mergeChangelog is deterministic when two different ELI5 lines are equally stale', () => {
  const ai = { v: 5, title: 'T', summary: 'S' }
  const a = { ...entry('a', '2026-09-14T10:00:00Z', ai), eli5: { text: 'one', v: 1, src: 'aaaaaaaaaaaa' } }
  const b = { ...entry('a', '2026-09-14T10:00:00Z', ai), eli5: { text: 'two', v: 1, src: 'bbbbbbbbbbbb' } }
  const one = mergeChangelog(doc('2026-09-14T14:00:00.000Z', 'x', [a]), doc('2026-09-14T11:00:00.000Z', 'y', [b]))
  const two = mergeChangelog(doc('2026-09-14T11:00:00.000Z', 'y', [b]), doc('2026-09-14T14:00:00.000Z', 'x', [a]))
  assert.equal(one.entries[0].eli5.src, two.entries[0].eli5.src, 'same answer whichever writer pushed first')
})
