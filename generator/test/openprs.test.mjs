// generator/test/openprs.test.mjs - the in-flight list must be the *whole* list,
// and the count on the page must be GitHub's, not ours.
//
// Three regressions, all the same symptom ("60 open" on a repo with 116):
//   1. the fetch asked for 60 per page and never asked again (per_page caps at 100);
//   2. the walk stopped at a *short* page -- GitHub answers with fewer items than
//      per_page under load while still pointing at the rest with Link: rel="next"
//      -- and prunePrDiffs then deleted the previews of the PRs it never mentioned;
//   3. the hourly CI backstop, whose page 2 answered HTTP 500, pushed its 60 rows
//      over the daemon's complete 116, because open-prs.json was last-writer-wins.
// So the fake below serves real Link headers, and these tests cover the walk, the
// union-over-cache rule for a short list, the merge-time merge, the throttle that
// keeps the count minutes-fresh without hammering the API, and the incremental
// decoration that makes a refresh cheap enough to afford.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchOpenPrs, prunePrDiffs } from '../cli.mjs'

const REPO = 'CodebuffAI/freebuff'
const pr = (n) => ({ number: n, title: `PR ${n}`, html_url: `https://github.com/${REPO}/pull/${n}`, user: { login: 'a' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', draft: false, comments: 0, additions: 1, deletions: 0, changed_files: 1 })

const LIST_URL = `https://api.github.com/repos/${REPO}/pulls`

/** Link header in GitHub's shape: rel="next" while pages remain, rel="last" whose
 *  page number is the count when per_page=1. `noNext` simulates the response that
 *  truncates *and* loses the pointer -- the nastier failure, caught by the total. */
function linkHeader (page, perPage, lastPageNo, { noNext = false } = {}) {
  const at = (n) => `${LIST_URL}?state=open&sort=created&direction=desc&per_page=${perPage}&page=${n}`
  const rels = []
  if (!noNext && page < lastPageNo) rels.push(`<${at(page + 1)}>; rel="next"`)
  rels.push(`<${at(lastPageNo)}>; rel="last"`)
  rels.push(`<${at(1)}>; rel="first"`)
  return { get: (n) => (String(n).toLowerCase() === 'link' ? rels.join(', ') : null) }
}

/**
 * Fake GitHub: answers the list endpoint from `counts` (PRs per page) and every
 * per-PR call, with real Link headers. `openTotal` overrides how many PRs GitHub
 * says are open, which is how a short page that lost its next link is caught.
 */
function fakeGithub (counts, { failPage = 0, stats = true, diff = true, refuse = 0, openTotal = null, noNext = false } = {}) {
  const calls = []
  let total = 0
  const pages = counts.map((c) => {
    const list = Array.from({ length: c }, (_, i) => pr(total + i + 1))
    total += c
    return list
  })
  const all = pages.flat()
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url)
    const accept = opts.headers?.accept || ''
    const u = new URL(url)
    if (u.pathname === `/repos/${REPO}/pulls`) {
      const perPage = Number(u.searchParams.get('per_page') || '30')
      const page = Number(u.searchParams.get('page') || '1')
      const last = Math.max(1, openTotal != null ? Math.ceil(openTotal / perPage) : Math.ceil(all.length / perPage))
      if (failPage === page && perPage !== 1) return { ok: false, status: 500, headers: linkHeader(page, perPage, last), json: async () => ({ message: 'boom' }) }
      // The per_page=1 probe exists only to read the header; any one row will do.
      const list = perPage === 1 ? all.slice(0, 1) : (pages[page - 1] || [])
      return {
        ok: true,
        headers: linkHeader(page, perPage, last, { noNext }),
        json: async () => (stats ? list : list.map(({ additions, deletions, changed_files, ...rest }) => rest))
      }
    }
    const one = /\/pulls\/(\d+)$/.exec(u.pathname)
    if (one) {
      if (refuse) return { ok: false, status: refuse, json: async () => ({ message: 'abuse' }), text: async () => '' }
      if (accept.includes('diff')) {
        return diff ? { ok: true, text: async () => `diff --git a/x b/x\n+++ b/x\n+line ${one[1]}\n` } : { ok: false, status: 403, text: async () => '' }
      }
      return { ok: true, json: async () => ({ additions: 7, deletions: 3, changed_files: 2, comments: 5 }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetchImpl, calls, total }
}

const tmpData = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-prs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('open PR list is followed across pages, not truncated to one', async (t) => {
  const dir = await tmpData(t)
  const { fetchImpl, calls, total } = fakeGithub([100, 14])
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 114, 'all 114 open PRs, not the first page')
  assert.equal(total, 114)
  assert.ok(calls.some(c => /[?&]page=2/.test(c)), 'page 2 was requested')
  assert.ok(calls.every(c => !/[?&]page=3/.test(c)), 'no page is fetched after the last one')
  assert.ok(calls.filter(c => /\/pulls\?/.test(c) && !/per_page=1\b/.test(c)).every(c => /per_page=100/.test(c)), 'the walk runs at the API maximum per_page')
  assert.ok(calls.some(c => /per_page=1\b/.test(c)), 'the count is checked against GitHub, not our own arithmetic')
  const persisted0 = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted0.total, 114, 'the authoritative count is stored with the list')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted.prs.length, 114, 'the cached copy is the full list too')
  assert.equal(persisted.listComplete, true, 'and it says so, which is what licenses pruning')
})

test('the stored count is re-checked within minutes, and never served blind for hours', async (t) => {
  const dir = await tmpData(t)
  const { fetchImpl, calls } = fakeGithub([3])
  const stamp = async (minsAgo) => {
    await writeFile(join(dir, 'open-prs.json'), JSON.stringify({
      fetchedAt: new Date(Date.now() - minsAgo * 60000).toISOString(), total: 3,
      prs: [1, 2, 3].map(n => pr(n)).map(p => ({ number: p.number, title: p.title, created: p.created_at, updated: p.updated_at, additions: 1, deletions: 0, files: 1, hasDiff: true }))
    }))
  }
  await stamp(1)
  assert.equal((await fetchOpenPrs({ fetchImpl, dataDir: dir })).length, 3)
  assert.equal(calls.length, 0, 'a list one minute old is not worth a call')
  await stamp(20)
  await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.ok(calls.length > 0, 'twenty minutes old is: the count on the page is never hours stale')
})

test('a complete walk drops a PR that merged upstream', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'open-prs.json'), JSON.stringify({
    fetchedAt: new Date(Date.now() - 20 * 60000).toISOString(), total: 3,
    prs: [1, 2, 3].map(n => ({ number: n, title: `PR ${n}`, created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z' }))
  }))
  const { fetchImpl } = fakeGithub([2])
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.deepEqual(prs.map(p => p.number), [1, 2], 'the fresh complete list is authoritative: a closed PR leaves')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.ok(!persisted.partial, 'and a walk that finished is not marked partial, so pruning may run')
  assert.equal(persisted.listComplete, true)
})

test('an unchanged PR costs no per-PR call: the steady list is nearly free', async (t) => {
  const dir = await tmpData(t)
  const { mkdir, writeFile: wf } = await import('node:fs/promises')
  await mkdir(join(dir, 'pr-diffs'), { recursive: true })
  await wf(join(dir, 'pr-diffs/1.diff'), 'diff --git a/x b/x\n')
  await wf(join(dir, 'pr-diffs/2.diff'), 'diff --git a/x b/x\n')
  await writeFile(join(dir, 'open-prs.json'), JSON.stringify({
    fetchedAt: new Date(Date.now() - 20 * 60000).toISOString(), total: 2,
    prs: [1, 2].map(n => ({ number: n, title: `PR ${n}`, created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z', additions: 9, deletions: 9, files: 9, hasDiff: true }))
  }))
  // stats: false -- the list endpoint answers additions: null, so a naive pass
  // would pay two calls per PR again on every single refresh.
  const { fetchImpl, calls } = fakeGithub([2], { stats: false })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.deepEqual(prs.map(p => p.additions), [9, 9], 'the known diffstat is carried forward')
  assert.equal(calls.filter(c => /\/pulls\/\d+$/.test(c)).length, 0, 'and costs nothing to keep')
})

test('a pushed PR gets its preview refetched, its stale diffstat dropped', async (t) => {
  const dir = await tmpData(t)
  const { mkdir, writeFile: wf, readFile: rf } = await import('node:fs/promises')
  await mkdir(join(dir, 'pr-diffs'), { recursive: true })
  await wf(join(dir, 'pr-diffs/1.diff'), 'diff --git a/x b/x\n+++ b/x\n+old\n')
  await writeFile(join(dir, 'open-prs.json'), JSON.stringify({
    fetchedAt: new Date(Date.now() - 20 * 60000).toISOString(), total: 1,
    prs: [{ number: 1, title: 'PR 1', created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z', additions: 1, deletions: 0, files: 1, hasDiff: true }]
  }))
  // Same PR, newer head, and the list endpoint's shape: no diffstat at all.
  const { additions, deletions, changed_files, ...base } = pr(1)
  const row = { ...base, updated_at: '2026-09-05T00:00:00Z' }
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url)
    const accept = opts.headers?.accept || ''
    if (u.pathname === `/repos/${REPO}/pulls`) {
      const perPage = Number(u.searchParams.get('per_page') || '30')
      return { ok: true, headers: linkHeader(1, perPage, 1), json: async () => [row] }
    }
    if (/\/pulls\/1$/.test(u.pathname)) {
      return accept.includes('diff')
        ? { ok: true, text: async () => 'diff --git a/x b/x\n+++ b/x\n+new\n' }
        : { ok: true, json: async () => ({ additions: 40, deletions: 5, changed_files: 3, comments: 8 }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs[0].additions, 40, 'a newer head means the old numbers are not its numbers any more')
  assert.match(await rf(join(dir, 'pr-diffs/1.diff'), 'utf8'), /\+new/, 'and the preview on disk is replaced')
})

test('a later page failing keeps the pages already fetched', async (t) => {
  const dir = await tmpData(t)
  const { fetchImpl } = fakeGithub([100, 100], { failPage: 2 })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 100, 'page 1 is still true, so it is kept')
})

test('an immediate failure falls back to the cache', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'open-prs.json'), JSON.stringify({
    fetchedAt: new Date().toISOString(),
    prs: [pr(1), pr(2)]
  }))
  const { fetchImpl } = fakeGithub([10], { failPage: 1 })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 2, 'the last good list beats an outage')
})

// Unauthenticated, GitHub allows 60 calls/hr and trips abuse detection long
// before that, so the per-PR decoration runs on a budget and the list itself
// (one call per page) is what must never be truncated.
test('per-PR stats and diff previews are filled for every page', async (t) => {
  const dir = await tmpData(t)
  process.env.CHANGELOG_PR_CALLS = '500'
  t.after(() => { delete process.env.CHANGELOG_PR_CALLS })
  const { fetchImpl } = fakeGithub([100, 14], { stats: false })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 114)
  assert.ok(prs.every(p => p.additions === 7), 'the list endpoint omits stats, so each PR is asked for them')
  assert.ok(prs.every(p => p.hasDiff), 'every PR, including the second page, got a preview')
  assert.match(await readFile(join(dir, 'pr-diffs/114.diff'), 'utf8'), /^diff --git.*\+line 114\s*$/s,
    'the newest-tail PR preview is on disk, not just the first 60')
})

test('the per-PR fan-out stays inside its budget and marks the list partial', async (t) => {
  const dir = await tmpData(t)
  process.env.CHANGELOG_PR_CALLS = '25'
  t.after(() => { delete process.env.CHANGELOG_PR_CALLS })
  const { fetchImpl, calls } = fakeGithub([100, 14], { stats: false })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 114, 'the count never depends on the decoration budget')
  const perPr = calls.filter(c => /\/pulls\/\d+$/.test(new URL(c).pathname))
  assert.equal(perPr.length, 25, 'exactly the budget, not 228 calls against a 60/hr API')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted.partial, true, 'a budgeted-out run is refreshed in minutes, not hours')
})

test('a token lifts the decoration budget to finish the list in one pass', async (t) => {
  const dir = await tmpData(t)
  process.env.GITHUB_TOKEN = 'ghp_test'
  t.after(() => { delete process.env.GITHUB_TOKEN })
  const { fetchImpl, calls } = fakeGithub([100, 14], { stats: false })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  const perPr = calls.filter(c => /\/pulls\/\d+$/.test(new URL(c).pathname))
  assert.equal(perPr.length, 228, '114 diffs + 114 stats, unthrottled: 5,000 calls/hr is the authenticated ceiling')
  assert.ok(prs.every(p => p.hasDiff && p.additions === 7))
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.ok(!persisted.partial, 'a finished list is not re-fetched for half an hour')
})

test('a short page that still points at the next one is followed, not treated as the end', async (t) => {
  // The exact shape that republished "60 open": GitHub answers 60 rows for a
  // per_page=100 request under load, and keeps saying there is more.
  const dir = await tmpData(t)
  process.env.CHANGELOG_PR_CALLS = '500'
  t.after(() => { delete process.env.CHANGELOG_PR_CALLS })
  const { fetchImpl, calls } = fakeGithub([60, 56])
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 116, '116 open PRs, not the 60 that came back first')
  assert.ok(calls.some(c => /[?&]page=2/.test(c)), 'the next link was followed even though page 1 was short')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted.total, 116)
  assert.ok(!persisted.partial, 'and the run knows it finished')
})

test('a truncated list never replaces a longer one, and the count cannot go backwards', async (t) => {
  const dir = await tmpData(t)
  process.env.CHANGELOG_PR_CALLS = '500'
  t.after(() => { delete process.env.CHANGELOG_PR_CALLS })
  const known = Array.from({ length: 116 }, (_, i) => pr(i + 1))
  await writeFile(join(dir, 'open-prs.json'), JSON.stringify({
    fetchedAt: new Date(Date.now() - 7 * 3600000).toISOString(), prs: known
  }))
  // 60 rows, no next link, but GitHub still says 116 are open: the short answer
  // is a failure to look, not a smaller repo.
  const { fetchImpl } = fakeGithub([60], { openTotal: 116, noNext: true })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 116, 'the 56 already-known PRs are kept')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted.total, 116, 'the authoritative count is published with it')
  assert.equal(persisted.partial, true, 'and the run is marked unfinished, so it retries in minutes')
})

test('a short list prunes nothing: previews of unmentioned PRs survive', async (t) => {
  const dir = await tmpData(t)
  const { mkdir, writeFile: wf, readdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'pr-diffs'), { recursive: true })
  await wf(join(dir, 'pr-diffs/7.diff'), 'diff')
  await wf(join(dir, 'pr-diffs/8.diff'), 'diff')
  const listed = [{ number: 7 }]
  assert.equal(await prunePrDiffs(listed, { listComplete: false }, dir), 0, 'a short list is not evidence that a PR closed')
  assert.equal(await prunePrDiffs(listed, null, dir), 0, 'and neither is a list whose shape we do not recognise')
  assert.equal((await readdir(join(dir, 'pr-diffs'))).length, 2)
  assert.equal(await prunePrDiffs(listed, { listComplete: true }, dir), 1, 'a walk that reached GitHub\'s count still prunes, as it should')
  assert.deepEqual(await readdir(join(dir, 'pr-diffs')), ['7.diff'])
  // The common unauthenticated case: every PR listed (so pruning is safe) but the
  // per-PR budget ran out (so the run is partial). The two flags must not be
  // conflated, or previews of PRs merged weeks ago accumulate forever.
  await wf(join(dir, 'pr-diffs/9.diff'), 'diff')
  assert.equal(await prunePrDiffs(listed, { listComplete: true, partial: true }, dir), 1, 'partial decoration does not block pruning')
})

test('a refusal stops the remaining per-PR calls at once', async (t) => {
  const dir = await tmpData(t)
  process.env.CHANGELOG_PR_CALLS = '500'
  t.after(() => { delete process.env.CHANGELOG_PR_CALLS })
  const { fetchImpl, calls } = fakeGithub([100, 14], { stats: false, refuse: 403 })
  const prs = await fetchOpenPrs({ fetchImpl, dataDir: dir })
  assert.equal(prs.length, 114, 'a refused decoration pass still publishes the list')
  const perPr = calls.filter(c => /\/pulls\/\d+$/.test(new URL(c).pathname))
  assert.ok(perPr.length <= 4, `breaker tripped after ${perPr.length} calls, not one per PR`)
  assert.ok(prs.every(p => !p.hasDiff), 'nothing is claimed as previewable that was not fetched')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted.partial, true)
})
