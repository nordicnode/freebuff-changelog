// generator/test/pushdata.test.mjs - the two-writer push race, end to end.
//
// Reproduces the production shape against a throwaway bare remote: the backfill
// daemon holds a changelog.json snapshot across slow work while the hourly
// analyze pass advances headSha and pushes first. The old code rebased and
// pushed its snapshot anyway, so origin's newer headSha went backward and the
// deployed site kept reporting "[stale Nm]" despite fresh commits. The shared
// push path must converge instead: newer headSha survives, the daemon's
// summaries survive, and nothing is left stranded locally.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitAndPushData, refreshDiffFlags } from '../cli.mjs'
import { mergeChangelog } from '../lib/mergedata.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const entry = (sha, ai = null) => ({ sha, date: `2026-09-14T${ai ? '10' : '12'}:00:00Z`, kind: 'sync', ...(ai ? { ai } : {}) })
const doc = (generatedAt, headSha, entries) => ({
  version: 1, generatedAt, headSha, counts: { entries: entries.length }, entries
})
const writeDoc = async (dir, obj) => {
  await mkdir(`${dir}/data`, { recursive: true })
  await writeFile(`${dir}/data/changelog.json`, JSON.stringify(obj, null, 2) + '\n')
}
const readOriginDoc = (remote, branch = 'main') =>
  JSON.parse(execFileSync('git', ['show', `${branch}:data/changelog.json`], { cwd: remote, encoding: 'utf8', maxBuffer: 1 << 26 }))

async function fixture () {
  const base = await mkdtemp(join(tmpdir(), 'fb-push-'))
  const remote = join(base, 'remote.git')
  git(base, 'init', '--bare', '-b', 'main', remote)

  const seed = join(base, 'seed')
  git(base, 'clone', '-q', remote, seed)
  git(seed, 'config', 'user.email', 'bot@example.com')
  git(seed, 'config', 'user.name', 'bot')
  // The state both writers start from: an old headSha, nothing summarized.
  await writeDoc(seed, doc('2026-09-14T11:21:46.000Z', 'h1', [entry('a'), entry('b')]))
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'seed')
  git(seed, 'push', '-q', 'origin', 'HEAD:main')

  const clone = async (name) => {
    const dir = join(base, name)
    git(base, 'clone', '-q', remote, dir)
    git(dir, 'config', 'user.email', `${name}@example.com`)
    git(dir, 'config', 'user.name', name)
    return dir
  }
  return { base, remote, clone }
}

test('a late backfill push cannot revert a headSha the analyze pass already pushed', async () => {
  const { remote, clone } = await fixture()
  const daemon = await clone('daemon')
  const analyze = await clone('analyze')

  // The analyze pass advances upstream and publishes first.
  await writeDoc(analyze, doc('2026-09-14T14:30:00.000Z', 'h2', [entry('a'), entry('b'), entry('c')]))
  git(analyze, 'add', '-A')
  git(analyze, 'commit', '-qm', 'data: update changelog')
  git(analyze, 'push', '-q', 'origin', 'HEAD:main')

  // The daemon started from the pre-move snapshot and only just finished; its
  // in-memory copy still says h1/11:21 but carries a summary nobody else has.
  const snapshot = doc('2026-09-14T11:21:46.000Z', 'h1', [
    entry('a', { v: 5, title: 'Adds gemini-3', summary: 'Swaps the default model.' }),
    entry('b')
  ])
  await writeDoc(daemon, snapshot)
  const pushed = await commitAndPushData({
    root: daemon,
    dataDir: `${daemon}/data`,
    message: 'data: LLM backfill',
    overrides: { [`${daemon}/data/changelog.json`]: snapshot }
  })
  assert.equal(pushed, true, 'the cycle must converge onto origin and push')

  const landed = readOriginDoc(remote)
  assert.equal(landed.headSha, 'h2', 'headSha moved forward, not back')
  assert.equal(landed.generatedAt, '2026-09-14T14:30:00.000Z', 'the sync timestamp survived')
  assert.deepEqual(landed.entries.map(e => e.sha), ['a', 'b', 'c'], 'no entry was dropped')
  assert.equal(landed.entries[0].ai?.title, 'Adds gemini-3', 'the summary was not lost either')

  // Nothing stranded locally: the daemon clone is flush with origin, so the
  // next cycle cannot collide with an unpushed commit of its own.
  git(daemon, 'fetch', '-q', 'origin', 'main')
  assert.equal(git(daemon, 'rev-list', '--count', 'origin/main..HEAD').trim(), '0')
  assert.equal(git(daemon, 'status', '--porcelain').trim(), '', 'worktree left clean')
})

test('a quiet cycle with no data change pushes nothing', async () => {
  const { clone } = await fixture()
  const daemon = await clone('quiet')
  const disk = JSON.parse(await readFile(`${daemon}/data/changelog.json`, 'utf8'))
  const pushed = await commitAndPushData({
    root: daemon,
    dataDir: `${daemon}/data`,
    message: 'data: LLM backfill',
    overrides: { [`${daemon}/data/changelog.json`]: disk }
  })
  assert.equal(pushed, false)
})

test('mergeChangelog alone still agrees with what the race converges to', () => {
  const ours = doc('2026-09-14T11:21:46.000Z', 'h1', [entry('a', { v: 5, title: 'A', summary: 's' }), entry('b')])
  const origin = doc('2026-09-14T14:30:00.000Z', 'h2', [entry('a'), entry('b'), entry('c')])
  const merged = mergeChangelog(ours, origin)
  assert.equal(merged.headSha, 'h2')
  assert.equal(merged.entries.length, 3)
  assert.equal(merged.entries[0].ai.title, 'A')
})

// "View inline diff" must reflect data/diffs/ on disk. pruneDiffs deletes files
// after 90 days while the row keeps hasDiff: true -- 58 rows did that, each
// toggle fetching a 404 -- and a merged-in row can have a file with no flag, so
// a readable diff nobody can open.
test('refreshDiffFlags reconciles hasDiff with the files actually on disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-diffflags-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  await writeFile(join(dir, 'b'.repeat(40) + '.diff'), 'diff --git a/x b/x\n')
  const pruned = { kind: 'sync', sha: 'a'.repeat(40), hasDiff: true }
  const onDisk = { kind: 'sync', sha: 'b'.repeat(40) }
  const churn = { kind: 'sync', sha: 'c'.repeat(40), noise: true, hasDiff: true }
  const community = { kind: 'community', sha: 'd'.repeat(40) }
  const fixed = refreshDiffFlags([pruned, onDisk, churn, community], dir)
  assert.equal(pruned.hasDiff, undefined, 'a pruned file must not advertise a diff')
  assert.equal(onDisk.hasDiff, true, 'a published diff gets its toggle back')
  assert.equal(churn.hasDiff, true, 'churn rows are not touched (they carry no source diff)')
  assert.equal(community.hasDiff, undefined, 'community rows never had inline diffs')
  assert.equal(fixed, 2)
})

// The push-recovery path used to run a worktree-wide `git reset --hard`: on a
// rejected push whose rebase conflicts, it moved HEAD onto origin and threw away
// every *other* uncommitted file in the repository. That is not a sync failure to
// absorb, it is destroying a human's work — it silently cost an afternoon of
// edits in this repo. Recovery may only touch the derived data this cycle owns.
test('conflicting push recovery never discards unrelated uncommitted work', async () => {
  const { remote, clone } = await fixture()
  const daemon = await clone('conflicted')
  const analyze = await clone('analysis')

  // A tracked file the sync does not own, edited locally and left uncommitted:
  // exactly what the old recovery path deleted.
  await writeFile(`${daemon}/generator-note.txt`, 'work in progress\n')
  git(daemon, 'add', 'generator-note.txt')
  git(daemon, 'commit', '-qm', 'track a file the sync does not own')
  git(daemon, 'push', '-q', 'origin', 'HEAD:main')
  await writeFile(`${daemon}/generator-note.txt`, 'uncommitted edit that must survive\n')
  git(analyze, 'pull', '-q', '--rebase', 'origin', 'main')

  // Both writers then move the same line of the same derived file, so the rebase
  // cannot merge it — which is what drives the recovery branch.
  await writeDoc(analyze, doc('2026-09-14T15:00:00.000Z', 'hA', [entry('a'), entry('b'), entry('c')]))
  git(analyze, 'add', '-A')
  git(analyze, 'commit', '-qm', 'data: update changelog')
  git(analyze, 'push', '-q', 'origin', 'HEAD:main')

  const snapshot = doc('2026-09-14T11:21:46.000Z', 'hD', [
    entry('a', { v: 5, title: 'Adds gemini-3', summary: 'Swaps the default model.' }),
    entry('b')
  ])
  await writeDoc(daemon, snapshot)
  const pushed = await commitAndPushData({
    root: daemon,
    dataDir: `${daemon}/data`,
    message: 'data: LLM backfill',
    overrides: { [`${daemon}/data/changelog.json`]: snapshot }
  })
  assert.equal(pushed, true, 'the cycle still converges onto origin and pushes')
  assert.equal(await readFile(`${daemon}/generator-note.txt`, 'utf8'), 'uncommitted edit that must survive\n',
    'recovery must not reset files the sync does not own')

  const landed = readOriginDoc(remote)
  assert.ok(landed.entries.some(e => e.sha === 'c'), 'the other writer keeps its entries')
  assert.equal(landed.headSha, 'hA', 'and origin stays authoritative for headSha through the recovery')
  assert.equal(landed.entries.find(e => e.sha === 'a').ai?.title, 'Adds gemini-3', 'this cycle still lands its work')
})
