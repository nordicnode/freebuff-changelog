// generator/test/openprs.test.mjs - the in-flight list must be the *whole* list.
//
// Regression shape: GitHub serves one page per request and caps per_page at 100.
// The fetch asked for 60 and never asked again, so /in-flight/ reported "60
// open" for a repo with 114 -- and the silently missing half were the older PRs,
// the stalled ones that page exists to surface.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchOpenPrs } from '../cli.mjs'

const REPO = 'CodebuffAI/freebuff'
const pr = (n) => ({ number: n, title: `PR ${n}`, html_url: `https://github.com/${REPO}/pull/${n}`, user: { login: 'a' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', draft: false, comments: 0, additions: 1, deletions: 0, changed_files: 1 })

/**
 * Fake GitHub: answers the list endpoint from `counts` (PRs per page) and every
 * per-PR call. Records the URLs it was asked for.
 */
function fakeGithub (counts, { failPage = 0, stats = true, diff = true, refuse = 0 } = {}) {
  const calls = []
  let total = 0
  const pages = counts.map((c) => {
    const list = Array.from({ length: c }, (_, i) => pr(total + i + 1))
    total += c
    return list
  })
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url)
    const accept = opts.headers?.accept || ''
    const u = new URL(url)
    if (u.pathname === `/repos/${REPO}/pulls`) {
      const page = Number(u.searchParams.get('page') || '1')
      if (failPage === page) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) }
      const list = pages[page - 1] || []
      return { ok: true, json: async () => (stats ? list : list.map(({ additions, deletions, changed_files, ...rest }) => rest)) }
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
  assert.ok(calls.every(c => !/[?&]page=3/.test(c)), 'a short page ends the walk')
  assert.ok(calls.filter(c => c.includes('/pulls?')).every(c => /per_page=100/.test(c)), 'per_page is at the API maximum')
  const persisted = JSON.parse(await readFile(join(dir, 'open-prs.json'), 'utf8'))
  assert.equal(persisted.prs.length, 114, 'the cached copy is the full list too')
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
