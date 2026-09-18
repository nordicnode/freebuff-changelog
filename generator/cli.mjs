// generator/cli.mjs - entrypoint: generate (analyze upstream -> data/) and
// build (data/ → dist/ static site).
//
//   node generator/cli.mjs generate [--repo URL] [--full]
//   node generator/cli.mjs build
//   node generator/cli.mjs preview [port]
import { mkdir, readFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, readJson, writeJson, writeText, log, ymd, toUtc, normalizeDate, pruneDiffs, pool, withLock } from './lib/util.mjs'
import { capturePendingWrites, persistMerged, mergeOpenPrs } from './lib/mergedata.mjs'
import {
  listCommits, isSyncCommit, analyzeSyncCommit, analyzeCommunityCommit,
  extractCleanDiff, churnLabel, testLabel, SYNC_SUBJECT, TEST_RE, extractRawDiff, EMPTY_TREE, commitNatureOf } from './lib/analyze.mjs'
import { enrichWithLlm, enrichEli5, eli5Eligible, eli5Done, llmConfigured, PROMPT_V } from './lib/llm.mjs'
import { syncReason, syncStaleMs } from './lib/sync.mjs'
import { buildSite } from './lib/site.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(resolve(ROOT, '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(resolve(ROOT, '.env'))
}
const DATA = resolve(ROOT, 'data')
const CACHE = resolve(ROOT, '.cache')
const REPO_DIR = resolve(CACHE, 'freebuff')
const REPO_URL = process.env.FREEBUFF_REPO || 'https://github.com/CodebuffAI/freebuff.git'
const META = { repoUrl: 'https://github.com/CodebuffAI/freebuff', compareUrl: 'https://github.com/CodebuffAI/freebuff/compare' }
const LOCK = resolve(CACHE, 'generator.lock')

// Patch for LLM summarization: clean diff (lockfiles + pure test files
// excluded), matching what the prompt claims. Single source for both
// generate and catch-up paths.
// Every entry has a base to diff from: sync rows carry the snapshot parent the
// analyze pass recorded, community rows have their own commit parent, and a root
// commit diffs against the empty tree.
async function baseShaFor (e) {
  if (e.prevSha) return e.prevSha
  const parent = (await git(['rev-parse', '--verify', '--quiet', `${e.sha}^`], REPO_DIR, { allowFail: true }))?.trim()
  return parent || EMPTY_TREE
}

// Patch for LLM summarization: the clean diff (lockfiles + pure test hunks
// excluded), matching what the prompt claims. Single source for both the generate
// and catch-up paths.
async function llmPatchFor (e) {
  const base = await baseShaFor(e)
  // Test files are stripped from prompts to keep them about shipped behavior --
  // except for test-only commits, where the tests *are* the change. Excluding
  // them there handed the queue an empty patch, so those rows could never be
  // summarized and the backlog counter never reached zero.
  const clean = await extractCleanDiff(REPO_DIR, base, e.sha, 250000, !e.testOnly)
  if (clean.trim()) return clean
  // Stale entries built before testOnly existed (or with narrower TEST_RE)
  // carry no flag, so the exclusion above empties their patch. Retry without
  // the test exclusion before giving up; churn rows stay empty either way.
  if (!e.testOnly) {
    const incl = await extractCleanDiff(REPO_DIR, base, e.sha, 250000, false)
    if (incl.trim()) return incl
  }
  // A churn row's entire change IS the lockfile, so the clean form is empty by
  // construction. CHANGELOG_LLM_CHURN=1 sends the raw diff instead; off by
  // default because "dependency versions moved" is what the deterministic label
  // already says, and it costs ~1,900 calls to be told it again.
  return e.noise && process.env.CHANGELOG_LLM_CHURN === '1'
    ? extractRawDiff(REPO_DIR, base, e.sha, 50000)
    : ''
}

// The text stored at data/diffs/<sha>.diff, i.e. what "View inline diff" opens.
// Same clean form for real changes; a churn row keeps its lockfile hunks, or the
// toggle would fetch an empty file.
async function storedDiffFor (e) {
  const base = await baseShaFor(e)
  const clean = await extractCleanDiff(REPO_DIR, base, e.sha)
  return clean.trim() ? clean : extractRawDiff(REPO_DIR, base, e.sha)
}

// ---------------------------------------------------------------------------

async function ensureRepo () {
  await mkdir(CACHE, { recursive: true })
  if (!existsSync(resolve(REPO_DIR, '.git'))) {
    log('cloning freebuff (single branch)…')
    await git(['clone', '--single-branch', '--no-tags', '--no-checkout', REPO_URL, REPO_DIR], ROOT)
  }
  await git(['fetch', '--force', 'origin', 'main'], REPO_DIR, { allowFail: false })
  const head = (await git(['rev-parse', 'origin/main'], REPO_DIR)).trim()
  return head
}

/**
 * Open pull requests, with per-PR stats and a truncated diff preview.
 *
 * Three bugs have made /in-flight/ under-report, all of them the same mistake --
 * treating the rows that happened to arrive as the whole truth:
 *   1. asking for 60 per page and never asking again (GitHub caps per_page at 100);
 *   2. stopping at a short page. Under load or abuse detection GitHub hands back
 *      fewer items than `per_page` and *still* points at the rest with
 *      `Link: rel="next"`. A 116-PR repo was published as 60 that way, and
 *      `prunePrDiffs` then deleted the previews of the 56 PRs never mentioned;
 *   3. last-writer-wins between the two publishers of data/open-prs.json -- the
 *      local daemon and the hourly CI backstop. CI's HTTP 500 on page 2 pushed 60
 *      rows over the daemon's complete 116 the next morning.
 *
 * So: the walk follows Link headers; completeness is judged against GitHub's own
 * count (one `per_page=1` request, whose `rel="last"` page number *is* the number
 * of open PRs) rather than against our arithmetic; a short walk unions over the
 * stored list instead of replacing it; a partial list prunes nothing; and
 * `mergeOpenPrs` applies the same union rule at commit time, so whichever writer
 * pushes last can only ever add to what the other found. The count is refreshed
 * every few minutes, not every six hours -- see PR_REFRESH_MIN.
 *
 * `fetchImpl`/`dataDir` are injectable because this is the only part of the
 * pipeline that talks to a live third party, and these rules need tests rather
 * than an outage to notice them.
 */
export const lastDiskFetchedMap = new Map()
export const lastCheckTimeMap = new Map()

export function prsEqual (cachedDoc, newPrs, total, complete, partial) {
  if (!cachedDoc || !cachedDoc.fetchedAt) return false
  if (Boolean(cachedDoc.listComplete) !== Boolean(complete)) return false
  if (Boolean(cachedDoc.partial) !== Boolean(partial)) return false
  if ((cachedDoc.total ?? null) !== (total ?? null)) return false
  const oldPrs = cachedDoc.prs || []
  if (oldPrs.length !== newPrs.length) return false
  for (let i = 0; i < newPrs.length; i++) {
    const o = oldPrs[i]
    const n = newPrs[i]
    if (o.number !== n.number || o.updated !== n.updated || o.title !== n.title ||
        o.draft !== n.draft || o.comments !== n.comments || o.reviewComments !== n.reviewComments ||
        o.additions !== n.additions || o.deletions !== n.deletions || o.files !== n.files ||
        Boolean(o.hasDiff) !== Boolean(n.hasDiff) || o.reviewState !== n.reviewState) {
      return false
    }
    if (JSON.stringify(o.labels || []) !== JSON.stringify(n.labels || [])) return false
    if (JSON.stringify(o.commitsList || null) !== JSON.stringify(n.commitsList || null)) return false
    if (JSON.stringify(o.commentsList || null) !== JSON.stringify(n.commentsList || null)) return false
  }
  return true
}

export async function fetchOpenPrs ({ fetchImpl = globalThis.fetch, dataDir = DATA, force = false } = {}) {
  const PR_PER_PAGE = 100
  // 10 pages is 1,000 open PRs. Past that the list itself is the story, and
  // walking further would cost a call per page for no extra truth.
  const PR_MAX_PAGES = 10
  // Without a token GitHub allows 60 calls/hour and trips abuse detection well
  // before that. One call per PR for its stats plus one for its diff is 232
  // calls for 116 PRs, and most of them came back 403 -- degraded to nothing,
  // silently, every run. So the decoration gets a budget, and the run stops
  // asking the moment the API says no. A token lifts the ceiling to 5,000/hour,
  // which is enough to finish a list of this size in one pass.
  const PR_CALL_BUDGET = Number(process.env.CHANGELOG_PR_CALLS) ||
    (process.env.GITHUB_TOKEN ? 500 : 25)
  // How old the stored list may get before the count on the page stops being
  // trusted. The watch loop wakes every 30s; a 2-minute cadence ensures new
  // PRs appear quickly without tripping rate limits.
  const PR_REFRESH_MIN = Number(process.env.CHANGELOG_PR_REFRESH_MIN) || 2
  const LIST = 'https://api.github.com/repos/CodebuffAI/freebuff/pulls'
  const linkHeader = (res) => { try { return res?.headers?.get?.('link') || '' } catch (_) { return '' } }
  const nextUrl = (res) => /<([^>]+)>;\s*rel="next"/.exec(linkHeader(res))?.[1] || null
  const lastPage = (res) => Number(/[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(linkHeader(res))?.[1]) || null
  const headers = { 'user-agent': 'freebuff-changelog', accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const get = (url) => fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) })
  // GitHub's own count, from one `per_page=1` request: with one row per page the
  // `rel="last"` page number *is* the number of open PRs. Never derived from the
  // rows we happened to receive -- that is the arithmetic that reported 60.
  const probeTotal = async () => {
    try {
      const res = await get(`${LIST}?state=open&sort=created&direction=desc&per_page=1`)
      return res.ok ? lastPage(res) : null
    } catch (_) { return null }
  }
  try {
    const raw = await readJson(`${dataDir}/open-prs.json`, null)
    const cached = Array.isArray(raw) ? { prs: raw } : raw
    const cachedPrs = cached?.prs || []
    const prevByNum = new Map(cachedPrs.map(p => [p.number, p]))

    const currentDiskFetched = cached?.fetchedAt || null
    const prevDiskFetched = lastDiskFetchedMap.get(dataDir)
    if (currentDiskFetched !== prevDiskFetched) {
      lastDiskFetchedMap.set(dataDir, currentDiskFetched)
      lastCheckTimeMap.set(dataDir, currentDiskFetched ? Date.parse(currentDiskFetched) : 0)
    }
    const lastChecked = lastCheckTimeMap.get(dataDir) || 0
    const age = lastChecked ? Date.now() - lastChecked : Infinity
    if (!force && cachedPrs.length && age < PR_REFRESH_MIN * 60000) return cachedPrs

    lastCheckTimeMap.set(dataDir, Date.now())

    let total = await probeTotal()
    const prs = []
    let stoppedEarly = false
    let page = 0
    let url = `${LIST}?state=open&sort=created&direction=desc&per_page=${PR_PER_PAGE}`
    for (; page < PR_MAX_PAGES && url; page++) {
      const res = await get(url)
      const batch = res.ok ? await res.json() : null
      if (!Array.isArray(batch)) {
        // Silent is the one thing this must not be: an empty /in-flight/ page
        // otherwise looks like a quiet repo rather than a refused call.
        if (!res.ok) {
          log(`open PR list page ${page + 1}: HTTP ${res.status}${res.status === 403 || res.status === 429 ? ` (rate limited${process.env.GITHUB_TOKEN ? '' : ', no GITHUB_TOKEN set'})` : ''}${cachedPrs.length ? `: keeping the ${cachedPrs.length} cached PRs` : ': no cached list to fall back on'}`)
        }
        stoppedEarly = true
        break
      }
      // The probe can be skipped when a repo fits in one page and the caller
      // asked for all of it; the page header says the same thing for free.
      if (total == null) total = lastPage(res)
      prs.push(...batch.map(p => ({
        number: p.number, title: p.title, url: p.html_url, author: p.user?.login,
        created: p.created_at, updated: p.updated_at, draft: p.draft,
        comments: p.comments ?? 0,
        reviewComments: p.review_comments ?? 0,
        additions: p.additions, deletions: p.deletions, files: p.changed_files,
        labels: (p.labels || []).map(l => ({
          name: typeof l === 'string' ? l : l.name,
          color: (typeof l === 'object' && l.color) ? l.color : '6e7681',
          description: (typeof l === 'object' && l.description) ? l.description : ''
        }))
      })))
      // The next link, not the page length, decides whether there is more to come.
      const next = nextUrl(res)
      if (next && !batch.length) {
        // A next link with nothing behind it would spin forever on the same page.
        stoppedEarly = true
        break
      }
      url = next
    }
    if (url && !stoppedEarly) {
      // Only say this when the walk actually ran out of pages: after a `break`
      // on a failed request `url` is still set, and blaming the page cap for a
      // 403 sent me chasing a paging bug that did not exist.
      log(`open PR list hit the ${PR_MAX_PAGES}-page cap with more pages to go: reporting ${prs.length}`)
      stoppedEarly = true
    }
    // Complete means every page arrived and the row count reaches GitHub's own
    // total. Only then is the fresh list authoritative -- and only then may
    // merged/closed PRs drop off it. Short of that, the walk is a partial
    // sighting: union it over what is already known, so the count can move up
    // but never backwards because of a bad HTTP 500.
    const complete = !stoppedEarly && prs.length > 0 && (total == null || prs.length >= total)
    let list
    if (complete) {
      list = prs
    } else if (prs.length) {
      list = mergeOpenPrs(cached, { total, prs }).prs
      log(`open PR list came back with ${prs.length} of ${total ?? 'an unknown number'}: kept ${list.length - prs.length} already-known PRs so the count cannot go backwards`)
    } else {
      if (cachedPrs.length) {
        log(`open PR fetch returned nothing: still reporting the ${cachedPrs.length} PRs on disk${total != null ? ` (upstream says ${total} open)` : ''}`)
        return cachedPrs
      }
      return null
    }
    // Carry the expensive per-PR facts forward: the list endpoint answers
    // additions: null where a previous pass paid for the number, and a preview
    // already on disk costs nothing to keep. A PR whose `updated` moved gets
    // re-decorated, so a pushed update does not keep showing an old diff.
    for (const p of list) {
      const prev = prevByNum.get(p.number)
      if (!prev) continue
      if (prev.updated && p.updated && prev.updated !== p.updated) { p.stalePreview = true; continue }
      if (p.additions == null && prev.additions != null) {
        p.additions = prev.additions; p.deletions = prev.deletions; p.files = prev.files
      }
      p.comments = prev.comments ?? p.comments
      p.reviewComments = prev.reviewComments ?? p.reviewComments
      if (p.reviewState == null && prev.reviewState != null) p.reviewState = prev.reviewState
      if (!p.hasDiff && prev.hasDiff) p.hasDiff = true
      if ((!p.labels || p.labels.length === 0) && prev.labels?.length) p.labels = prev.labels
      if (!p.commitsList && prev.commitsList) p.commitsList = prev.commitsList
      if (!p.commentsList && prev.commentsList) p.commentsList = prev.commentsList
    }
    // The list endpoint omits additions/deletions/changed_files entirely, so
    // every extra number on a card costs a call: budget them, and stop asking
    // the moment GitHub refuses. Diffs first -- a preview a reader can open is
    // worth more than a diffstat -- then stats for whatever is still unknown.
    let used = 0
    let refused = false
    const ghGet = async (path, accept) => {
      if (refused || used >= PR_CALL_BUDGET) return null
      used++
      try {
        const r = await fetchImpl(`https://api.github.com${path}`, { headers: { ...headers, ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(15000) })
        if (!r.ok) {
          if (r.status === 403 || r.status === 429) {
            refused = true
            log(`GitHub refused per-PR calls (HTTP ${r.status}${process.env.GITHUB_TOKEN ? '' : ', no GITHUB_TOKEN set'}): stopping the decoration pass, retrying shortly`)
          }
          return null
        }
        return accept ? await r.text() : await r.json()
      } catch { return null }
    }
    // Inline diff preview (first ~120 lines): persisted in data/pr-diffs/,
    // served from /pr-diffs/<n>.diff. A missing file degrades to a GitHub link,
    // and PRs already on disk are skipped -- so a steady list costs nothing.
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises')
    await mk(resolve(dataDir, 'pr-diffs'), { recursive: true })
    const previewPath = (n) => resolve(dataDir, `pr-diffs/${n}.diff`)
    await pool(list.filter(p => !p.hasDiff || p.stalePreview || !existsSync(previewPath(p.number))).map(p => async () => {
      const diff = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}`, 'application/vnd.github.diff')
      if (typeof diff === 'string' && diff.startsWith('diff --git')) {
        await wf(previewPath(p.number), diff.split('\n').slice(0, 120).join('\n'))
        p.hasDiff = true
        delete p.stalePreview
      }
    }), 4)
    await pool(list.filter(p => p.additions == null).map(p => async () => {
      const full = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}`)
      if (full) {
        p.additions = full.additions
        p.deletions = full.deletions
        p.files = full.changed_files
        p.comments = full.comments ?? p.comments
        p.reviewComments = full.review_comments ?? p.reviewComments
      }
    }), 4)
    // Decorate individual commits on PRs
    await pool(list.filter(p => p.commitsList == null && used < PR_CALL_BUDGET).slice(0, 40).map(p => async () => {
      const commits = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}/commits`)
      if (Array.isArray(commits)) {
        p.commitsList = commits.map(c => ({
          sha: (c.sha || '').slice(0, 10),
          message: (c.commit?.message || '').split('\n')[0],
          author: c.commit?.author?.name || c.author?.login || 'contributor',
          date: (c.commit?.author?.date || '').slice(0, 10),
          url: c.html_url || `https://github.com/CodebuffAI/freebuff/commit/${c.sha}`
        }))
      }
    }), 4)
    // Decorate PR discussion & review comments
    await pool(list.filter(p => ((p.comments || 0) + (p.reviewComments || 0)) > 0 && p.commentsList == null && used < PR_CALL_BUDGET).slice(0, 40).map(p => async () => {
      const [issueComments, reviewComments] = await Promise.all([
        ghGet(`/repos/CodebuffAI/freebuff/issues/${p.number}/comments`),
        (p.reviewComments > 0) ? ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}/comments`) : null
      ])
      const cList = []
      if (Array.isArray(issueComments)) {
        for (const c of issueComments) {
          cList.push({
            id: c.id,
            author: c.user?.login || 'user',
            body: c.body || '',
            created: (c.created_at || '').slice(0, 16).replace('T', ' '),
            url: c.html_url || p.url,
            isReview: false
          })
        }
      }
      if (Array.isArray(reviewComments)) {
        for (const rc of reviewComments) {
          cList.push({
            id: rc.id,
            author: rc.user?.login || 'reviewer',
            body: rc.body || '',
            created: (rc.created_at || '').slice(0, 16).replace('T', ' '),
            url: rc.html_url || p.url,
            isReview: true,
            path: rc.path || '',
            line: rc.line || null
          })
        }
      }
      cList.sort((a, b) => a.created.localeCompare(b.created))
      p.commentsList = cList
    }), 4)
    // Optional review state decoration (when explicitly requested, e.g. CHANGELOG_PR_REVIEWS=1)
    if (process.env.CHANGELOG_PR_REVIEWS === '1') {
      await pool(list.filter(p => !p.draft && p.reviewState == null && used < PR_CALL_BUDGET).slice(0, 50).map(p => async () => {
        const reviews = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}/reviews`)
        if (Array.isArray(reviews) && reviews.length > 0) {
          const latestByUser = new Map()
          for (const r of reviews) {
            if (r.user?.login && r.state && r.state !== 'DISMISSED') {
              latestByUser.set(r.user.login, r.state)
            }
          }
          const states = [...latestByUser.values()]
          if (states.includes('CHANGES_REQUESTED')) p.reviewState = 'CHANGES_REQUESTED'
          else if (states.includes('APPROVED')) p.reviewState = 'APPROVED'
          else if (states.includes('COMMENTED')) p.reviewState = 'COMMENTED'
        }
      }), 4)
    }
    // Mark previews already on disk (skipped above, still viewable).
    for (const p of list) {
      if (!p.hasDiff && existsSync(previewPath(p.number))) p.hasDiff = true
      if (p.stalePreview) delete p.stalePreview
    }
    // Say what is missing and why, in the same breath as the budget: a reader
    // of the log should not have to infer that 116 PRs and 25 calls do not
    // meet, or that the gap is being closed on purpose.
    const noDiff = list.filter(p => !p.hasDiff).length
    const noStats = list.filter(p => p.additions == null).length
    if (noDiff || noStats) {
      log(`open PRs: ${list.length} listed${total != null ? ` of ${total} open` : ''}, ${used}/${PR_CALL_BUDGET} per-PR calls spent${refused ? ' (refused)' : ''}; ${noDiff} without a preview, ${noStats} without a diffstat -- the next run continues`)
    }
    // `partial` says the run is unfinished; `listComplete` says something narrower
    // and is the one `prunePrDiffs` reads. They differ in the common case: an
    // unauthenticated run lists all 116 PRs (so a merged PR's preview may be
    // deleted) but cannot afford 232 per-PR calls (so it stays `partial` and keeps
    // chasing diffstats). Conflating them meant previews of long-dead PRs were
    // never pruned, because decoration is always the thing that runs out.
    const partial = refused || used >= PR_CALL_BUDGET || !complete
    const hasChanges = !prsEqual(cached, list, total, complete, partial)
    if (hasChanges || force || !cached?.fetchedAt) {
      const nowIso = new Date().toISOString()
      lastDiskFetchedMap.set(dataDir, nowIso)
      lastCheckTimeMap.set(dataDir, Date.now())
      await writeJson(`${dataDir}/open-prs.json`, {
        fetchedAt: nowIso,
        ...(total != null ? { total } : {}),
        listComplete: complete,
        prs: list,
        ...(partial ? { partial: true } : {})
      })
    }
    return list
  } catch (err) {
    log(`open PR fetch failed: ${String(err?.message || err).slice(0, 120)}`)
    return null
  }
}

function decorate (e) {
  // Upstream commits carry the author's offset (`-08:00`); the day pages, the
  // release windows and every sort key off the string, so the zone has to go
  // before anything reads it. Idempotent: an already-UTC date passes through.
  e.date = toUtc(e.date)
  const testOnly = e.files.testOnly ?? ((e.files.meaningful === 0 && (e.files.rawMeaningful || 0) > 0) ||
    ([...e.files.added, ...e.files.removed, ...e.files.modified].length > 0 &&
     [...e.files.added, ...e.files.removed, ...e.files.modified].every(p => TEST_RE.test(p))))
  const lockOnly = e.files.meaningful === 0 && !testOnly
  // Nothing is dropped any more. A commit that only moved bun.lock is still a
  // commit the repository received, and 30% of recent upstream commits were
  // vanishing from a site whose whole purpose is to list them. Churn is marked
  // instead of skipped: dimmed in the timeline, absent from feeds, search and
  // the LLM queue, and never counted as a "change" in the headline.
  // Test-only commits are *not* churn: real work landed, so they get a row, a
  // category and a summary like any other entry.
  const churn = (lockOnly || e.files.total === 0) && !e.modelChanges && !e.version && !e.freebuffVersion && !e.cmdChanges
  if (churn) {
    const label = churnLabel(e)
    e.noise = true
    e.churn = label.kind
    e.title = label.title
    e.summary = label.summary
    e.category = 'Churn'
    e.significance = 'noise'
    e.day = ymd(e.date)
    e.month = ymd(e.date).slice(0, 7)
    return e
  }
  e.testOnly = testOnly || undefined
  e.commitNature = commitNatureOf(e)
  if (e.modelChanges) e.category = 'Model Catalog'
  else if (e.cmdChanges) e.category = 'Commands'
  else if (e.areas.includes('CLI')) e.category = 'CLI'
  else if (e.areas.includes('SDK')) e.category = 'SDK'
  else if (e.areas.includes('Agent Runtime')) e.category = 'Agent Runtime'
  else if (e.areas.includes('Code Map')) e.category = 'Code Map'
  else if (e.areas.includes('LLM Providers')) e.category = 'LLM Providers'
  else if (e.areas.includes('Agents')) e.category = 'Agents'
  else if (e.areas.includes('Shared/Core')) e.category = 'Core'
  else if (e.areas.includes('Docs')) e.category = 'Docs'
  else if (e.areas.includes('Packaging')) e.category = 'Packaging'
  else e.category = 'Internal'
  // A test-only snapshot commit names nothing in files.added/modified (those hold
  // source files only), which left 29 rows titled "Shared/Core update" with an
  // empty body. Community rows keep their commit message; areas still decide the
  // category, since a test for the SDK is still SDK work.
  if (testOnly && e.kind === 'sync') {
    const label = testLabel(e)
    e.title = label.title
    e.summary = label.summary
  }
  let significance = 'minor'
  if (e.modelChanges || e.version) significance = 'major'
  else if (e.cmdChanges || e.files.added.length || e.files.removed.length) significance = 'notable'
  else if (e.stats.additions + e.stats.deletions > 400) significance = 'notable'
  e.significance = significance
  e.day = ymd(e.date)
  e.month = ymd(e.date).slice(0, 7)
  return e
}

// ---------------------------------------------------------------------------

async function cmdGenerate (argv) {
  const { acquired } = await withLock(LOCK, () => generateOnce(argv))
  if (!acquired) {
    throw new Error(`another generate/backfill run holds ${LOCK}: wait for it to finish, or remove the lock dir`)
  }
}

async function generateOnce (argv) {
  const full = argv.includes('--full')
  const head = await ensureRepo()
  const state = await readJson(`${DATA}/state.json`, { lastSha: null, runs: 0 })

  let commits
  const isAncestor = state.lastSha
    ? (await git(['merge-base', '--is-ancestor', state.lastSha, 'origin/main'], REPO_DIR, { allowFail: true })) !== null
    : false
  if (state.lastSha && isAncestor && !full) {
    log(`incremental: commits after ${state.lastSha.slice(0, 8)}`)
    commits = await listCommitsRange(REPO_DIR, state.lastSha)
  } else {
    log(state.lastSha && !isAncestor ? 'history rewritten: full rescan' : 'full scan')
    commits = await listCommits(REPO_DIR)
  }

  const existing = await readJson(`${DATA}/changelog.json`, { version: 1, entries: [] })
  const bySha = new Map(existing.entries.map(e => [e.sha, e]))
  let added = 0, updated = 0
  const newlyAddedEntries = []

  for (const c of commits) {
    if (bySha.has(c.sha)) continue
    let e
    if (isSyncCommit(c)) {
      const prev = c.parents[0]
      if (!prev) continue
      e = await analyzeSyncCommit(REPO_DIR, c, prev, META)
      e.prevSha = prev
      // Cheap pre-filter before heavy diff work happens? diff already fetched; keep.
    } else {
      e = await analyzeCommunityCommit(REPO_DIR, c, c.parents[0] || null, META)
    }
    decorate(e)
    bySha.set(c.sha, e)
    newlyAddedEntries.push(e)
    added++
    if (added % 200 === 0) log(`${added} entries so far (${c.sha.slice(0, 8)})`)
  }

  let entries = [...bySha.values()]
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sha < b.sha ? -1 : 1))

  // Hourly sync behavior: only generate diffs & summarize NEWLY added entries this run.
  // Backfilling of historical/existing entries is handled by the 1-minute loop (npm run backfill / watch).
  const toEnrich = (full || !state.lastSha) ? entries : newlyAddedEntries
  if (toEnrich.length > 0) {
    await backfillDiffs(toEnrich, toEnrich.length)
    if (llmConfigured()) {
      const n = await enrichWithLlm(toEnrich, llmPatchFor, DATA, process.env, { repoDir: REPO_DIR })
      log(`LLM enriched ${n} new entries`)
    }
  }
  // ELI5 scans the whole entry set rather than only this run's additions: the
  // summary it explains may have been written minutes ago by the other pass.
  // This call is what makes a brand-new entry arrive with its plain-English line
  // already attached instead of waiting for a backfill.
  const eli5N = await enrichEli5(entries, DATA, process.env, { getPatch: llmPatchFor, repoDir: REPO_DIR })
  if (eli5N) log(`ELI5 wrote ${eli5N} plain-English line${eli5N === 1 ? '' : 's'}`)

  const prevScanned = existing.counts?.commitsScanned || 0
  const changelog = {
    version: 1,
    repo: META.repoUrl,
    generatedAt: new Date().toISOString(),
    headSha: head,
    counts: {
      commitsScanned: full || !isAncestor ? commits.length : (prevScanned || entries.length) + commits.length,
      entries: entries.length,
      // Split for the same reason the rows are dimmed: "9,526 commits" and
      // "7,382 changes" are different claims, and the hero must not blur them.
      changes: entries.filter(e => !e.noise).length,
      churn: entries.filter(e => e.noise).length,
      syncEra: entries.filter(e => e.kind === 'sync').length,
      community: entries.filter(e => e.kind === 'community').length
    },
    entries
  }
  // Prune first, then reconcile flags with what is on disk -- both before the
  // write. backfillDiffs sets hasDiff when it creates a file, pruneDiffs removes
  // files no entry references, and running prune after the write left 58 rows
  // advertising a diff that no longer existed (404 behind "View inline diff").
  await pruneDiffs(resolve(DATA, 'diffs'), entries)
  refreshDiffFlags(entries, resolve(DATA, 'diffs'))
  // Merge into whatever is on disk rather than overwriting it: a backfill
  // cycle may have committed summaries for other entries since this run read
  // changelog.json, and headSha/counts must still move forward.
  await persistMerged(await capturePendingWrites(DATA, {
    [`${DATA}/changelog.json`]: changelog,
    [`${DATA}/state.json`]: { lastSha: head, runs: (state.runs || 0) + 1, updatedAt: changelog.generatedAt }
  }))

  const prs = await fetchOpenPrs()
  await prunePrDiffs(prs || [], await readJson(`${DATA}/open-prs.json`, null))

  log(`wrote ${entries.length} entries (${added} new this run)` + (prs ? `, ${prs.length} open PRs` : ''))
  // Newest last, matching analyze order: callers front-load these for
  // summarization so a fresh upstream commit is not stuck behind the backlog.
  return { newShas: newlyAddedEntries.map(e => e.sha) }
}

// Retention: delete pr-diffs/*.diff for PRs no longer open. Stale previews
// accumulate as PRs merge; the client degrades to a GitHub link when missing.
export async function prunePrDiffs (openPrs, doc = null, dataDir = DATA) {
  // A short list is not a closed PR. Pruning against one deletes the previews of
  // every PR the fetch failed to mention -- which is exactly what a truncated
  // 60-of-116 run did to 56 stored diffs. Only a walk that reached GitHub's own
  // count may remove files; an unknown shape (no flag at all) is treated as short.
  if (doc && !doc.listComplete) { log('open PR list is not known-complete: keeping every cached preview rather than pruning against a short list'); return 0 }
  if (!doc) { log('no stored open PR list: pruning nothing'); return 0 }
  const { readdir, unlink } = await import('node:fs/promises')
  const dir = resolve(dataDir, 'pr-diffs')
  if (!existsSync(dir)) return 0
  const open = new Set((openPrs || []).map(p => `${p.number}.diff`))
  let pruned = 0
  for (const f of await readdir(dir)) {
    if (f.endsWith('.diff') && !open.has(f)) {
      await unlink(resolve(dir, f))
      pruned++
    }
  }
  if (pruned > 0) log(`pruned ${pruned} closed-PR diffs`)
  return pruned
}

/**
 * Store a diff for every entry that lacks one -- community commits and churn
 * rows included, which used to be filtered out and left 855 of 9,527 rows with
 * a diff to open. Newest first, so an interrupted run leaves the pages a reader
 * actually lands on complete rather than the 2024 archive.
 */
async function backfillDiffs (entries, max = Infinity) {
  const diffDir = resolve(DATA, 'diffs')
  await mkdir(diffDir, { recursive: true })
  const todo = entries.filter(e => !existsSync(resolve(diffDir, `${e.sha}.diff`))).reverse()
  let count = 0
  let empty = 0
  let failed = 0
  await pool(todo.map(e => async () => {
    if (count >= max) return
    // One unreadable commit must not end a run over thousands of them: this is
    // the pass that died on a single 67 MB diff.
    let diff = ''
    try { diff = await storedDiffFor(e) } catch (err) { failed++; log(`diff failed for ${e.sha.slice(0, 8)}: ${err.message.slice(0, 80)}`) }
    if (!diff) { empty++; return }
    await writeText(resolve(diffDir, `${e.sha}.diff`), diff)
    e.hasDiff = true
    count++
  }), 8)
  if (count > 0) log(`generated ${count} diffs in data/diffs/`)
  if (empty > 0) log(`${empty} entries produced no diff text (empty, net-zero merge, or unreadable)`)
  if (failed > 0) log(`${failed} diffs could not be extracted from the clone`)
  return count
}

// One source of truth for the diff toggle: the file on disk. Entries that were
// summarized before a prune, or that a merge re-imported without the flag, both
// end up wrong if the flag is trusted instead of checked.
// One source of truth for the diff toggle: the file on disk. Entries that were
// summarized before a prune, or that a merge re-imported without the flag, both
// end up wrong if the flag is trusted instead of checked. Every kind, because
// every kind now has a stored diff.
export function refreshDiffFlags (entries, diffDir) {
  let fixed = 0
  for (const e of entries) {
    const want = existsSync(resolve(diffDir, `${e.sha}.diff`))
    if (!!e.hasDiff !== want) {
      e.hasDiff = want || undefined
      fixed++
    }
  }
  if (fixed) log(`reconciled ${fixed} diff flags with data/diffs/ on disk`)
  return fixed
}

async function listCommitsRange (repoDir, lastSha) {
  const LOG_FORMAT = ['%H', '%P', '%cI', '%s', '%an', '%b'].join('\x1f') + '\x1e'
  const out = await git(['log', `${lastSha}..origin/main`, `--format=${LOG_FORMAT}`, '--reverse'], repoDir)
  const commits = []
  for (const rec of out.split('\x1e')) {
    const t = rec.replace(/^\n/, '')
    if (!t.trim()) continue
    const [sha, parents, date, subject, author, body] = t.split('\x1f')
    commits.push({ sha: sha.trim(), parents: parents.trim() ? parents.trim().split(' ') : [], date: date.trim(), subject: (subject || '').trim(), author: (author || '').trim(), body: (body || '').trim() })
  }
  return commits
}

// ---------------------------------------------------------------------------
// The git write path, shared by the backfill daemon and the workflow (via
// `cli.mjs push-data`) so the push race has exactly one implementation.

async function currentBranch (root = ROOT) {
  return (await git(['branch', '--show-current'], root, { allowFail: true }))?.trim() || 'main'
}

function utcStamp () {
  return new Date().toISOString().replace('T', ' ').slice(0, 16)
}

const dirtyData = async (root = ROOT) => ((await git(['status', '--porcelain', 'data/'], root, { allowFail: true })) || '').trim()
const aheadOfOrigin = async (branch, root = ROOT) =>
  Number((await git(['rev-list', '--count', `origin/${branch}..HEAD`], root, { allowFail: true })) || '0') || 0

/**
 * Bring the worktree onto origin/<branch>. Never leaves a half-finished rebase
 * behind: every later cycle's add/commit would run *inside* it, which is how a
 * loop stalls for hours with fresh upstream data and no pushes. Failure is not
 * fatal here — persistMerged at push time still refuses to discard origin.
 */
async function realignOrigin (branch) {
  if ((await git(['pull', '--rebase', 'origin', branch], ROOT, { allowFail: true })) !== null) return true
  await git(['rebase', '--abort'], ROOT, { allowFail: true })
  return false
}

/**
 * Commit and push data/.
 *
 * The earlier fix for the push race retried `push` after `pull --rebase`, which
 * only covers the git half. changelog.json is *derived* data that both writers
 * regenerate from their own in-memory snapshot, so a rebase can succeed cleanly
 * and still push a stale headSha/generatedAt (our snapshot wins the hunks),
 * while a conflicted one left a local commit that conflicted against itself on
 * every subsequent cycle. Here: origin is never discarded, this cycle's work is
 * re-merged onto it, and each retry starts from a clean tree.
 */
export async function commitAndPushData ({ message, overrides = {}, attempts = 3, root = ROOT, dataDir = DATA } = {}) {
  const branch = await currentBranch(root)
  // Where this cycle's derived files live, relative to the worktree: the only
  // path the conflict recovery is allowed to overwrite.
  const dataRel = relative(root, resolve(dataDir)) || 'data'
  const pending = await capturePendingWrites(dataDir, overrides)
  await persistMerged(pending)

  if (!await dirtyData(root)) {
    log('data is already up to date: nothing to push.')
    return false
  }
  await git(['add', 'data'], root)
  await git(['commit', '-m', message], root)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // HEAD:<branch>, not <branch>: the workflow runner can be on a detached
    // HEAD, where `push origin main` would silently push an older local ref.
    if ((await git(['push', 'origin', `HEAD:${branch}`], root, { allowFail: true })) !== null) {
      log(`pushed data to origin/${branch}: Cloudflare redeploys on that push.`)
      return true
    }
    if (attempt === attempts) break
    log(`push rejected (attempt ${attempt}/${attempts}): realigning onto origin/${branch}…`)
    await git(['fetch', '--force', 'origin', branch], root, { allowFail: true })
    if ((await git(['rebase', `origin/${branch}`], root, { allowFail: true })) === null) {
      // Conflict in derived files: origin is authoritative for the analyze
      // output, so take its data/ wholesale and re-apply this cycle's captured
      // snapshot on top. Nothing from either writer is lost and HEAD ends up
      // matching origin exactly, so the next attempt starts clean.
      await git(['rebase', '--abort'], root, { allowFail: true })
      // Two separate jobs, and one `reset --hard` was doing both badly. HEAD must
      // land on origin, and data/ on disk must become origin's copy — that is the
      // version persistMerged merges against, so skipping it would quietly drop
      // the other writer's entries and move headSha backward. Neither job justifies
      // touching the rest of the worktree: this loop runs beside a human editing
      // this repository, and a worktree-wide hard reset also throws away their
      // uncommitted files. Losing that is not a sync bug to absorb, it is data
      // loss. So: move HEAD with --mixed, then restore only the paths owned here.
      await git(['reset', '--mixed', `origin/${branch}`], root, { allowFail: true })
      await git(['checkout', `origin/${branch}`, '--', dataRel], root, { allowFail: true })
      await persistMerged(pending)
      log('rebase conflicted: re-applied this cycle onto origin')
      if (await dirtyData(root)) {
        await git(['add', 'data'], root)
        await git(['commit', '-m', message], root)
      }
    }
    if (!await aheadOfOrigin(branch, root)) {
      log('origin already carries this cycle\'s data: nothing left to push.')
      return false
    }
  }
  throw new Error(`git push origin ${branch} failed after ${attempts} attempts`)
}

// Publish data/ without running the analyze step. Used by the hourly workflow
// so it shares this exact race handling instead of open-coding it in YAML.
async function cmdPushData (argv) {
  const msgIdx = argv.indexOf('--message')
  const message = msgIdx !== -1 && argv[msgIdx + 1]
    ? argv[msgIdx + 1]
    : `data: update changelog (${utcStamp()} UTC)`
  await commitAndPushData({ message })
}

async function cmdCatchUp (argv) {
  const { acquired } = await withLock(LOCK, () => catchUpOnce(argv))
  if (!acquired) log('another generate/backfill run holds the worktree lock: skipping this cycle')
}

async function catchUpOnce (argv) {
  const branch = await currentBranch()

  // 1. Sync unless the data is already fresh. This is the loop's primary job:
  //    without it, generatedAt/headSha move only when the GitHub schedule
  //    happens to fire, and those two fields are the *only* inputs to the
  //    site's "[stale Nm]" counter.
  const head = await ensureRepo()
  const state = await readJson(`${DATA}/state.json`, { lastSha: null, runs: 0 })
  const synced = await readJson(`${DATA}/changelog.json`, null)
  const reason = syncReason({
    head,
    lastSha: state.lastSha,
    generatedAt: synced?.generatedAt,
    staleMs: syncStaleMs()
  })
  let didSync = false
  let freshShas = []
  if (reason) {
    const incremental = !state.lastSha ||
      (await git(['merge-base', '--is-ancestor', state.lastSha, 'origin/main'], REPO_DIR, { allowFail: true })) !== null
    if (incremental) {
      log(`[sync] ${reason}`)
      await realignOrigin(branch)
      freshShas = (await generateOnce(argv))?.newShas || []
      didSync = true
    } else {
      // A rewritten history needs a full rescan (minutes of git work). That
      // belongs to the workflow; a 60s loop must not block on it.
      log(`[sync] skipped: ${reason} (history rewritten: needs \`npm run generate -- --full\`)`)
    }
  }

  // 1.5. Refresh open PRs even when git main is quiet, so newly opened, updated,
  //      or merged PRs appear on /in-flight/ quickly rather than waiting up to
  //      45m for the next commit-sync cycle.
  let didPrSync = false
  if (!didSync) {
    const prevPrs = await readJson(`${DATA}/open-prs.json`, null)
    const prs = await fetchOpenPrs()
    if (prs) {
      await prunePrDiffs(prs, prevPrs)
      didPrSync = Boolean(await dirtyData())
    }
  }

  // 2. Snapshot *after* the sync — generate rewrote changelog.json, so a copy
  //    taken before it would be stale by write time.
  const existing = await readJson(`${DATA}/changelog.json`, { version: 1, entries: [] })
  const entries = existing.entries || []
  if (!entries.length) {
    log('no entries after sync: nothing to backfill')
    return
  }

  // 3. Publish new entries before the slow part. A commit that arrives at
  //    16:20 must be readable by ~16:22, not after this cycle's LLM batch
  //    finishes (~2min later) — the summary is enrichment, the row is the news.
  if (argv.includes('--push') && freshShas.length) {
    await commitAndPushData({
      message: `data: update changelog (${utcStamp()} UTC)`,
      overrides: { [`${DATA}/changelog.json`]: existing }
    })
  }

  const queueable = entries.filter(e => !e.noise)
  const isCurrent = (e) => e.ai?.title && (process.env.CHANGELOG_LLM_FORCE_REWRITE === '1' ? (e.ai?.v ?? 1) >= PROMPT_V : true)
  const unsummarized = queueable.filter(e => !isCurrent(e))
  log(`[backfill] ${queueable.length} total entries (${unsummarized.length} remaining to summarize)`)

  let limit = Number(process.env.CHANGELOG_LLM_LIMIT || 5)
  const limitIdx = argv.indexOf('--limit')
  if (limitIdx !== -1 && argv[limitIdx + 1]) {
    limit = Number(argv[limitIdx + 1]) || limit
  }

  let didSummarize = false
  if (!unsummarized.length) {
    log('[backfill] all existing sync entries already have AI summaries!')
  } else if (llmConfigured()) {
    await backfillDiffs(entries, 1000)
    const envWithLimit = { ...process.env, CHANGELOG_LLM_LIMIT: String(limit) }
    const n = await enrichWithLlm(entries, llmPatchFor, DATA, envWithLimit, {
      retryErrors: true,
      // This cycle's commits go first; the backlog can wait, the news cannot.
      priorityShas: new Set(freshShas.slice(-limit)),
      repoDir: REPO_DIR
    })
    const remaining = queueable.filter(e => !isCurrent(e)).length
    log(`[backfill] enriched ${n} entries with LLM (${remaining} remaining)`)
    didSummarize = remaining < unsummarized.length
  } else {
    log('LLM not configured (CHANGELOG_LLM=1 and LLM_API_KEY required in .env)')
  }

  // The ELI5 drain sits *outside* that branch on purpose. In the steady state
  // every summary already exists, so nothing below the first if would ever run
  // and the plain-English backlog would never move; and a commit summarized a
  // few lines above needs its line in the same cycle, not the next one.
  if (llmConfigured()) {
    const eli5Written = await enrichEli5(entries, DATA, { ...process.env, CHANGELOG_LLM_LIMIT: String(limit) }, {
      retryErrors: true,
      priorityShas: new Set(freshShas.slice(-limit)),
      getPatch: llmPatchFor,
      repoDir: REPO_DIR
    })
    const eli5Remaining = entries.filter(e => eli5Eligible(e) && !eli5Done(e)).length
    if (eli5Written || eli5Remaining) {
      log(`[backfill] ELI5 wrote ${eli5Written} entries (${eli5Remaining} remaining)`)
    }
    didSummarize = didSummarize || eli5Written > 0
  }

  // 4. Publish again, this time with the summaries in. Still unconditional on
  //    --push rather than gated on didSummarize: an upstream-only move is
  //    exactly the case that was stalling, and leftover uncommitted diffs would
  //    block the next cycle's rebase.
  if (argv.includes('--push')) {
    const commitMsg = didSummarize
      ? `data: LLM backfill (${utcStamp()} UTC)`
      : (didSync
        ? `data: update changelog (${utcStamp()} UTC)`
        : (didPrSync ? `data: update open PRs (${utcStamp()} UTC)` : `data: update (${utcStamp()} UTC)`))
    await commitAndPushData({
      message: commitMsg,
      // entries carry this cycle's AI grafts in memory only until we write them.
      overrides: { [`${DATA}/changelog.json`]: existing }
    })
  } else if (didSync || didSummarize || didPrSync) {
    log('dry run: data written locally, not committed (pass --push)')
  }
}

async function cmdWatch (argv) {
  let intervalSec = 60
  const idx = argv.indexOf('--interval')
  if (idx !== -1 && argv[idx + 1]) {
    intervalSec = Number(argv[idx + 1]) || 60
  } else if (process.env.WATCH_INTERVAL) {
    intervalSec = Number(process.env.WATCH_INTERVAL) || 60
  }

  let stopped = false
  const stop = () => { stopped = true }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  log(`starting backfill loop (running every ${intervalSec}s)… Press Ctrl+C to stop.`)
  while (!stopped) {
    try {
      await cmdCatchUp(argv)
    } catch (err) {
      log(`backfill loop iteration error: ${err.message}`)
    }
    if (stopped) break
    log(`sleeping ${intervalSec}s before next cycle…`)
    await new Promise(r => setTimeout(r, intervalSec * 1000))
  }
  log('backfill loop stopped.')
}

// ---------------------------------------------------------------------------

async function cmdBuild () {
  const changelog = await readJson(`${DATA}/changelog.json`, null)
  if (!changelog) throw new Error('data/changelog.json missing: run generate first')
  const aiCache = await readJson(`${DATA}/ai-summaries.json`, {})
  if (Object.keys(aiCache).length) {
    const aiBySha = new Map()
    for (const [key, val] of Object.entries(aiCache)) {
      if (val && !val.error && val.title) {
        const sha = key.split(':')[0]
        aiBySha.set(sha, val)
      }
    }
    for (const e of changelog.entries) {
      if (!e.ai && aiBySha.has(e.sha)) {
        e.ai = aiBySha.get(e.sha)
      }
    }
  }
  const prsRaw = await readJson(`${DATA}/open-prs.json`, [])
  const prs = Array.isArray(prsRaw) ? prsRaw : (prsRaw?.prs || [])
  // GitHub's own count, carried from the fetch: when it is above the number of
  // cards, the page says so instead of presenting a short list as the whole truth.
  // How long ago the last successful check was, in minutes: a list nobody has
  // refreshed is not a quiet repo either, and the page says so rather than
  // presenting an old count as today's.
  const prAgeMin = prsRaw?.fetchedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(prsRaw.fetchedAt)) / 60000))
    : null
  const prMeta = {
    total: Array.isArray(prsRaw) ? null : (prsRaw?.total ?? null),
    partial: !Array.isArray(prsRaw) && !!prsRaw?.partial,
    ageMin: prAgeMin
  }
  const dataDiffs = resolve(DATA, 'diffs')
  const dist = resolve(ROOT, 'dist')
  const t0 = Date.now()
  // dist/ is a pure build output, regenerated in full from data/ every run, so it
  // is cleared first. Without this, any URL the generator stops emitting keeps
  // shipping the markup of the build that made it -- today that would be a
  // retired page family serving an old multi-day timeline beside the new one-day
  // pages, and in general it is stale diffs outliving the entries they describe.
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  // The timeline paginates one day per page: `/` is the newest day, every older
  // day is its own /day/<date>/ page.
  await buildSite({ changelog, openPrs: prs, prMeta, dist })

  const distDiffs = resolve(dist, 'diffs')
  if (existsSync(dataDiffs)) {
    await mkdir(distDiffs, { recursive: true })
    await cp(dataDiffs, distDiffs, { recursive: true })
  }
  const dataPrDiffs = resolve(DATA, 'pr-diffs')
  if (existsSync(dataPrDiffs)) {
    await mkdir(resolve(dist, 'pr-diffs'), { recursive: true })
    await cp(dataPrDiffs, resolve(dist, 'pr-diffs'), { recursive: true })
  }

  log(`site built in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${dist}`)
}

async function cmdPreview (port = 8788) {
  const { createServer } = await import('node:http')
  const { resolve: r, join } = await import('node:path')
  const dist = resolve(ROOT, 'dist')
  createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    let f = r(dist, '.' + p)
    if (!f.startsWith(dist)) { res.writeHead(403); res.end(); return }
    try {
      const body = await readFile(f)
      res.writeHead(200, { 'content-type': MIME(f) })
      res.end(body)
    } catch {
      try { const body = await readFile(join(f.replace(/\/$/, '') + '/index.html')); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body) }
      catch {
        try {
          const body = await readFile(resolve(dist, '404.html'))
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
          res.end(body)
        } catch {
          res.writeHead(404)
          res.end('404')
        }
      }
    }
  }).listen(port, () => log(`preview: http://localhost:${port}`))
}

function MIME (f) {
  if (f.endsWith('.html')) return 'text/html; charset=utf-8'
  if (f.endsWith('.json')) return 'application/json; charset=utf-8'
  if (f.endsWith('.diff')) return 'text/plain; charset=utf-8'
  if (f.endsWith('.xml')) return 'application/rss+xml; charset=utf-8'
  if (f.endsWith('.xsl')) return 'text/xsl; charset=utf-8'
  if (f.endsWith('.css')) return 'text/css'
  if (f.endsWith('.svg')) return 'image/svg+xml'
  if (f.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

// ---------------------------------------------------------------------------

// Dispatch only as an entrypoint: the test suite imports this module for the
// shared push path, and an unguarded dispatch would print usage and exit(0)
// from inside the test process.
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (IS_MAIN) {
  const [, , cmd, ...rest] = process.argv
  if (cmd === 'generate') await cmdGenerate(rest)
  else if (cmd === 'catch-up') await cmdCatchUp(rest)
  else if (cmd === 'watch' || cmd === 'backfill') await cmdWatch(rest)
  else if (cmd === 'push-data') await cmdPushData(rest)
  else if (cmd === 'enrich-all') await cmdEnrichAll(rest)
  else if (cmd === 'normalize-dates') await cmdNormalizeDates(rest)
  else if (cmd === 'broadcast') await cmdBroadcast(rest)
  else if (cmd === 'build') await cmdBuild()
  else if (cmd === 'preview') await cmdPreview(Number(rest[0]) || 8788)
  else {
    console.log(`usage:
  node generator/cli.mjs generate [--full]        # analyze upstream freebuff (full rescan)
  node generator/cli.mjs catch-up [--push]        # sync-if-due + one LLM backfill batch
  node generator/cli.mjs backfill [--push]        # continuous sync + backfill loop (the daemon)
  node generator/cli.mjs watch [--push]           # alias for backfill
  node generator/cli.mjs push-data [--message M]  # commit+push data/ with the shared race handling
  node generator/cli.mjs enrich-all [--batch N] [--push]  # one pass toward a diff + summary + ELI5 for every entry (0 = everything left)
  node generator/cli.mjs normalize-dates [--push]  # one-off: rewrite stored timestamps to UTC and fix the day/month keys
  node generator/cli.mjs broadcast [--webhook URL] [--limit N] [--dry-run]  # broadcast latest commits to Discord
  node generator/cli.mjs build                    # render static site → dist/
  node generator/cli.mjs preview [port]           # local preview of dist/`)
    process.exit(cmd ? 1 : 0)
  }
}
/**
 * One pass toward complete coverage: store every missing diff, then spend a
 * batch of API calls on technical summaries and plain-English lines, and publish.
 *
 * A *pass*, not a loop, on purpose: the run holds the worktree lock, and the
 * daemon needs that lock to publish fresh upstream commits. Looping this from
 * outside (`until` it reports nothing left) hands the daemon a window between
 * passes. Everything is resumable -- summaries are cached by sha + prompt
 * version + diff hash, and a diff already on disk is never regenerated.
 */
async function cmdEnrichAll (argv) {
  const { acquired } = await withLock(LOCK, () => enrichAllPass(argv))
  if (!acquired) log('another generate/backfill run holds the worktree lock: retry this pass shortly')
}

async function enrichAllPass (argv) {
  // --batch 0 means "everything still missing", bounded per pass by the queue's
  // own git-work window rather than by a call count.
  const at = argv.indexOf('--batch')
  const batch = at !== -1 ? Math.max(0, Number(argv[at + 1]) || 0) : 200
  const env = { ...process.env, CHANGELOG_LLM_LIMIT: String(batch), CHANGELOG_ELI5_LIMIT: String(batch) }
  const doc = await readJson(`${DATA}/changelog.json`, null)
  if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
  const entries = doc.entries
  const diffDir = resolve(DATA, 'diffs')

  // 1. Diffs: git work only, no API cost, and the LLM queue needs the patch.
  await ensureRepo()
  const stored = await backfillDiffs(entries, batch > 0 ? batch * 10 : Infinity)
  refreshDiffFlags(entries, diffDir)

  // 2. Summaries + plain-English lines, newest-first inside their own priorities.
  const calls = llmConfigured(env) ? await enrichWithLlm(entries, llmPatchFor, DATA, env, { retryErrors: true, repoDir: REPO_DIR }) : 0
  const eli5 = llmConfigured(env) ? await enrichEli5(entries, DATA, env, { retryErrors: true, getPatch: llmPatchFor, repoDir: REPO_DIR }) : 0
  if (!llmConfigured(env)) log('LLM not configured (CHANGELOG_LLM=1 and LLM_API_KEY required in .env): stored diffs only')

  const isCurrent = (e) => e.ai?.title && (env.CHANGELOG_LLM_FORCE_REWRITE === '1' ? (e.ai?.v ?? 1) >= PROMPT_V : true)
  const left = {
    diffs: entries.filter(e => !existsSync(resolve(diffDir, `${e.sha}.diff`))).length,
    summaries: entries.filter(e => !e.noise && !isCurrent(e)).length,
    eli5: entries.filter(e => eli5Eligible(e) && !eli5Done(e)).length
  }

  // 3. Publish, so a run of thousands of passes never loses work to a kill.
  if (argv.includes('--push')) {
    await commitAndPushData({ message: `data: coverage backfill (${utcStamp()} UTC)`, overrides: { [`${DATA}/changelog.json`]: doc } })
  } else {
    await persistMerged(await capturePendingWrites(DATA, { [`${DATA}/changelog.json`]: doc }))
  }

  log(`[enrich-all] +${stored} diffs, +${calls} summaries, +${eli5} eli5 | left: ${left.diffs} diffs, ${left.summaries} summaries, ${left.eli5} eli5`)
  return left
}
/**
 * One-off repair of the stored history: rewrite every timestamp to UTC and
 * recompute the day/month keys derived from it.
 *
 * `%cI` handed us the author's offset (`2025-11-24T17:25:50-08:00`) and the
 * renderer compares those strings lexicographically and slices them for day
 * keys, which ignores the offset entirely: 2,370 entries were filed under the
 * author's local calendar day and 371 of 645 release windows held the wrong
 * commits. `decorate` normalizes on the way in now; this repairs the rows that
 * were stored before it did. Safe to re-run -- an already-UTC entry is skipped.
 */
async function cmdNormalizeDates (argv) {
  const { acquired } = await withLock(LOCK, async () => {
    const doc = await readJson(`${DATA}/changelog.json`, null)
    if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
    let moved = 0
    for (const e of doc.entries) {
      const was = `${e.date}|${e.day}`
      normalizeDate(e)
      if (`${e.date}|${e.day}` !== was) moved++
    }
    if (!moved) { log('[normalize-dates] every stored date is already UTC: nothing to do'); return 0 }
    if (argv.includes('--push')) {
      await commitAndPushData({ message: `data: normalize stored commit dates to UTC (${moved} rows)`, overrides: { [`${DATA}/changelog.json`]: doc } })
    } else {
      await persistMerged(await capturePendingWrites(DATA, { [`${DATA}/changelog.json`]: doc }))
    }
    log(`[normalize-dates] rewrote ${moved} entries`)
    return moved
  })
  if (!acquired) log('[normalize-dates] another generate/backfill run holds the worktree lock: retry shortly')
}

/**
 * Broadcast new commits to a Discord webhook.
 * Tracks last broadcast SHA in data/state.json to prevent duplicate broadcasts.
 */
export async function cmdBroadcast (argv = [], { fetchImpl = globalThis.fetch, dataDir = DATA } = {}) {
  const webhookIdx = argv.indexOf('--webhook')
  const webhook = webhookIdx !== -1 ? argv[webhookIdx + 1] : process.env.DISCORD_WEBHOOK_URL
  const limitIdx = argv.indexOf('--limit')
  const limit = limitIdx !== -1 ? Math.max(1, Number(argv[limitIdx + 1]) || 5) : 5
  const dryRun = argv.includes('--dry-run')
  const force = argv.includes('--force')
  const plainOnly = argv.includes('--plain') || argv.includes('--eli5')

  if (!webhook && !dryRun) {
    console.error('Error: Discord webhook URL required (via --webhook <url> or DISCORD_WEBHOOK_URL env var).')
    if (IS_MAIN) process.exit(1)
    return { ok: false, error: 'missing_webhook' }
  }

  const doc = await readJson(`${dataDir}/changelog.json`, null)
  if (!doc?.entries?.length) {
    console.error('Error: changelog.json missing: run generate first.')
    if (IS_MAIN) process.exit(1)
    return { ok: false, error: 'missing_changelog' }
  }

  const statePath = `${dataDir}/state.json`
  const state = (await readJson(statePath, null)) || {}
  const lastBroadcast = state.lastBroadcastSha

  // Candidates: meaningful commits only
  const meaningful = doc.entries.filter(e => !e.noise)
  let pending = []

  if (force || !lastBroadcast) {
    pending = meaningful.slice(0, limit).reverse()
  } else {
    const idx = meaningful.findIndex(e => e.sha === lastBroadcast)
    if (idx === -1) {
      pending = meaningful.slice(0, 1)
    } else if (idx > 0) {
      pending = meaningful.slice(0, idx).reverse().slice(0, limit)
    }
  }

  if (!pending.length) {
    log('[broadcast] no new commits to broadcast')
    return { ok: true, count: 0 }
  }

  log(`[broadcast] ${pending.length} commit${pending.length === 1 ? '' : 's'} to broadcast${dryRun ? ' (dry-run)' : ''}${plainOnly ? ' [plain english]' : ''}`)

  const { discordText } = await import('./lib/site.mjs')
  const { buildStoryIndex } = await import('./lib/story.mjs')
  const storyIndex = buildStoryIndex(doc.entries)

  let sent = 0
  for (const e of pending) {
    const text = discordText(e, { plainOnly, storyNotes: storyIndex.notes.get(e.sha) })
    if (dryRun) {
      console.log(`\n--- [DRY-RUN BROADCAST${plainOnly ? ' (PLAIN ENGLISH)' : ''} ${e.sha.slice(0, 10)}] ---\n${text}\n-----------------------------------\n`)
      sent++
      continue
    }

    let retries = 3
    let ok = false
    while (retries > 0) {
      try {
        const res = await fetchImpl(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(15000)
        })
        if (res.ok || res.status === 204) {
          ok = true
          break
        }
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}))
          const waitMs = Math.round((Number(body.retry_after) || 1) * 1000) + 500
          log(`[broadcast] Discord rate limited: waiting ${waitMs}ms`)
          await new Promise(r => setTimeout(r, waitMs))
        } else {
          log(`[broadcast] Discord HTTP error ${res.status}: ${await res.text().catch(() => '')}`)
          break
        }
      } catch (err) {
        log(`[broadcast] webhook POST failed: ${err.message}`)
      }
      retries--
      if (retries > 0) await new Promise(r => setTimeout(r, 1000))
    }

    if (ok) {
      sent++
      state.lastBroadcastSha = e.sha
      state.updatedAt = new Date().toISOString()
      await writeJson(statePath, state)
      log(`[broadcast] sent commit ${e.sha.slice(0, 10)}: ${e.ai?.title || e.title}`)
      await new Promise(r => setTimeout(r, 300))
    } else {
      log(`[broadcast] stopping broadcast after failed delivery for ${e.sha.slice(0, 10)}`)
      break
    }
  }

  log(`[broadcast] finished: ${sent}/${pending.length} sent`)
  return { ok: true, count: sent }
}

