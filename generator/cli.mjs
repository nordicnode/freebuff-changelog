// generator/cli.mjs - entrypoint: generate (analyze upstream -> data/) and
// build (data/ → dist/ static site).
//
//   node generator/cli.mjs generate [--repo URL] [--full]
//   node generator/cli.mjs build
//   node generator/cli.mjs preview [port]
import { mkdir, readFile, rm, cp } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { git, readJson, writeJson, writeText, log, ymd, toUtc, normalizeDate, pruneDiffs, pool, withLock, withDeadline, deadlineAt } from './lib/util.mjs'
import { capturePendingWrites, persistMerged, mergeOpenPrs, pickAiRecord } from './lib/mergedata.mjs'
import {
  listCommits, isSyncCommit, analyzeSyncCommit, analyzeCommunityCommit,
  extractCleanDiff, churnLabel, testLabel, SYNC_SUBJECT, TEST_RE, extractRawDiff, EMPTY_TREE, commitNatureOf, significanceOf, securityHint,
  extractStructuredFacts, hasStructuredFacts, discoverGlossary } from './lib/analyze.mjs'
import {  enrichWithLlm, enrichEli5, eli5Eligible, eli5Done, countPendingEli5, llmConfigured, llmCallCount, llmConcurrency, llmProviderBanner, planLlmPass, rowBudgetMs, eli5RowBudgetMs, warmLlmRpmWindow, verifyConfigured, PROMPT_V, ELI5_V, RELEASE_ROLLUP_V, bumpOnly, collectReleaseContext, formatReleaseContext, aiDone, pruneStaleCache, rememberClosedPrs, enrichOpenPrs, attachPrSummaries, diffPaths, loadGlossary, enrichmentEligible, releaseFailedRows, shortError, errorRetryDelayMs } from './lib/llm.mjs'
import { QUALITY_POLICY_V, generationState, regenUnfinished } from './lib/quality.mjs'
import { shortHash, eli5Source } from './lib/util.mjs'
import { EVIDENCE_WIDTH_WARN, evidenceStats, gcEvidence, liveEvidenceHashes, spillEntryEvidence, spillEvidence } from './lib/evidence.mjs'
import { changelogBytes, loadChangelog, saveChangelog } from './lib/changelog-store.mjs'
import { forwardRollupBacklog, generateRollup, loadRollups, rollupBacklog, rollupFingerprint, ROLLUP_V } from './lib/rollup.mjs'
import { SIZE_MAX_BYTES, SIZE_WARN_BYTES, findOverBudget, sizeText } from './lib/sizebudget.mjs'
import { syncReason, syncStaleMs } from './lib/sync.mjs'
import { buildSite } from './lib/site.mjs'

// A promoted runtime may live under .cache while data/git stay in the checkout.
const ROOT = process.env.CHANGELOG_WORKSPACE_ROOT ? resolve(process.env.CHANGELOG_WORKSPACE_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
  const clean = await extractCleanDiff(REPO_DIR, base, e.sha, 8000000, !e.testOnly)
  if (clean.trim()) return clean
  // Stale entries built before testOnly existed (or with narrower TEST_RE)
  // carry no flag, so the exclusion above empties their patch. Retry without
  // the test exclusion before giving up; churn rows stay empty either way.
  if (!e.testOnly) {
    const incl = await extractCleanDiff(REPO_DIR, base, e.sha, 8000000, false)
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
  const clean = await extractCleanDiff(REPO_DIR, base, e.sha, 8000000)
  return clean.trim() ? clean : extractRawDiff(REPO_DIR, base, e.sha, 8000000)
}

// The full stored diff (test hunks included), for the structured-facts
// extractor: test titles are the point, and the prompt patch strips them.
// Disk first, git second, never fails the caller.
async function fullPatchFor (e) {
  try { return await readFile(resolve(DATA, `diffs/${e.sha}.diff`), 'utf8') } catch {}
  try { return await storedDiffFor(e) } catch { return '' }
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
        Boolean(o.hasDiff) !== Boolean(n.hasDiff) || Boolean(o.stalePreview) !== Boolean(n.stalePreview) || (o.body || '') !== (n.body || '') || o.reviewState !== n.reviewState) {
      return false
    }
    if (JSON.stringify(o.enrichment || null) !== JSON.stringify(n.enrichment || null)) return false
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
  const PR_CALL_BUDGET = Math.min(40, Number(process.env.CHANGELOG_PR_CALLS) ||
    (process.env.GITHUB_TOKEN ? 500 : 25))
  const deadline = Math.min(deadlineAt(), Date.now() + 60000)
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
  const get = (url) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('PR refresh deadline exceeded')
    return fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.min(15000, remaining)) })
  }
  // GitHub's own count, from one `per_page=1` request: with one row per page the
  // `rel="last"` page number *is* the number of open PRs. Never derived from the
  // rows we happened to receive -- that is the arithmetic that reported 60.
  const probeTotal = async () => {
    try {
      const res = await get(`${LIST}?state=open&sort=created&direction=desc&per_page=1`)
      if (!res.ok) return null
      const last = lastPage(res)
      if (last != null) return last
      const rows = await res.json()
      return Array.isArray(rows) ? rows.length : null
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
        // The description is the author's stated intent: the summary prompt
        // quotes it, and it was never stored before, so findPrMeta().body was
        // always empty. Bounded: some PR templates run to pages.
        body: typeof p.body === 'string' ? p.body.slice(0, 4000) : '',
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
    const complete = !stoppedEarly && (total == null || prs.length >= total)
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
      if (!prev) {
        if (cached?.fetchedAt) p.enrichment = { policy: QUALITY_POLICY_V, admittedAt: new Date().toISOString() }
        continue
      }
      if (prev.enrichment) p.enrichment = prev.enrichment
      if (prev.stalePreview) p.stalePreview = true
      if (prev.updated && p.updated && prev.updated !== p.updated) {
        p.enrichment = { policy: QUALITY_POLICY_V, admittedAt: new Date().toISOString() }
        p.stalePreview = true
        continue
      }
      if (p.additions == null && prev.additions != null) {
        p.additions = prev.additions; p.deletions = prev.deletions; p.files = prev.files
      }
      const discussionChanged = (prev.comments ?? 0) !== p.comments || (prev.reviewComments ?? 0) !== p.reviewComments
      if (discussionChanged) delete p.commentsList
      if (p.reviewState == null && prev.reviewState != null) p.reviewState = prev.reviewState
      if (!p.hasDiff && prev.hasDiff) p.hasDiff = true
      if ((!p.labels || p.labels.length === 0) && prev.labels?.length) p.labels = prev.labels
      if (!p.commitsList && prev.commitsList) p.commitsList = prev.commitsList
      if (!discussionChanged && !p.commentsList && prev.commentsList) p.commentsList = prev.commentsList
    }
    // PRs that left the open list since the last complete fetch: remember them,
    // so the sync commit that lands them later still finds its PR context.
    // Only a complete walk may conclude that a missing number has closed.
    if (complete && cachedPrs.length) {
      const mergedPath = `${dataDir}/merged-prs.json`
      // The preview diff is read now, before prunePrDiffs deletes it: its file
      // paths are what lets a later sync commit be matched back to this PR.
      const pathsOf = (p) => { try { return diffPaths(readFileSync(resolve(dataDir, `pr-diffs/${p.number}.diff`), 'utf8')) } catch { return [] } }
      // Disappearance proves closure, not merge. Unknown closures are retained
      // for audit but excluded from shipped-intent matching until confirmed.
      const { doc: mergedDoc, added } = rememberClosedPrs(cachedPrs, list, await readJson(mergedPath, { prs: [] }), new Date().toISOString(), { pathsOf })
      if (added) {
        await writeJson(mergedPath, mergedDoc)
        log(`open PRs: ${added} left the open list; remembered in merged-prs.json (${mergedDoc.prs.length} kept)`)
      }
    }
    // The list endpoint omits additions/deletions/changed_files entirely, so
    // every extra number on a card costs a call: budget them, and stop asking
    // the moment GitHub refuses. Diffs first -- a preview a reader can open is
    // worth more than a diffstat -- then stats for whatever is still unknown.
    let used = 0
    let refused = false
    const ghGet = async (path, accept) => {
      if (refused || used >= PR_CALL_BUDGET || Date.now() >= deadline) return null
      used++
      try {
        const r = await fetchImpl(`https://api.github.com${path}`, { headers: { ...headers, ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))) })
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
    // Verify merge-vs-close with the same bounded GitHub budget. Older unknown
    // closures are retried too, so one failed request cannot suppress recovery.
    const closedPath = `${dataDir}/merged-prs.json`
    const closedDoc = await readJson(closedPath, null)
    let closedChanged = false
    await pool((closedDoc?.prs || []).filter(p => p.closureState === 'unknown' || p.merged === undefined).slice(-10).map(p => async () => {
      const full = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}`)
      if (full?.state === 'closed' && typeof full.merged === 'boolean') {
        p.merged = full.merged
        p.closureState = full.merged ? 'merged' : 'closed-unmerged'
        p.closureCheckedAt = new Date().toISOString()
        closedChanged = true
      }
    }), 2)
    if (closedChanged) { closedDoc.updatedAt = new Date().toISOString(); await writeJson(closedPath, closedDoc) }
    // Inline diff preview: persisted in data/pr-diffs/, served from
    // /pr-diffs/<n>.diff. A missing file degrades to a GitHub link, and PRs
    // already on disk are skipped -- so a steady list costs nothing.
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises')
    await mk(resolve(dataDir, 'pr-diffs'), { recursive: true })
    const previewPath = (n) => resolve(dataDir, `pr-diffs/${n}.diff`)
    await pool(list.filter(p => !p.hasDiff || p.stalePreview || !existsSync(previewPath(p.number))).map(p => async () => {
      const diff = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}`, 'application/vnd.github.diff')
      if (typeof diff === 'string' && diff.startsWith('diff --git')) {
        await wf(previewPath(p.number), diff)
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
      if (Array.isArray(issueComments) && (!(p.reviewComments > 0) || Array.isArray(reviewComments))) p.commentsList = cList
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
      if (!p.stalePreview && !p.hasDiff && existsSync(previewPath(p.number))) p.hasDiff = true
      // A failed revision refresh stays stale until a successful fetch.
    }
    // Say what is missing and why, in the same breath as the budget: a reader
    // of the log should not have to infer that 116 PRs and 25 calls do not
    // meet, or that the gap is being closed on purpose.
    const noDiff = list.filter(p => !p.hasDiff || p.stalePreview).length
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
    // If data changed, or force is set, or fetchedAt is older than 60m: refresh fetchedAt on disk
    // so the site doesn't falsely warn that the sync has stalled when the upstream repo is quiet.
    const staleDiskCheck = cached?.fetchedAt ? (Date.now() - (Date.parse(cached.fetchedAt) || 0) > 60 * 60000) : true
    if (hasChanges || force || staleDiskCheck) {
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

export async function fetchTrafficClones ({
  fetchImpl = globalThis.fetch,
  dataDir = DATA,
  repo = process.env.CHANGELOG_REPO || 'nordicnode/freebuff-changelog',
  force = false
} = {}) {
  // Traffic metrics update periodically on GitHub's backend; a 60-minute cadence
  // keeps figures fresh while conserving API quota.
  const TRAFFIC_REFRESH_MIN = Number(process.env.CHANGELOG_TRAFFIC_REFRESH_MIN) || 60
  const trafficPath = resolve(dataDir, 'traffic.json')
  const cached = await readJson(trafficPath, null)

  const cachedFetched = cached?.fetchedAt ? Date.parse(cached.fetchedAt) : 0
  const age = cachedFetched ? Date.now() - cachedFetched : Infinity
  if (!force && cached && cached.count != null && age < TRAFFIC_REFRESH_MIN * 60000) {
    return cached
  }

  const token = process.env.CHANGELOG_GITHUB_TOKEN || process.env.GITHUB_TOKEN
  const headers = {
    'user-agent': 'freebuff-changelog',
    accept: 'application/vnd.github+json'
  }
  if (token) headers.authorization = `Bearer ${token}`

  try {
    const url = `https://api.github.com/repos/${repo}/traffic/clones`
    const remaining = deadlineAt() - Date.now()
    if (remaining <= 0) return cached
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining))) })
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        log(`traffic clones (${repo}): HTTP ${res.status}${token ? '' : ' (no token set)'}${cached ? ': keeping cached traffic' : ''}`)
      }
      return cached
    }
    const data = await res.json()
    if (typeof data?.count !== 'number') {
      return cached
    }

    // Merge daily breakdown history so days rolling off the 14-day window are preserved
    const existingClones = Array.isArray(cached?.clones) ? cached.clones : []
    const cloneMap = new Map(existingClones.map(c => [c.timestamp, c]))
    for (const c of (data.clones || [])) {
      if (c?.timestamp) cloneMap.set(c.timestamp, c)
    }
    const mergedClones = [...cloneMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const record = {
      count: data.count,
      uniques: data.uniques ?? 0,
      clones: mergedClones,
      fetchedAt: new Date().toISOString()
    }

    const countChanged = cached?.count !== record.count || cached?.uniques !== record.uniques
    if (countChanged || force || age >= TRAFFIC_REFRESH_MIN * 60000) {
      await writeJson(trafficPath, record)
      log(`traffic clones: ${record.count} clones (${record.uniques} unique) over 14 days`)
    }
    return record
  } catch (err) {
    log(`traffic clones fetch failed: ${String(err?.message || err).slice(0, 120)}`)
    return cached
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
  const weight = significanceOf(e)
  e.significance = weight.significance
  e.significanceReason = weight.reason
  if (securityHint(e)) {
    e.tags = e.tags || []
    if (!e.tags.includes('security')) e.tags.push('security')
  }
  e.day = ymd(e.date)
  e.month = ymd(e.date).slice(0, 7)
  return e
}

// Re-derive every field that later rules compute from the stored shape of a
// row, without touching titles, summaries or AI text. Stored history predates
// several of them: commitNature was on 37 of 9,686 rows, significanceReason on
// none, the security tag on none. Idempotent; returns how many rows changed.
export function repairEntry (e, { diffText = null } = {}) {
  if (!e || !e.files) return false
  let changed = false
  const set = (k, v) => { if (e[k] !== v) { e[k] = v; changed = true } }
  if (e.noise) {
    set('commitNature', 'churn')
    return changed
  }
  // Structured facts from the stored diff, for rows analyzed before the
  // extractor existed (the prompt and the chips both read them).
  if (diffText && !e.structuredSource?.noveltyChecked) {
    const raw = extractStructuredFacts(diffText)
    // Stored hunks alone do not prove novelty at the base revision.
    const s = { ...raw, constantsIntroduced: [], envVars: [], flags: [], testNames: [] }
    if (JSON.stringify(e.structured || null) !== JSON.stringify(s)) { e.structured = s; changed = true }
    const source = { version: 1, base: e.prevSha || null, head: e.sha, hash: shortHash(diffText), noveltyChecked: false }
    if (JSON.stringify(e.structuredSource || null) !== JSON.stringify(source)) { e.structuredSource = source; changed = true }
  }
  const testOnly = e.files.testOnly ?? ((e.files.meaningful === 0 && (e.files.rawMeaningful || 0) > 0) ||
    ([...(e.files.added || []), ...(e.files.removed || []), ...(e.files.modified || [])].length > 0 &&
     [...(e.files.added || []), ...(e.files.removed || []), ...(e.files.modified || [])].every(p => TEST_RE.test(p))))
  if (testOnly && !e.testOnly) set('testOnly', true)
  set('commitNature', commitNatureOf(e))
  const weight = significanceOf(e)
  set('significance', weight.significance)
  set('significanceReason', weight.reason)
  if (securityHint(e)) {
    e.tags = e.tags || []
    if (!e.tags.includes('security')) { e.tags.push('security'); changed = true }
  }
  return changed
}

export function repairEntries (entries, { diffDir = null } = {}) {
  let n = 0
  for (const e of entries || []) {
    let diffText = null
    if (diffDir && !e.noise && !e.structuredSource?.noveltyChecked) {
      try { diffText = readFileSync(resolve(diffDir, `${e.sha}.diff`), 'utf8') } catch {}
    }
    if (repairEntry(e, { diffText })) n++
  }
  return n
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

  const existing = (await loadChangelog(DATA)) || { version: 1, entries: [] }
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
    // Only future incremental admissions may incur provider calls. A first
    // scan or history rewrite is deterministic, never a paid backfill.
    if (state.lastSha && isAncestor && !full) e.enrichment = { policy: QUALITY_POLICY_V, admittedAt: new Date().toISOString() }
    bySha.set(c.sha, e)
    newlyAddedEntries.push(e)
    added++
    if (added % 200 === 0) log(`${added} entries so far (${c.sha.slice(0, 8)})`)
  }

  let entries = [...bySha.values()]
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sha < b.sha ? -1 : 1))

  // Persist source progress before any optional network enrichment. The
  // durable admission marker lets later bounded cycles resume new work.

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
  // Derived fields land with the analyze output too, not only at publish time.
  await repairDerivedFields(DATA)
  if (argv.includes('--push')) await commitAndPushData({ message: `data: update changelog (${utcStamp()} UTC)` })
  await backfillDiffs(newlyAddedEntries, newlyAddedEntries.length)

  const prs = await fetchOpenPrs()
  await prunePrDiffs(prs || [], await readJson(`${DATA}/open-prs.json`, null))
  refreshDiffFlags(entries, resolve(DATA, 'diffs'))
  await persistMerged({ [`${DATA}/changelog.json`]: changelog })
  await fetchTrafficClones()
  // PR previews run only in the bounded enrichment phase, never ingestion.

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
  let started = 0
  await pool(todo.map(e => async () => {
    if (started >= max || Date.now() >= deadlineAt()) return
    started++
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
// A publish must never revert derived fields. repair-entries is deterministic
// (stored diffs only, never the API) and idempotent -- a few checks on rows that
// are already current, real work only for new ones -- so the merged document is
// repaired after every write here. Without it, a writer publishing an older
// snapshot quietly strips the structured facts / significance / security tags a
// corpus-wide `repair-entries` run added; the backfill is only as safe as the
// last writer.
async function repairDerivedFields (dataDir) {
  // Through the store: the entries live in day shards now (a legacy monolith
  // still loads as itself), and only changed shards are rewritten.
  const doc = await loadChangelog(dataDir)
  if (!doc || !Array.isArray(doc.entries)) return 0
  const diffDir = resolve(dataDir, 'diffs')
  const n = repairEntries(doc.entries, { diffDir }) + refreshDiffFlags(doc.entries, diffDir)
  if (n) {
    await saveChangelog(dataDir, doc)
    log(`[repair] refreshed derived fields on ${n} row(s) before publish`)
  }
  return n
}

export async function commitAndPushData ({ message, overrides = {}, attempts = 3, root = ROOT, dataDir = DATA } = {}) {
  const branch = await currentBranch(root)
  // Where this cycle's derived files live, relative to the worktree: the only
  // path the conflict recovery is allowed to overwrite.
  const dataRel = relative(root, resolve(dataDir)) || 'data'
  const pending = await capturePendingWrites(dataDir, overrides)
  await persistMerged(pending)
  await repairDerivedFields(dataDir)
  // The pre-push gate: a file GitHub would reject must fail here, where the
  // message can name it, instead of at the remote where the whole push dies.
  await assertDataSizeBudget(root, dataDir)

  if (!await dirtyData(root)) {
    // A clean worktree is not an up-to-date one: after three failed push
    // attempts the cycle before, this cycle's data sits in an unpushed local
    // commit, and the old early return left it stranded until something else
    // made data/ dirty again (up to a full stale-budget of readers served the
    // previous state). Nothing dirty and nothing ahead really is the quiet
    // cycle; a clean tree ahead of origin just needs the push retried.
    if (!await aheadOfOrigin(branch, root)) {
      log('data is already up to date: nothing to push.')
      return false
    }
    log('worktree clean but local commits are unpushed: retrying the push.')
  } else {
    await git(['add', 'data'], root)
    await git(['commit', '-m', message], root)
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // HEAD:<branch>, not <branch>: the workflow runner can be on a detached
    // HEAD, where `push origin main` would silently push an older local ref.
    if ((await git(['push', 'origin', `HEAD:${branch}`], root, { allowFail: true })) !== null) {
      log(`pushed data to origin/${branch}: the deploy workflow builds and uploads (Cloudflare-side builds stay off).`)
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
      await repairDerivedFields(dataDir)
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

/**
 * Freshness gate for CI: fail when data/changelog.json is older than the site
 * is willing to call fresh.
 *
 * The reader-facing badge computes "[stale Nm]" from `generatedAt`, which only
 * the analyze pass moves; deploy.yml happily built and uploaded whatever was on
 * disk. So a dead sync loop showed up as a stale badge on the site and as
 * nothing at all in the Actions UI. This is the check that closes that gap --
 * the same threshold as the badge, asserted before a reader has to find it.
 */
export async function cmdFreshness (argv = [], { dataDir = DATA, now = Date.now(), env = process.env } = {}) {
  const at = argv.indexOf('--max-age-min')
  const budgetMin = Math.round(syncStaleMs(env) / 60000)
  const limitMin = at !== -1 ? Number(argv[at + 1]) || 0 : budgetMin * 2
  const doc = await readJson(`${dataDir}/changelog.json`, null)
  const then = Date.parse(doc?.generatedAt || '') || 0
  const ageMin = then ? Math.max(0, Math.floor((now - then) / 60000)) : null
  const ok = then !== 0 && ageMin < limitMin
  const summary = !then
    ? `data/changelog.json has no readable generatedAt: the sync loop has never completed an analyze pass into this branch`
    : `data/changelog.json was generated ${ageMin}m ago (head ${String(doc.headSha || '?').slice(0, 10)}); the site renders "[stale]" past ${limitMin}m`

  if (env.GITHUB_ACTIONS === 'true') {
    console.log(ok ? `::notice::${summary}` : `::error::${summary}`)
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(env.GITHUB_STEP_SUMMARY, `### Changelog freshness\n\n${ok ? '✅' : '❌'} ${summary}\n`).catch(() => {})
  }
  log(`[freshness] ${summary}`)
  if (!ok) throw new Error(`[freshness] ${summary}`)
  return { ok, ageMin, limitMin }
}

async function cmdCatchUp (argv) {
  const budgets = cycleBudgets()
  // Two phases, two clocks. The git/network phase keeps its own four-minute
  // deadline (a hung fetch must not spend the cycle), and the paid phase gets
  // its own window measured from when it actually starts -- see catchUpOnce.
  // The outer deadline is only a backstop that contains both.
  const outerMs = budgets.gitBudgetMs + Math.max(budgets.llmBudgetMs, 60000) + 30000
  const { acquired } = await withLock(LOCK, () => withDeadline(outerMs, () => catchUpOnce(argv, budgets)))
  if (!acquired) log('another generate/backfill run holds the worktree lock: skipping this cycle')
  // The loop reads this to tell "a peer holds the lock" (healthy, the site is
  // being kept fresh by someone) apart from "this cycle did nothing" (broken).
  return { acquired: Boolean(acquired) }
}

const GIT_BUDGET_DEFAULT_MS = 240000
const LLM_CYCLE_BUDGET_DEFAULT_MS = 300000

// A configured duration, or the fallback when the value is absent or unusable.
// `allowZero` is for the paid window, where 0 is a real answer: the watch run
// has nothing left and this cycle must not start work it cannot finish.
function durationMs (value, fallback, { allowZero = false } = {}) {
  const n = Number(value)
  if (Number.isFinite(n) && (n > 0 || (allowZero && n === 0))) return n
  return fallback
}
// Below this there is not enough wall clock for even one row, so the paid
// phases are skipped instead of being started on a window that cannot hold a
// call. A skipped cycle is visible in the log and costs nothing.
const MIN_ENRICH_MS = 45000

/**
 * How much wall clock this cycle may spend, per phase.
 *
 * The failure this replaces: every phase was scheduled against one 240s clock
 * armed at cycle start. A sync that took 20-60s then left the summary pass a
 * nominal ~60s window, of which the ELI5 reserve (limit * 15s = 150s for the
 * CI's limit of 10) was subtracted first -- so `summaryDeadline` was routinely
 * already in the past, and every queued row answered "LLM cycle deadline
 * exceeded" without a single call being sent. Ten relay cycles in a row wrote
 * nothing. The paid window is now sized from the operator's budget, capped by
 * what is left of the watch run, and armed only when the paid phase begins.
 */
function cycleBudgets (env = process.env) {
  const positive = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const gitBudgetMs = positive(env.CHANGELOG_GIT_BUDGET_MS, GIT_BUDGET_DEFAULT_MS)
  const configured = positive(env.CHANGELOG_LLM_CYCLE_BUDGET_MS, LLM_CYCLE_BUDGET_DEFAULT_MS)
  // The watch loop publishes how long its run has left before each cycle: a
  // 12-minute run whose first cycle spent 10 minutes would otherwise overrun
  // its own duration limit and be killed with nothing published. A minute of
  // the remainder stays unspent so the git phase of the next cycle always fits.
  const remaining = positive(env.CHANGELOG_WATCH_REMAINING_MS, 0)
  const llmBudgetMs = remaining > 0
    ? Math.max(0, Math.min(configured, remaining - gitBudgetMs - 60000))
    : configured
  return { gitBudgetMs, llmBudgetMs }
}

/**
 * How much of the paid window the summary pass may take, leaving the
 * plain-English drain a slice of its own.
 *
 * The reserve is a *share* of the window as well as a per-row amount, which is
 * the arithmetic fix that matters: the old reserve (`limit * 15s`, floored at
 * 60s) was subtracted from a clock already spent by the sync phase, so the
 * summary pass was routinely handed a window in the past. A share can never
 * exceed the window it is taken from, so there is always a summary window --
 * and a pass too short to hold a row says so instead of pretending.
 */
export function summaryPassWindow (startAt, endsAt, reserveFor, env = process.env) {
  const total = Math.max(0, endsAt - startAt)
  // No pending plain-English work means nothing to reserve: the summary pass
  // takes the whole window. A reserve held against an empty queue is exactly
  // how a cycle ends up under-using its budget by design.
  if (!(Number(reserveFor) > 0)) return total
  const perRow = Number(env.CHANGELOG_LLM_ELI5_RESERVE_PER_ROW_MS) > 0 ? Number(env.CHANGELOG_LLM_ELI5_RESERVE_PER_ROW_MS) : 10000
  const reserve = Math.min(Math.max(45000, Number(reserveFor) * perRow), Math.round(total * 0.35))
  return Math.max(0, total - reserve)
}

// Phase 1 of a cycle: the network and the clone.
//
// It gets its own clock (the documented four-minute git/network deadline) so a
// hung fetch is bounded, and -- just as important -- so the paid phases that
// follow can be armed with a deadline measured from when they start instead of
// inheriting whatever this phase left of one clock armed at cycle start.
async function syncPhase (argv) {
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

  // 1.5. Refresh open PRs and traffic clones even when git main is quiet, so newly opened, updated,
  //      or merged PRs appear on /in-flight/ quickly rather than waiting up to
  //      45m for the next commit-sync cycle.
  let didPrSync = false
  if (!didSync) {
    const prevPrs = await readJson(`${DATA}/open-prs.json`, null)
    const prs = await fetchOpenPrs()
    if (prs) {
      await prunePrDiffs(prs, await readJson(`${DATA}/open-prs.json`, null))
    }
    await fetchTrafficClones()
    didPrSync = Boolean(await dirtyData())
  } else {
    await fetchTrafficClones()
  }

  // 2. Snapshot *after* the sync — generate rewrote changelog.json, so a copy
  //    taken before it would be stale by write time.
  const existing = (await loadChangelog(DATA)) || { version: 1, entries: [] }

  // 3. Publish new entries before the slow part. A commit that arrives at
  //    16:20 must be readable by ~16:22, not after this cycle's LLM batch
  //    finishes (~2min later) — the summary is enrichment, the row is the news.
  if (argv.includes('--push') && freshShas.length) {
    await commitAndPushData({
      message: `data: update changelog (${utcStamp()} UTC)`,
      overrides: { [`${DATA}/changelog.json`]: existing }
    })
  }

  return { existing, freshShas, didSync, didPrSync }
}

async function catchUpOnce (argv, budgets = {}) {
  // Fail before spending: an over-budget tracked file means this cycle cannot
  // publish, so the paid phases must not run for a push that will be refused.
  await assertDataSizeBudget(ROOT, DATA)
  const gitBudgetMs = durationMs(budgets.gitBudgetMs, GIT_BUDGET_DEFAULT_MS)
  const llmBudgetMs = durationMs(budgets.llmBudgetMs, LLM_CYCLE_BUDGET_DEFAULT_MS, { allowZero: true })
  // Phase 1 (sync, PR refresh, the first publish) under its own clock, then the
  // paid phases under their own. Nothing below this line is charged to the git
  // phase's clock.
  const { existing, freshShas, didSync, didPrSync } = await withDeadline(gitBudgetMs, () => syncPhase(argv))
  const entries = existing.entries || []
  if (!entries.length) {
    log('no entries after sync: nothing to backfill')
    return
  }
  const queueable = entries.filter(e => !e.noise && enrichmentEligible(e, { CHANGELOG_LLM_NO_BACKFILL: '1' }))
  const isCurrent = (e) => e.ai?.title && (process.env.CHANGELOG_LLM_FORCE_REWRITE === '1' ? (e.ai?.v ?? 1) >= PROMPT_V : true)
  const unsummarized = queueable.filter(e => !isCurrent(e))
  // Name the wait, not just the count: "3 remaining" with no attempts looks
  // stuck, when two rows are cooling until their retry window and one is
  // parked for a named release. Read from the same cache the queue gates on.
  {
    const cache = await readJson(`${DATA}/ai-summaries.json`, {})
    const cdMs = Number(process.env.CHANGELOG_LLM_ERROR_COOLDOWN_MS || 3600000)
    const trMs = Number(process.env.CHANGELOG_LLM_TRANSIENT_RETRY_MS || 300000)
    const maxA = Number(process.env.CHANGELOG_LLM_MAX_ATTEMPTS) > 0 ? Number(process.env.CHANGELOG_LLM_MAX_ATTEMPTS) : 3
    let cooling = 0, parked = 0
    for (const e of unsummarized) {
      const recs = Object.entries(cache)
        .filter(([k, v]) => k.split(':')[0] === e.sha && v?.error && (v?.v ?? 1) >= 1)
        .map(([, v]) => v)
      if (!recs.length) continue
      if (recs.some(r => !r.error)) continue
      const states = recs.map(r => errorRetryDelayMs(r, { errorCooldownMs: cdMs, transientRetryMs: trMs, maxAttempts: maxA }))
      if (states.every(s => s === Infinity)) { parked++; continue }
      const ready = recs.some(r => {
        const d = errorRetryDelayMs(r, { errorCooldownMs: cdMs, transientRetryMs: trMs, maxAttempts: maxA })
        return d !== Infinity && Date.now() - (Date.parse(r.at || '') || 0) >= d
      })
      if (!ready) cooling++
    }
    const eligible = unsummarized.length - cooling - parked
    log(`[enrichment] ${queueable.length} total entries (${unsummarized.length} remaining to summarize: ${eligible} eligible, ${cooling} cooling, ${parked} parked)`)
  }

  let limit = Number(process.env.CHANGELOG_LLM_LIMIT || 5)
  const limitIdx = argv.indexOf('--limit')
  if (limitIdx !== -1 && argv[limitIdx + 1]) {
    limit = Number(argv[limitIdx + 1]) || limit
  }

  let didSummarize = false
  // The paid phases run back to back (summary+verify+heal+re-check, then the
  // plain-English drain, then PR previews), and each gets its own window -- but
  // a window measured from *when that phase starts*, sized by the operator's
  // cycle budget, and planned down to the number of rows it can actually
  // finish. The old arithmetic armed one deadline at cycle start with
  // `cycleDeadline - limit * 15s` reserved for ELI5: with the CI's limit of 10
  // that reserve was 150s of a 240s clock, so once a sync had taken ~30s the
  // summary deadline was ~60s out and a single 300s call could never answer.
  // Every queued row then died with "LLM cycle deadline exceeded" before a call
  // was even sent -- ten consecutive relay cycles, zero rows, and 254 such stubs
  // in the cache.
  const now = Date.now()
  // The paid window: never past the watch run's own remaining time (a cycle
  // that overruns its duration limit is killed with nothing published).
  const enrichEndsAt = Math.min(deadlineAt(), now + Math.max(0, llmBudgetMs))
  const cycleEnvBase = { ...process.env, CHANGELOG_LLM_NO_BACKFILL: '1' }
  if (llmConfigured()) log(llmProviderBanner())
  if (llmConfigured() && llmBudgetMs >= MIN_ENRICH_MS) {
    // The warmup is a fixed cost of the first paid call in a process (a quiet
    // RPM window) and it is deliberately spent before any pass deadline is
    // armed: charged to a pass it used to kill the pass outright.
    await warmLlmRpmWindow(process.env)
    // Day roll-ups run first, on their own bounded slice. One digest a day is
    // pending, and the entry passes below will consume every remaining second
    // if allowed -- measured: the summary and plain-English drains filled whole
    // cycles and the digest was never reached, a day after its day settled. The
    // slice comes out of this cycle's paid window, so the entry passes simply
    // get that much less on the one cycle a digest is due.
    const rollupEndsAt = Math.min(enrichEndsAt, Date.now() + Math.max(0, Number(process.env.CHANGELOG_ROLLUP_BUDGET_MS || 90000)))
    didSummarize = didSummarize || (await writeSettledRollups(entries, { endsAt: rollupEndsAt })) > 0
    const enrichStart = Date.now()
    // Only reserve for the plain-English drain when it actually has work: the
    // reserve is a share of one window, and holding it against an empty queue
    // left the summary pass a third of the budget with nothing to spend it on.
    const eli5Backlog = countPendingEli5(queueable)
    const summaryWindow = summaryPassWindow(enrichStart, enrichEndsAt, eli5Backlog > 0 ? limit : 0)
    const summaryPlan = planLlmPass({
      budgetMs: summaryWindow,
      limit,
      concurrency: llmConcurrency(process.env),
      rowBudgetMs: rowBudgetMs(process.env)
    })
    await backfillDiffs(queueable, Math.max(summaryPlan.rows, 1))
    let n = 0
    if (summaryPlan.usable) {
      log(`[enrichment] summary pass: up to ${summaryPlan.rows} row(s) in ${Math.round(summaryWindow / 1000)}s (${Math.round(summaryPlan.rowBudgetMs / 1000)}s per row)`)
    } else {
      log(`[enrichment] summary pass skipped: ${summaryPlan.reason}`)
    }
    const summaryEnv = {
      ...cycleEnvBase,
      CHANGELOG_LLM_LIMIT: String(Math.max(summaryPlan.rows, 1)),
      LLM_DEADLINE_AT: String(enrichStart + summaryWindow),
      LLM_CYCLE_BUDGET: { remaining: Math.max(40, Math.max(summaryPlan.rows, 1) * 8) }
    }
    if (summaryPlan.usable) n = await enrichWithLlm(entries, llmPatchFor, DATA, summaryEnv, {
      retryErrors: true,
      // This cycle's commits go first; the backlog can wait, the news cannot.
      priorityShas: new Set(freshShas.slice(-summaryPlan.rows)),
      repoDir: REPO_DIR,
      // The full stored diff, same as generate and enrich-all: without it a
      // CI-sourced row never re-extracts structured facts from the whole diff
      // and ships without the constants/env/flag/test-title evidence the
      // other two passes hand the model.
      getFullPatch: fullPatchFor
    })
    const remaining = queueable.filter(e => !isCurrent(e)).length
    log(`[enrichment] enriched ${n} entries with LLM (${remaining} remaining)`)
    didSummarize = remaining < unsummarized.length
  } else if (llmConfigured()) {
    // Deliberately skipped, and said so: starting a pass on a window that
    // cannot hold one call is what burned 254 deadline stubs.
    log(`[enrichment] paid work skipped this cycle: ${Math.round(llmBudgetMs / 1000)}s of budget is under the ${Math.round(MIN_ENRICH_MS / 1000)}s floor`)
  } else {
    log('LLM not configured (CHANGELOG_LLM=1 and LLM_API_KEY required in .env)')
  }

  // The ELI5 drain sits *outside* that branch on purpose. In the steady state
  // every summary already exists, so nothing below the first if would ever run
  // and the plain-English backlog would never move; and a commit summarized a
  // few lines above needs its line in the same cycle, not the next one.
  if (llmConfigured() && llmBudgetMs >= MIN_ENRICH_MS) {
    // Whatever the summary pass left is the plain-English pass's slice, planned
    // the same way. A summary written a few lines above gets its line in this
    // same cycle, and a summary that could not be written does not consume a
    // plain-English slot (eli5Eligible requires the summary).
    const eli5Start = Date.now()
    const eli5Window = Math.max(0, enrichEndsAt - eli5Start)
    const eli5Plan = planLlmPass({
      budgetMs: eli5Window,
      limit: countPendingEli5(queueable),
      concurrency: llmConcurrency(process.env),
      rowBudgetMs: eli5RowBudgetMs(process.env)
    })
    let eli5Written = 0
    if (eli5Plan.usable) {
      log(`[enrichment] plain-English pass: up to ${eli5Plan.rows} line(s) in ${Math.round(eli5Window / 1000)}s (${Math.round(eli5Plan.rowBudgetMs / 1000)}s per row)`)
      eli5Written = await enrichEli5(entries, DATA, {
        ...cycleEnvBase,
        CHANGELOG_ELI5_LIMIT: String(eli5Plan.rows),
        LLM_DEADLINE_AT: String(enrichEndsAt),
        LLM_CYCLE_BUDGET: { remaining: Math.max(20, eli5Plan.rows * 4) }
      }, {
        retryErrors: true,
        priorityShas: new Set(freshShas.slice(-Math.max(eli5Plan.rows, 1))),
        getPatch: llmPatchFor,
        getFullPatch: fullPatchFor,
        repoDir: REPO_DIR
      })
    } else {
      log(`[enrichment] plain-English pass skipped: ${eli5Plan.reason}`)
    }
    const eli5Remaining = countPendingEli5(queueable)
    if (eli5Written || eli5Remaining) {
      log(`[enrichment] ELI5 wrote ${eli5Written} entries (${eli5Remaining} remaining)`)
    }
    didSummarize = didSummarize || eli5Written > 0
    const prDoc = await readJson(`${DATA}/open-prs.json`, null)
    const prStart = Date.now()
    if (prDoc?.prs?.length && prStart < enrichEndsAt) {
      // Same reason: PR previews get their own small pool and time slice
      // instead of whatever the two passes above happen to leave behind.
      const prEnv = {
        ...cycleEnvBase,
        LLM_DEADLINE_AT: String(Math.min(enrichEndsAt, prStart + Math.max(60000, limit * 30000))),
        LLM_CYCLE_BUDGET: { remaining: Math.max(10, limit * 2) }
      }
      const previews = await enrichOpenPrs(prDoc.prs, DATA, prEnv, { getDiff: p => readFile(resolve(DATA, `pr-diffs/${p.number}.diff`), 'utf8').catch(() => '') })
      if (previews) { await persistMerged({ [`${DATA}/open-prs.json`]: prDoc }); didSummarize = true }
    }
  }
  // Checkpoint successes even without a publish; a deadline or push failure
  // must not discard completed forward-only work.
  await persistMerged(await capturePendingWrites(DATA, { [`${DATA}/changelog.json`]: { ...existing, entries } }))

  // Evidence hygiene before the publish: persistMerged above just wrote every
  // cache record and entry copy that can name a shard, so anything the store
  // no longer references is a true orphan, and a legacy flat shard moves to
  // its fan-out directory in the same commit. Deliberately under this cycle's
  // lock (cmdCatchUp): a shard is written moments before the record naming it
  // is persisted, and only the lock keeps that window from looking like
  // garbage.
  await gcEvidenceNow()

  // 4. Publish again, this time with the summaries in. Still unconditional on
  //    --push rather than gated on didSummarize: an upstream-only move is
  //    exactly the case that was stalling, and leftover uncommitted diffs would
  //    block the next cycle's rebase.
  if (argv.includes('--push')) {
    const commitMsg = didSummarize
      ? `data: forward enrichment (${utcStamp()} UTC)`
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

// Which queued runs should make this runner yield? Only runs created after
// this runner started: a stale `queued` left behind by a cancelled run, or a
// transient API ghost, must not end a healthy 12-minute run after one cycle.
// Pure for tests: `runs` are `{ status, createdAt }`, `startTime` is ms.
export function incomingQueuedRuns (runs = [], startTime = 0) {
  const wanted = new Set(['requested', 'queued', 'pending', 'waiting'])
  let n = 0
  for (const r of runs || []) {
    if (!r || !wanted.has(r.status)) continue
    const created = Date.parse(r.createdAt || '') || 0
    if (created > startTime) n++
  }
  return n
}

export async function cmdWatch (argv, { cycle = cmdCatchUp, errorBudget } = {}) {
  let intervalSec = 60
  const idx = argv.indexOf('--interval')
  if (idx !== -1 && argv[idx + 1]) {
    intervalSec = Number(argv[idx + 1]) || 60
  } else if (process.env.WATCH_INTERVAL) {
    intervalSec = Number(process.env.WATCH_INTERVAL) || 60
  }

  let maxDurationMs = Infinity
  const durIdx = argv.indexOf('--duration')
  const durVal = durIdx !== -1 ? argv[durIdx + 1] : process.env.WATCH_DURATION
  if (durVal) {
    const match = String(durVal).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i)
    if (match) {
      const num = Number(match[1])
      const unit = (match[2] || 's').toLowerCase()
      const multiplier = unit === 'h' ? 3600000 : (unit === 'm' ? 60000 : (unit === 'ms' ? 1 : 1000))
      maxDurationMs = num * multiplier
    }
  }

  const exitOnQueued = argv.includes('--exit-on-queued') || process.env.WATCH_EXIT_ON_QUEUED === '1'

  let stopped = false
  const stop = () => { stopped = true }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const startTime = Date.now()
  // A cycle that throws means the loop is failing at its one job -- keeping the
  // site fresh -- and it used to be log-only: a 12-minute run of nothing but
  // `ENOENT ... generator.lock` still exited 0, so deploy.yml published the
  // last good data and the Actions UI showed green while readers saw
  // "[stale 16m]". CI must never be quieter about staleness than the site is,
  // so failures are counted and turned into a failed run.
  let cyclesOk = 0
  let consecutiveErrors = 0
  let lastError = null
  let queuedStrikes = 0
  // Give up once errors have stretched over the loop's own freshness budget
  // rather than the full duration: an abort retries in the next relay run
  // instead of burning 12 minutes of a runner to publish nothing.
  const errorCeil = errorBudget ?? Math.max(3, Math.ceil(syncStaleMs() / 1000 / intervalSec))
  log(`starting backfill loop (running every ${intervalSec}s${maxDurationMs < Infinity ? `, max duration ${durVal}` : ''})… Press Ctrl+C to stop.`)
  while (!stopped) {
    try {
      // Publish what is left of the run before each cycle: a cycle that spent
      // the whole watch duration on one paid window would be killed by the
      // duration limit mid-enrichment, with its results never checkpointed.
      process.env.CHANGELOG_WATCH_REMAINING_MS = String(Math.max(0, Math.round(maxDurationMs - (Date.now() - startTime))))
      const outcome = await cycle(argv)
      if (outcome && outcome.acquired === false) {
        // A peer run holds the worktree lock: idle, but healthy.
        consecutiveErrors = 0
      } else {
        cyclesOk++
        consecutiveErrors = 0
        lastError = null
      }
    } catch (err) {
      consecutiveErrors++
      lastError = err
      log(`backfill loop iteration error (${consecutiveErrors}/${errorCeil} since the last good cycle): ${err.message}`)
    }
    if (stopped) break

    if (consecutiveErrors >= errorCeil) {
      throw new Error(`backfill loop aborted after ${consecutiveErrors} consecutive cycle failures: ${lastError?.message || 'unknown error'}`)
    }

    const elapsed = Date.now() - startTime
    if (elapsed >= maxDurationMs) {
      log(`duration limit reached (${durVal}): exiting backfill loop cleanly.`)
      break
    }

    if (exitOnQueued) {
      try {
        // `requested` is the transient status before `queued`; skipping the
        // count once a dispatched run is still landing is what lets a
        // duplicate through, so count it while it is too early to see.
        // Only runs created after this runner started count: a stale queued
        // entry (or a transient API ghost) must not end a healthy run after
        // one cycle and break the relay chain behind it. Debounced: a single
        // sighting is logged but the run continues; two in a row yields.
        const out = execSync('gh run list --workflow changelog-sync.yml --json databaseId,status,createdAt', { encoding: 'utf8' })
        let runs = []
        try { runs = JSON.parse(out || '[]') } catch { runs = [] }
        const queuedCount = incomingQueuedRuns(runs, startTime)
        if (queuedCount > 0) {
          if (cyclesOk >= 2 && queuedStrikes >= 1) {
            log(`[watch] detected ${queuedCount} incoming workflow run(s) (created after this runner started): yielding to incoming runner.`)
            break
          }
          queuedStrikes++
          log(`[watch] saw ${queuedCount} incoming workflow run(s); continuing this run (strike ${queuedStrikes}/2, ${cyclesOk} cycle(s) done).`)
        } else {
          queuedStrikes = 0
        }
      } catch (_) {}
    }

    const remainingMs = maxDurationMs - (Date.now() - startTime)
    if (remainingMs <= 0) {
      log(`duration limit reached (${durVal}): exiting backfill loop cleanly.`)
      break
    }
    const sleepSec = Math.min(intervalSec, Math.max(1, Math.ceil(remainingMs / 1000)))

    log(`sleeping ${sleepSec}s before next cycle…`)
    await new Promise(r => setTimeout(r, sleepSec * 1000))

    if (Date.now() - startTime >= maxDurationMs) {
      log(`duration limit reached (${durVal}): exiting backfill loop cleanly.`)
      break
    }
  }
  // A short run can hit its duration limit before the error ceiling does: still
  // no excuse for a green pass over data that never moved.
  if (!stopped && !cyclesOk && lastError) {
    throw new Error(`backfill loop published nothing in ${consecutiveErrors} cycle(s): ${lastError.message}`)
  }
  log('backfill loop stopped.')
}

// ---------------------------------------------------------------------------

async function cmdBuild () {
  const changelog = await loadChangelog(DATA)
  if (!changelog) throw new Error('data/changelog.json missing: run generate first')
  const aiCache = await readJson(`${DATA}/ai-summaries.json`, {})
  if (Object.keys(aiCache).length) {
    const aiBySha = new Map()
    const eli5BySha = new Map()
    for (const [key, val] of Object.entries(aiCache)) {
      if (val && !val.error) {
        const sha = key.split(':')[0]
        if (val.title) aiBySha.set(sha, pickAiRecord(val, aiBySha.get(sha)))
        if (val.text && key.includes(':eli5:')) {
          // Extract source hash from cache key structure (<sha>:eli5:v7:<srcHash>)
          // and attach it so we can filter by source when assigning to entries
          const parts = key.split(':')
          const srcFromKey = parts.length >= 4 ? parts[3] : null
          const recordWithSrc = { ...val, src: srcFromKey }
          if (!eli5BySha.has(sha) || (eli5BySha.get(sha).at || '') < (recordWithSrc.at || '')) {
            eli5BySha.set(sha, recordWithSrc)
          }
        }
      }
    }
    for (const e of changelog.entries) {
      if (aiBySha.has(e.sha)) e.ai = pickAiRecord(e.ai, aiBySha.get(e.sha))
      const plain = eli5BySha.get(e.sha)
      if (plain?.src === shortHash(eli5Source(e)) && (!e.eli5 || String(plain.at || '') > String(e.eli5.at || ''))) e.eli5 = plain
      if (e.eli5?.src && e.eli5.src !== shortHash(eli5Source(e))) delete e.eli5
    }
  }
  // Human corrections win over everything the model wrote, on every surface
  // (cards, feeds, Discord copy, search), and survive re-summarization because
  // they are applied at render time from their own file.
  const overrides = await readJson(`${DATA}/overrides.json`, null)
  const overridden = applyOverrides(changelog.entries, overrides || {})
  if (overridden) log(`applied ${overridden} human override${overridden === 1 ? '' : 's'} from data/overrides.json`)
  // The closed-PR memory rides along to the renderer: /in-flight/ says how
  // much closure memory backs PR matching.
  const mergedPrsDoc = await readJson(`${DATA}/merged-prs.json`, null)
  const prsRaw = await readJson(`${DATA}/open-prs.json`, [])
  const prs = Array.isArray(prsRaw) ? prsRaw : (prsRaw?.prs || [])
  const prSummaries = await readJson(`${DATA}/pr-summaries.json`, {})
  attachPrSummaries(prs, prSummaries, (p) => {
    try { return readFileSync(resolve(DATA, `pr-diffs/${p.number}.diff`), 'utf8') } catch { return null }
  })
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
  // hasDiff trimming (below) must happen before render so the cards agree with
  // what dist/ actually holds.
  const keepDiff = diffShipFilter(changelog.entries, process.env)
  if (keepDiff) for (const e of changelog.entries) if (e.hasDiff && !keepDiff(e)) e.hasDiff = false
  const traffic = await readJson(`${DATA}/traffic.json`, null)
  // dist/ is a pure build output, regenerated in full from data/ every run, so it
  // is cleared first. Without this, any URL the generator stops emitting keeps
  // shipping the markup of the build that made it -- today that would be a
  // retired page family serving an old multi-day timeline beside the new one-day
  // pages, and in general it is stale diffs outliving the entries they describe.
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  // The timeline paginates one day per page: `/` is the newest day, every older
  // day is its own /day/<date>/ page.
  // The golden-set card on /stats/: the newest committed eval result, with
  // the run before it attached so the card can show a delta. Null until the
  // weekly workflow lands its first result, which renders "no run yet".
  let evalResult = null
  try {
    const { latestResult } = await import('./lib/eval.mjs')
    evalResult = await latestResult(`${DATA}/eval/results`)
  } catch (err) {
    log(`[build] eval results unavailable: ${err.message}`)
  }
  // The drift ledger (recordLlmHealth writes it every enrich run) feeds the
  // LLM HEALTH card; absent until the first LLM run after it lands.
  const llmHealth = await readJson(`${DATA}/llm-health.json`, null)
  // The settled days' bullet digests, keyed by day: their pages render them
  // above the entries. Absent until the roll-up pass has run once.
  const rollups = await loadRollups(DATA)
  await buildSite({ changelog, openPrs: prs, prMeta, traffic, dist, mergedPrs: mergedPrsDoc, overridesDoc: overrides, evalResult, llmHealth, rollups })

  // data/diffs is 106 MB of a 352 MB dist. Two opt-in trims: skip the churn
  // rows' lockfile diffs (CHANGELOG_DIST_SKIP_CHURN_DIFFS=1) and/or ship only
  // the last N months (CHANGELOG_DIST_DIFF_MONTHS=N). Rows whose diff is not
  // shipped lose their hasDiff flag before render, so the card shows the
  // GitHub compare link instead of a viewer that would 404. Default: ship all.
  const distDiffs = resolve(dist, 'diffs')
  if (existsSync(dataDiffs)) {
    await mkdir(distDiffs, { recursive: true })
    if (!keepDiff) {
      await cp(dataDiffs, distDiffs, { recursive: true })
    } else {
      let shipped = 0, skipped = 0
      for (const e of changelog.entries) {
        const src = resolve(dataDiffs, `${e.sha}.diff`)
        if (!existsSync(src)) continue
        if (e.hasDiff) { await cp(src, resolve(distDiffs, `${e.sha}.diff`)); shipped++ } else skipped++
      }
      log(`shipped ${shipped} stored diffs to dist/, skipped ${skipped} (CHANGELOG_DIST_* trim options set)`)
    }
  }
  const dataPrDiffs = resolve(DATA, 'pr-diffs')
  if (existsSync(dataPrDiffs)) {
    await mkdir(resolve(dist, 'pr-diffs'), { recursive: true })
    await cp(dataPrDiffs, resolve(dist, 'pr-diffs'), { recursive: true })
  }

  log(`site built in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${dist}`)
}

// Which stored diffs to ship to dist/. Returns null when everything ships.
export function diffShipFilter (entries, env = process.env) {
  const skipChurn = env.CHANGELOG_DIST_SKIP_CHURN_DIFFS === '1'
  const months = Number(env.CHANGELOG_DIST_DIFF_MONTHS)
  if (!skipChurn && !(months > 0)) return null
  const cutoff = months > 0 ? new Date(Date.now() - months * 30.44 * 86400000).toISOString().slice(0, 10) : null
  return (e) => {
    if (skipChurn && e.noise) return false
    if (cutoff && String(e.day || e.date || '').slice(0, 10) < cutoff) return false
    return true
  }
}

// data/overrides.json: { "<sha>": { "title": "...", "summary": "...", "eli5": "...", "significance": "...", "note": "why" } }
// A 12-char prefix works as a key too. Fields not given are left alone.
export function applyOverrides (entries, overrides) {
  if (!overrides || typeof overrides !== 'object' || !Array.isArray(entries)) return 0
  const byPrefix = new Map()
  for (const [k, v] of Object.entries(overrides)) {
    if (!v || typeof v !== 'object' || !/^[0-9a-f]{7,40}$/i.test(k)) continue
    byPrefix.set(k.toLowerCase(), v)
  }
  if (!byPrefix.size) return 0
  let n = 0
  for (const e of entries) {
    const sha = String(e.sha || '').toLowerCase()
    let o = byPrefix.get(sha)
    if (!o) for (const [k, v] of byPrefix) if (sha.startsWith(k)) { o = v; break }
    if (!o) continue
    if (o.title || o.summary || o.significance || o.evidence || o.audience) {
      e.ai = { ...(e.ai || { model: 'human', v: PROMPT_V }), ...(o.title ? { title: String(o.title) } : {}), ...(o.summary ? { summary: String(o.summary) } : {}), ...(o.evidence ? { evidence: String(o.evidence) } : {}), ...(o.audience ? { audience: String(o.audience) } : {}), ...(o.significance ? { significance: String(o.significance) } : {}), overridden: true }
      if (!e.ai.title) e.ai.title = e.title
      if (!e.ai.summary) e.ai.summary = e.summary
      delete e.ai.ungrounded
      if (o.significance && ['major', 'notable', 'minor'].includes(o.significance)) e.significance = o.significance
    }
    if (o.eli5) e.eli5 = { ...(e.eli5 || {}), text: String(o.eli5), model: 'human', v: ELI5_V, overridden: true }
    e.overridden = true
    n++
  }
  return n
}

// The fields data/overrides.json accepts. `note` is the reviewer's own "why"
// and never renders; everything else replaces what the model wrote.
const OVERRIDE_FIELDS = ['title', 'summary', 'eli5', 'significance', 'audience', 'evidence', 'note']

/**
 * Author a human correction into data/overrides.json.
 *
 *   override <sha>                          print a ready-to-edit draft (current values filled in)
 *   override <sha> --title ... [--note ...] merge given fields into the override
 *   override <sha> --clear                  remove this entry's override
 *   override --list                         show every override on file
 *
 * The scaffold-first shape is the point: a correction starts from what is
 * actually rendered today (AI title, summary, plain-English line), so the
 * editor changes the wrong sentence instead of re-typing the whole entry from
 * the diff. Run `npm run build` (or let the sync do it) to republish.
 */
export async function cmdOverride (argv = [], { dataDir = DATA } = {}) {
  const path = `${dataDir}/overrides.json`
  const overrides = (await readJson(path, null)) || {}

  if (argv.includes('--list')) {
    const keys = Object.keys(overrides).filter(k => /^[0-9a-f]{7,40}$/i.test(k))
    for (const k of keys) console.log(`${k}  ${(overrides[k].note || overrides[k].title || '').slice(0, 70)}`)
    if (!keys.length) console.log('no overrides on file')
    return { ok: true, count: keys.length }
  }

  const want = (argv[0] || '').toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(want)) {
    console.error('usage: override <sha-prefix> [--title T] [--summary S] [--eli5 E] [--significance major|notable|minor] [--audience A] [--evidence V] [--note N] [--clear|--list]')
    return { ok: false, error: 'missing_sha' }
  }

  const doc = await loadChangelog(dataDir)
  const entry = doc?.entries?.find(e => e.sha.startsWith(want)) || null
  if (!entry) console.error(`warning: no entry matches ${want} in data/changelog.json; writing the override anyway (it will apply when the commit appears)`)
  const key = entry ? entry.sha : want

  if (argv.includes('--clear')) {
    delete overrides[key]
    delete overrides[want]
    await writeJson(path, overrides)
    log(`override cleared for ${key.slice(0, 12)}`)
    return { ok: true, cleared: key }
  }

  // What is rendered today, so the draft starts editable rather than empty.
  const current = {
    title: entry?.ai?.title || entry?.title || '',
    summary: entry?.ai?.summary || entry?.summary || '',
    eli5: entry?.eli5?.text || '',
    significance: entry?.significance || 'minor',
    audience: entry?.ai?.audience || '',
    evidence: entry?.ai?.evidence || '',
    note: ''
  }
  const given = {}
  for (let i = 0; i < argv.length; i++) {
    const f = OVERRIDE_FIELDS.find(x => `--${x}` === argv[i])
    if (f && argv[i + 1] !== undefined) { given[f] = argv[i + 1]; i++ }
  }

  if (!Object.keys(given).length) {
    console.log(`# Draft override for ${key.slice(0, 12)}${entry ? ` (${entry.day} · ${entry.category})` : ''}.`)
    console.log('# Edit the values below, then rerun as: override ' + want + ' --title "…" [--summary "…"] [--eli5 "…"] [--note "why"]')
    console.log(JSON.stringify({ [key]: current }, null, 2))
    return { ok: true, draft: { [key]: current } }
  }

  const merged = { ...(overrides[key] || {}), ...given }
  overrides[key] = merged
  await writeJson(path, overrides)
  log(`override ${Object.keys(given).join(', ')} written for ${key.slice(0, 12)}: run \`npm run build\` (or the next sync) to republish`)
  return { ok: true, key, override: merged }
}

async function cmdPreview (port = 8788) {
  const { createServer } = await import('node:http')
  const { resolve: r, join } = await import('node:path')
  const dist = resolve(ROOT, 'dist')
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let p = decodeURIComponent(url.pathname)
    // The three dynamic routes worker.js answers in production, so a local
    // preview behaves like the deployed site instead of 404ing them.
    const served = await dynamicRoute(dist, p, url.searchParams)
    if (served) {
      res.writeHead(served.status, served.headers)
      res.end(served.body)
      return
    }
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

// The dynamic routes that need one line of compute on top of the static dist/:
// /api/entry/<sha>.json (one entry record), /release/<v>/?format=md (release
// notes as markdown) and /from/<d>/to/<d>/ (the range shell, which is also
// written as the `range` asset with a _redirects rewrite in production).
// Shared shape with worker.js so preview and deploy cannot drift.
export async function dynamicRoute (dist, pathname, searchParams) {
  const json = (obj, status = 200) => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    body: JSON.stringify(obj)
  })
  const text = (body, type, status = 200) => ({ status, headers: { 'content-type': type }, body })
  try {
    const em = /^\/api\/entry\/([0-9a-f]{4,40})(?:\.json)?\/?$/i.exec(pathname)
    if (em) {
      const record = await findEntryRecord(dist, em[1].toLowerCase())
      return record ? json(record) : json({ error: `no changelog entry records ${em[1]}` }, 404)
    }
    if (searchParams?.get('format') === 'md') {
      const rm = /^\/release\/([^/]+)\/?$/.exec(pathname)
      if (rm) {
        const md = await readFile(resolve(dist, 'release', decodeURIComponent(rm[1]), 'notes.md'), 'utf8')
        return text(md, 'text/markdown; charset=utf-8')
      }
    }
    const fm = /^\/from\/(\d{4}-\d{2}-\d{2})\/to\/(\d{4}-\d{2}-\d{2})\/?$/.exec(pathname)
    if (fm) return text(await readFile(resolve(dist, 'range-view')), 'text/html; charset=utf-8')
  } catch (err) {
    if (err?.code === 'ENOENT') return json({ error: 'not found' }, 404)
    return json({ error: String(err?.message || err) }, 500)
  }
  return null
}

// Resolve a commit prefix to its entry record via the same two-shard lookup
// worker.js uses: api/sha-day.json maps short sha -> day, and api/records/<day>.json
// holds that day's full records.
async function findEntryRecord (dist, want) {
  const map = JSON.parse(await readFile(resolve(dist, 'api/sha-day.json'), 'utf8'))
  const key = Object.prototype.hasOwnProperty.call(map, want)
    ? want
    : Object.keys(map).find(k => k.startsWith(want) || want.startsWith(k))
  if (!key) return null
  const day = map[key]
  const shard = JSON.parse(await readFile(resolve(dist, 'api/records', `${day}.json`), 'utf8'))
  return (shard.records || []).find(x => x.sha.startsWith(key) || key.startsWith(x.sha)) || null
}

function MIME (f) {
  if (f.endsWith('.html')) return 'text/html; charset=utf-8'
  if (f.endsWith('.json')) return 'application/json; charset=utf-8'
  if (f.endsWith('.diff')) return 'text/plain; charset=utf-8'
  if (f.endsWith('.xml')) return 'application/rss+xml; charset=utf-8'
  if (f.endsWith('.opml')) return 'text/x-opml; charset=utf-8'
  if (f.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (f.endsWith('.xsl')) return 'text/xsl; charset=utf-8'
  if (f.endsWith('.css')) return 'text/css'
  if (f.endsWith('.js')) return 'text/javascript; charset=utf-8'
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
  else if (cmd === 'freshness') await cmdFreshness(rest)
  else if (cmd === 'check-size') await cmdCheckSize(rest)
  else if (cmd === 'enrich-all') await cmdEnrichAll(rest)
  else if (cmd === 'repair-entries') await cmdRepairEntries(rest)
  else if (cmd === 'retry-failed') await cmdRetryFailed(rest)
  else if (cmd === 'regen-last') await cmdRegenLast(rest)
  else if (cmd === 'prune-cache') await cmdPruneCache(rest)
  else if (cmd === 'compact-evidence') await cmdCompactEvidence(rest)
  else if (cmd === 'gc-evidence') await cmdGcEvidence(rest)
  else if (cmd === 'rollups') await cmdRollups(rest)
  else if (cmd === 'glossary') await cmdGlossary(rest)
  else if (cmd === 'eval') await cmdEval(rest)
  else if (cmd === 'normalize-dates') await cmdNormalizeDates(rest)
  else if (cmd === 'broadcast') await cmdBroadcast(rest)
  else if (cmd === 'override') await cmdOverride(rest)
  else if (cmd === 'fetch-traffic') await fetchTrafficClones({ force: true })
  else if (cmd === 'build') await cmdBuild()
  else if (cmd === 'preview') await cmdPreview(Number(rest[0]) || 8788)
  else {
    console.log(`usage:
  node generator/cli.mjs generate [--full]        # analyze upstream freebuff (full rescan)
  node generator/cli.mjs catch-up [--push]        # publish deterministic changes, then bounded forward enrichment
  node generator/cli.mjs watch [--push] [--interval S] [--duration D]  # continuous sync; historical enrichment disabled
  node generator/cli.mjs push-data [--message M]  # commit+push data/ with the shared race handling
  node generator/cli.mjs freshness [--max-age-min N]  # CI gate: fail if data/changelog.json is staler than the site's own [stale] threshold (2x the sync budget)
  node generator/cli.mjs enrich-all              # disabled: no historical API spending
  node generator/cli.mjs repair-entries [--push]   # recompute commitNature / significance / security tag on stored rows (no text touched)
  node generator/cli.mjs retry-failed <sha>... [--admit] [--push]  # release named rows with no generation (clears stubs, re-asks, publishes; --admit decides a row that has neither admission nor an ask on record)
  node generator/cli.mjs regen-last <N | sha...> [--push]  # regenerate the newest N (max 50) or named rows: fresh summaries, bounded and forward-only
  node generator/cli.mjs prune-cache [--push]      # drop ai-summaries.json keys from retired prompt versions
  node generator/cli.mjs compact-evidence [--push] [--dry-run]  # move stored evidence material into data/evidence/ shards so the tracked JSON files stay small
  node generator/cli.mjs gc-evidence [--push] [--dry-run]  # delete evidence shards no stored record references and fan flat shards out by hash prefix
  node generator/cli.mjs rollups [--backfill N] [--day YYYY-MM-DD] [--force] [--push]  # write the settled day's bullet digest shown at the top of its page
  node generator/cli.mjs check-size              # CI gate: fail when a tracked file nears GitHub's 100 MiB push limit
  node generator/cli.mjs glossary [--discover]     # list plain-English term definitions; --discover adds candidates from upstream docs
  node generator/cli.mjs eval [--seed N] [--limit N]  # offline stored-artifact audit, zero provider calls
  node generator/cli.mjs normalize-dates [--push]  # one-off: rewrite stored timestamps to UTC and fix the day/month keys
  node generator/cli.mjs broadcast [--webhook URL] [--limit N] [--dry-run]  # broadcast latest commits to Discord
  node generator/cli.mjs override <sha> [--title T] [--summary S] [--eli5 E] [--significance S] [--audience A] [--evidence V] [--note N] [--clear|--list]  # author a human correction into data/overrides.json
  node generator/cli.mjs build                    # render static site → dist/
  node generator/cli.mjs preview [port]           # local preview of dist/`)
    process.exit(cmd ? 1 : 0)
  }
}
// Keep the retired command fail-fast for old automation; no duplicate writer.
async function cmdEnrichAll () {
  throw new Error('Historical enrichment is disabled: no backfill or paid regeneration is permitted.')
}


/**
 * Repair stored rows: recompute commitNature, testOnly, significance (+reason)
 * and the security tag from each row's stored shape. Titles, summaries and AI
 * text are never touched. Safe to re-run.
 */
async function cmdRepairEntries (argv) {
  const { acquired } = await withLock(LOCK, async () => {
    const doc = await loadChangelog(DATA)
    if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
    const n = repairEntries(doc.entries, { diffDir: resolve(DATA, 'diffs') })
    if (!n) { log('[repair-entries] every row already carries current derived fields'); return }
    doc.generatedAt = new Date().toISOString()
    if (argv.includes('--push')) {
      await commitAndPushData({ message: `data: repair derived fields on ${n} entries (${utcStamp()} UTC)`, overrides: { [`${DATA}/changelog.json`]: doc } })
    } else {
      await persistMerged(await capturePendingWrites(DATA, { [`${DATA}/changelog.json`]: doc }))
    }
    log(`[repair-entries] updated ${n} of ${doc.entries.length} rows`)
  })
  if (!acquired) log('another generate/backfill run holds the worktree lock: retry shortly')
}

/**
 * Release named rows for one regeneration, then publish: the explicit way back
 * for an admitted row the pipeline will never re-ask on its own (a failure stub
 * parked before the classification was fixed, or a refusal recorded while the
 * strong-model escape hatch was dead in CI). See releaseFailedRows for the
 * guards that keep this from becoming a backfill tool.
 *
 * Run it where the relay runs, not on a workstation: the CLI auto-loads .env,
 * so a local invocation spends real provider calls from this machine. The sync
 * workflow dispatches it, with the promoted runtime and the relay's key.
 *
 * Release and regeneration happen in one process, which is what makes the fix
 * survive a merge: the stubs are gone from the cache we write and the fresh
 * record lands beside them, so the union mergeAiCache performs keeps the newer
 * `at` instead of restoring the deleted keys.
 */
async function cmdRetryFailed (argv) {
  const wants = argv.filter(a => !a.startsWith('--')).map(s => s.trim()).filter(Boolean)
  const admit = argv.includes('--admit')
  if (!wants.length) throw new Error('usage: retry-failed <sha>... [--admit] [--push]')
  if (wants.length > 5) throw new Error(`retry-failed accepts at most 5 rows per run (got ${wants.length}): this is a release, not a backlog`)
  const { acquired } = await withLock(LOCK, async () => {
    const doc = await loadChangelog(DATA)
    if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
    const cache = await readJson(`${DATA}/ai-summaries.json`, {})
    const { picked, released, skipped, errors } = releaseFailedRows(doc.entries, cache, wants, { admit })
    for (const line of skipped) log(`[retry-failed] ${line}`)
    // Reported, not fatal yet: the names that passed still get released. One
    // refused name aborting the batch would leave healthy rows unregenerated
    // behind it -- the batch fails at the end instead, loudly, after the work.
    for (const err of errors) log(`[retry-failed] REFUSED: ${err}`)
    if (!picked.length) {
      if (errors.length) throw new Error(`retry-failed: ${errors.join('; ')}`)
      log('[retry-failed] nothing to release')
      return
    }
    if (!llmConfigured()) throw new Error('retry-failed needs the LLM configured (CHANGELOG_LLM=1 and LLM_API_KEY): dispatch it through the sync workflow, where the relay key lives')
    // The provider's quiet minute is a fixed cost of the process, and it is
    // deliberately spent before any pass deadline is armed: the lazy bounded
    // path at the first call charges it to that row's own clock, which killed
    // named rows 9s in with "LLM entry time budget exceeded" before a call
    // was ever sent. Same reason catchUpOnce warms first.
    await warmLlmRpmWindow(process.env)
    const shas = new Set(picked.map(e => e.sha))
    log(`[retry-failed] releasing ${picked.length} row(s), ${released.length} failure stub${released.length === 1 ? '' : 's'} cleared: ${[...shas].map(s => s.slice(0, 8)).join(', ')}`)
    // The deletion has to reach disk before the ask, for two reasons: the
    // writer reads the cache from disk (our copy is invisible to its cooldown
    // check), and persistMerged unions -- `mergeAiCache` restores any key disk
    // still holds, so a purely in-memory release would be undone by our own
    // write. Raw write, under the worktree lock, is the one form that sticks.
    await writeJson(`${DATA}/ai-summaries.json`, cache)
    // The patch extractor reads the clone, and the clone is restored from an
    // immutable cache baseline that only the sync loop ever fetches. Without
    // this fetch the rows can be released, admitted and queued and still hand
    // the writer an empty patch, which it skips without a call -- so the
    // release reads as a provider silence it never was.
    try { await ensureRepo() } catch (err) { log(`[retry-failed] upstream fetch failed: ${err.message.slice(0, 120)}; extracting from the clone as it stands`) }
    await backfillDiffs(picked, picked.length)
    // Name any row whose patch cannot be extracted (absent from the clone, or a
    // change that is pure lockfile) instead of letting the queue skip it
    // silently: a release that asks nothing has to say why.
    const askable = []
    for (const e of picked) {
      const patch = await llmPatchFor(e).catch(() => '')
      if (patch) askable.push(e)
      else log(`[retry-failed] ${e.sha.slice(0, 8)}: no extractable patch -- not asking`)
    }
    let n = 0
    let asked = 0
    if (askable.length) {
      const only = new Set(askable.map(e => e.sha))
      await withDeadline(180000, async () => {
        // Named stragglers get an even share of the run's own window: enough
        // for a real ask (45s floor), bounded so the first row cannot spend it
        // all before the others are reached.
        const env = {
          ...process.env,
          CHANGELOG_LLM_NO_BACKFILL: '1',
          CHANGELOG_LLM_LIMIT: String(askable.length),
          CHANGELOG_LLM_ROW_BUDGET_MS: String(Math.max(45000, Math.floor(180000 / Math.max(1, askable.length)))),
          CHANGELOG_ELI5_ROW_BUDGET_MS: String(Math.max(30000, Math.floor(90000 / Math.max(1, askable.length)))),
          LLM_DEADLINE_AT: String(deadlineAt()),
          LLM_CYCLE_BUDGET: { remaining: askable.length * 8 }
        }
        const before = llmCallCount()
        n = await enrichWithLlm(doc.entries, llmPatchFor, DATA, env, { retryErrors: true, priorityShas: only, only, repoDir: REPO_DIR, getFullPatch: fullPatchFor })
        asked = llmCallCount() - before
        if (n) await enrichEli5(doc.entries, DATA, env, { retryErrors: true, priorityShas: only, only, getPatch: llmPatchFor, getFullPatch: fullPatchFor, repoDir: REPO_DIR })
      })
      log(`[retry-failed] ${n} of ${askable.length} row(s) written after ${asked} call(s)`)
      if (!n) log(asked ? '[retry-failed] the provider did not answer; the stubs are cleared, so the next relay cycle asks again' : '[retry-failed] no call was sent: nothing was eligible to ask')
    } else {
      log('[retry-failed] no row was askable; the release is still published so the next cycle can try')
    }
    if (argv.includes('--push')) {
      await commitAndPushData({
        message: `data: retry regeneration for ${[...shas].map(s => s.slice(0, 8)).join(', ')} (${utcStamp()} UTC)`,
        overrides: { [`${DATA}/changelog.json`]: doc }
      })
    } else {
      // Cache is already authoritative on disk; only the entry grafts are still
      // in memory.
      await persistMerged(await capturePendingWrites(DATA, { [`${DATA}/changelog.json`]: doc }))
      log('dry run: data written locally, not committed (pass --push)')
    }
    // After the publish, on purpose: a refused name must not undo the releases
    // that did happen, but the run still has to end red so the refusal is seen.
    if (errors.length) throw new Error(`retry-failed: released ${picked.length}, refused ${errors.length}: ${errors.join('; ')}`)
  })
  if (!acquired) log('another generate/backfill run holds the worktree lock: retry shortly')
}

/**
 * Regenerate the newest N entries (`regen-last 40`) or named rows
 * (`regen-last <sha>...`): re-ask for a fresh summary on rows that already have
 * one, plus first asks for rows that have none.
 *
 * The sanctioned replacement for the retired `scripts/regenerate-last-20.mjs`,
 * which fails fast (R16: duplicate regeneration writers). It runs under the
 * worktree lock and the relay's key, is bounded at 50 rows per run, and is
 * scoped by `only` + a forced row set, so it is scoped to rows a human asked
 * for or the newest N -- never to history. Rows outside the set are untouched,
 * and a row inside it keeps its shipped text if the ask fails: a failure writes
 * a stub, a stub loses the merge to a real summary, and `e.ai` is only ever
 * replaced by a successful record.
 *
 * Admission: a row in the set either carries `enrichment.policy`, or carries a
 * generation this pipeline wrote -- which is itself proof it was asked -- and is
 * stamped admitted on the spot, because the writer's gate reads that field (and
 * the changelog merge now unions it, so the stamp survives). A row with neither
 * is refused and named: that would be backfill, which this command exists not
 * to do.
 */
async function cmdRegenLast (argv) {
  const push = argv.includes('--push')
  const wants = argv.filter(a => !a.startsWith('--')).map(s => s.trim()).filter(Boolean)
  if (!wants.length) throw new Error('usage: regen-last <N | sha...> [--push]  (N bounds a run at 50)')
  const byCount = wants.length === 1 && /^\d+$/.test(wants[0])
  const CAP = 50
  const { acquired } = await withLock(LOCK, async () => {
    const doc = await loadChangelog(DATA)
    if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
    let targets
    if (byCount) {
      const n = Number(wants[0])
      if (n < 1 || n > CAP) throw new Error(`regen-last bounds a run at ${CAP} rows (got ${n}): this refreshes the newest entries, it does not rewrite history`)
      // Newest first; noise never reaches a model.
      targets = [...doc.entries]
        .filter(e => !e.noise)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.sha < b.sha ? 1 : -1)))
        .slice(0, n)
    } else {
      if (wants.length > CAP) throw new Error(`regen-last accepts at most ${CAP} names per run (got ${wants.length})`)
      targets = []
      for (const w of wants) {
        const hits = doc.entries.filter(e => String(e.sha).startsWith(w))
        if (!hits.length) throw new Error(`regen-last: no entry matches ${w}`)
        if (hits.length > 1) throw new Error(`regen-last: ${w} matches ${hits.length} entries; use a longer prefix`)
        targets.push(hits[0])
      }
    }
    if (!llmConfigured()) throw new Error('regen-last needs the LLM configured (CHANGELOG_LLM=1 and LLM_API_KEY): dispatch it through the sync workflow, where the relay key lives')
    // Warm before the pass clocks exist, not inside the first row's 60s share:
    // the bounded warmup path throws "entry time budget exceeded" when the wait
    // outlives the row room, which is exactly what happened to the first named
    // rows of a dispatched regeneration.
    await warmLlmRpmWindow(process.env)
    const askable = []
    const refused = []
    for (const e of targets) {
      if (e.enrichment?.policy === QUALITY_POLICY_V) { askable.push(e); continue }
      if (e.ai?.title) {
        // Text this pipeline already wrote is the proof it asked: admission is
        // stamped rather than re-derived, so the writer's gate lets the row
        // through and the merge keeps the stamp.
        e.enrichment = { policy: QUALITY_POLICY_V, admittedAt: new Date().toISOString(), released: true }
        askable.push(e)
        continue
      }
      refused.push(`${e.sha.slice(0, 8)} has neither admission nor a generation: asking it would be backfill`)
    }
    for (const r of refused) log(`[regen] REFUSED: ${r}`)
    if (!askable.length) throw new Error(`regen-last: nothing to regenerate${refused.length ? ` (${refused.join('; ')})` : ''}`)
    const only = new Set(askable.map(e => e.sha))
    log(`[regen] regenerating ${askable.length} row(s)${refused.length ? `, refusing ${refused.length}` : ''}: ${[...only].map(s => s.slice(0, 8)).join(', ')}`)
    // The patch extractor reads the clone, and the clone is restored from an
    // immutable cache baseline that only the sync loop fetches: fetch first or
    // every patch comes back empty and the run silently asks nothing.
    try { await ensureRepo() } catch (err) { log(`[regen] upstream fetch failed: ${err.message.slice(0, 120)}; extracting from the clone as it stands`) }
    await backfillDiffs(askable, askable.length)
    const startedAt = Date.now()
    let written = 0
    let asked = 0
    // Split the budget between summary and ELI5: 60% for technical summaries,
    // 40% reserved for ELI5 so enrichWithLlm cannot exhaust the entire budget
    // before enrichEli5 runs. A row the deadline still reaches keeps its
    // shipped text and is named in the report.
    const budgetMs = Math.min(30 * 60000, Math.max(6 * 60000, askable.length * 60000))
    const summaryBudgetMs = Math.floor(budgetMs * 0.6)
    const eli5BudgetMs = Math.floor(budgetMs * 0.4)
    const summaryDeadline = startedAt + summaryBudgetMs
    // An even share of each half for each row, on top of the per-run split:
    // one pathological row must not consume the summary half and leave the
    // rest of the named set unanswered.
    const rowShareMs = Math.max(60000, Math.floor(summaryBudgetMs / Math.max(1, askable.length)))
    const eli5RowShareMs = Math.max(45000, Math.floor(eli5BudgetMs / Math.max(1, askable.length)))
    const beforeSummary = llmCallCount()
    await withDeadline(summaryBudgetMs, async () => {
      const env = { ...process.env, CHANGELOG_LLM_NO_BACKFILL: '1', CHANGELOG_LLM_LIMIT: String(askable.length + 1), CHANGELOG_LLM_ROW_BUDGET_MS: String(rowShareMs), LLM_DEADLINE_AT: String(summaryDeadline), LLM_CYCLE_BUDGET: { remaining: askable.length * 6 } }
      written = await enrichWithLlm(doc.entries, llmPatchFor, DATA, env, { force: only, only, priorityShas: only, retryErrors: true, repoDir: REPO_DIR, getFullPatch: fullPatchFor })
    })
    // The plain-English line follows the summary: a rewritten summary whose
    // claims changed re-queues its line through eli5Done on its own.
    const eli5Deadline = startedAt + eli5BudgetMs
    const eli5Env = { ...process.env, CHANGELOG_LLM_NO_BACKFILL: '1', CHANGELOG_LLM_LIMIT: String(askable.length + 1), CHANGELOG_ELI5_ROW_BUDGET_MS: String(eli5RowShareMs), LLM_DEADLINE_AT: String(eli5Deadline), LLM_CYCLE_BUDGET: { remaining: Math.max(20, askable.length * 4) } }
    await enrichEli5(doc.entries, DATA, eli5Env, { only, priorityShas: only, retryErrors: true, getPatch: llmPatchFor, getFullPatch: fullPatchFor, repoDir: REPO_DIR })
    asked = llmCallCount() - beforeSummary
    // The "generate properly" half of the request: report the outcome per row,
    // not just a count, so a run that quietly produced nothing cannot look done.
    const fresh = askable.filter(e => e.ai?.at && Date.parse(e.ai.at) >= startedAt)
    const noText = askable.filter(e => !e.ai?.title)
    const flagged = askable.filter(e => e.ai?.verify === 'flagged')
    const unavailable = askable.filter(e => e.ai?.verify === 'unavailable')
    log(`[regen] ${fresh.length}/${askable.length} rows rewritten this run (writer reported ${written}, ${asked} call${asked === 1 ? '' : 's'})`)
    log(`[regen] ${askable.length - noText.length}/${askable.length} now carry technical text (not a completion verdict)`)
    // With the verifier disabled, a fresh row ends `review-pending` by design:
    // counting that as an unfinished repair would fail every successful run and
    // skip the sync loop behind it. Missing text and needs-repair still fail.
    const verifyOn = verifyConfigured(process.env)
    const incomplete = regenUnfinished(askable, { verify: verifyOn })
    log(`[regen] ${askable.length - incomplete.length}/${askable.length} fully generated${verifyOn ? ' and reviewed' : ' (verifier off: no verdict requested)'}`)
    for (const e of askable) {
      const state = generationState(e)
      log(`[regen] ${e.sha.slice(0, 8)}: ${state.status}${state.missing.length ? ` (missing ${state.missing.join(', ')})` : ''}; summary=${e.ai?.verify || 'none'}, plain=${e.eli5?.verify || (e.eli5?.model === 'template' ? 'deterministic' : 'none')}`)
    }
    if (noText.length) log(`[regen] still without text: ${noText.map(e => e.sha.slice(0, 8)).join(', ')} (their failure stands; the relay keeps retrying them)`)
    if (flagged.length) log(`[regen] verifier objected: ${flagged.map(e => e.sha.slice(0, 8)).join(', ')}`)
    if (unavailable.length) log(`[regen] verdict could not run: ${unavailable.map(e => e.sha.slice(0, 8)).join(', ')}`)
    if (push) {
      await commitAndPushData({
        message: `data: regenerate newest ${askable.length} entries (${utcStamp()} UTC)`,
        overrides: { [`${DATA}/changelog.json`]: doc }
      })
    } else {
      await persistMerged(await capturePendingWrites(DATA, { [`${DATA}/changelog.json`]: doc }))
      log('dry run: data written locally, not committed (pass --push)')
    }
    if (refused.length) throw new Error(`regen-last: regenerated ${askable.length}, refused ${refused.length}: ${refused.join('; ')}`)
    if (incomplete.length) throw new Error(`regen-last: bounded repair incomplete for ${incomplete.map(e => e.sha.slice(0, 8)).join(', ')}; partial results preserved, no completion claimed`)
  })
  if (!acquired) log('another generate/backfill run holds the worktree lock: retry shortly')
}

/**
 * data/glossary.json: plain-English meanings for Freebuff's internal terms,
 * injected into both prompts. `--discover` mines candidate terms from the
 * upstream docs headings at origin/main and adds any not already present, with
 * an empty definition to fill in (empty definitions are never injected).
 */
async function cmdGlossary (argv) {
  const path = `${DATA}/glossary.json`
  const glossary = await loadGlossary(DATA)
  if (argv.includes('--discover')) {
    await ensureRepo()
    const found = await discoverGlossary(REPO_DIR)
    let added = 0
    for (const [term, hint] of Object.entries(found)) {
      if (term in glossary) continue
      glossary[term] = hint || ''
      added++
    }
    await writeJson(path, glossary)
    log(`[glossary] ${added} candidate term${added === 1 ? '' : 's'} added from upstream docs (${Object.keys(glossary).length} total); definitions left empty are not injected until filled in`)
    return
  }
  const filled = Object.values(glossary).filter(v => typeof v === 'string' && v.trim()).length
  log(`[glossary] ${Object.keys(glossary).length} terms, ${filled} with a definition (injected)`)
  for (const [k, v] of Object.entries(glossary)) console.log(`  ${k}${v ? `: ${v}` : '  (no definition yet)'}`)
}

/**
 * Summary-quality evaluation against a golden set. See lib/eval.mjs.
 *   eval --seed N       write data/eval/golden.json from the N most recent
 *                        major/notable rows (labels provisional until reviewed)
 *   eval [--limit N] [--judge]   re-summarize the golden rows on the current
 *                        prompt into a scratch cache, score, and compare with
 *                        the previous run
 */
async function cmdEval (argv) {
  const { seedGolden, runEval, formatEvalReport } = await import('./lib/eval.mjs')
  const doc = await loadChangelog(DATA)
  if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
  const at = argv.indexOf('--seed')
  if (at !== -1) {
    const n = Number(argv[at + 1]) || 40
    const res = await seedGolden(doc.entries, DATA, { count: n })
    log(`[eval] wrote ${res.count} golden rows to data/eval/golden.json (${res.kept} kept from the previous file); review the labels, then run eval`)
    return
  }
  if (argv.includes('--judge') || argv.includes('--paid')) throw new Error('Paid historical evaluation is disabled by the no-backfill policy.')
  const lim = argv.indexOf('--limit')
  const report = await runEval(doc.entries, DATA, process.env, {
    repoDir: REPO_DIR,
    getPatch: llmPatchFor,
    getFullPatch: fullPatchFor,
    limit: lim !== -1 ? Number(argv[lim + 1]) || 0 : 0,
    // Stored-artifact audit only: no historical writer or judge expenditure.
    judge: false,
    offline: true
  })
  console.log(formatEvalReport(report))
  if (!report.gate?.passed) throw new Error('Evaluation failed completion or factual-quality thresholds; the checkpoint contains all results.')
}

/**
 * Drop cache keys written under retired prompt versions. Entries keep their
 * own copy of every summary, so nothing on the site changes; the file just
 * stops carrying 30k dead records into every merge.
 */
async function cmdPruneCache (argv) {
  const path = `${DATA}/ai-summaries.json`
  const cache = await readJson(path, {})
  const before = Object.keys(cache).length
  const pruned = pruneStaleCache(cache)
  if (!pruned) { log(`[prune-cache] nothing to prune (${before} keys, all current)`); return }
  if (argv.includes('--push')) {
    await commitAndPushData({ message: `data: prune ${pruned} stale AI cache keys (${utcStamp()} UTC)`, overrides: { [path]: cache } })
  } else {
    await writeJson(path, cache)
  }
  log(`[prune-cache] removed ${pruned} of ${before} keys (${Object.keys(cache).length} kept)`)
}

/**
 * Every tracked file under data/, with its size. `-z` keeps unusual path bytes
 * intact; ~10k stat() calls are cheap next to the git work around them.
 */
async function trackedDataFiles (root, dataDir) {
  const rel = relative(root, resolve(dataDir)) || 'data'
  const out = await git(['ls-files', '-z', '--', rel], root, { allowFail: true })
  if (!out) return []
  const files = []
  for (const p of out.split('\0')) {
    if (!p) continue
    try { files.push({ path: resolve(root, p), bytes: statSync(resolve(root, p)).size }) } catch { /* staged but gone: nothing to weigh */ }
  }
  return files
}

/**
 * The relay's pre-push gate: refuse to publish a tracked file GitHub would
 * reject, with a message that names it. Checked before every commit
 * (commitAndPushData) and before a cycle spends anything (catchUpOnce), so the
 * failure is ours, early and actionable, instead of a remote "file too large"
 * that kills the whole push.
 */
async function assertDataSizeBudget (root, dataDir) {
  const { over } = findOverBudget(await trackedDataFiles(root, dataDir))
  if (!over.length) return
  const worst = over[0]
  throw new Error(`${relative(root, worst.path)} is ${sizeText(worst.bytes)}, over the ${sizeText(SIZE_MAX_BYTES)} tracked-file budget (GitHub rejects pushes carrying a file over 100 MiB). Shard or trim it before the relay can publish again.`)
}

/**
 * Move stored evidence material out of the tracked JSON files -- the
 * ai-summaries cache records and the ai/eli5 copies on changelog entries --
 * into data/evidence/<hash>.txt shards. A bundle keeps its hash, so a re-check
 * still reads the exact evidence a verdict was recorded against; only the
 * location changes. persistMerged runs the same spill on every write, so the
 * relay compacts itself on its next cycle; this command is the explicit,
 * auditable one, and --dry-run reports what it would move without touching
 * anything. Run --push where the relay runs (the sync workflow): a local
 * checkout's data may be stale, and a push built from it would publish that.
 */
async function cmdCompactEvidence (argv) {
  const cachePath = `${DATA}/ai-summaries.json`
  const docPath = `${DATA}/changelog.json`
  const dryRun = argv.includes('--dry-run')
  const cache = await readJson(cachePath, {})
  const doc = await loadChangelog(DATA)
  const beforeCache = existsSync(cachePath) ? statSync(cachePath).size : 0
  const beforeDoc = await changelogBytes(DATA)
  const fromCache = await spillEvidence(DATA, cache, { dryRun })
  const fromEntries = doc ? await spillEntryEvidence(DATA, doc, { dryRun }) : { spilled: 0, bytes: 0 }
  const spilled = fromCache.spilled + fromEntries.spilled
  const bytes = fromCache.bytes + fromEntries.bytes
  if (!spilled) {
    log(`[compact-evidence] no inline material to move (${Object.keys(cache).length} cache records, ${doc?.entries?.length || 0} entries)`)
    return
  }
  if (dryRun) {
    log(`[compact-evidence] dry run: ${fromCache.spilled} cache record(s) + ${fromEntries.spilled} entry copy(ies), ${sizeText(bytes)} of material would move to data/evidence/`)
    return
  }
  if (argv.includes('--push')) {
    await commitAndPushData({
      message: `data: move ${spilled} stored evidence bundle(s) into shard files (${utcStamp()} UTC)`,
      overrides: { [cachePath]: cache, ...(doc ? { [docPath]: doc } : {}) }
    })
  } else {
    await writeJson(cachePath, cache)
    if (doc) await saveChangelog(DATA, doc)
  }
  log(`[compact-evidence] moved ${spilled} bundle(s) (${sizeText(bytes)} of material) to data/evidence/: ai-summaries.json ${sizeText(beforeCache)} -> ${sizeText(statSync(cachePath).size)}, changelog ${sizeText(beforeDoc)} -> ${sizeText(await changelogBytes(DATA))}`)
}

/**
 * The relay's evidence hygiene, run inside catchUpOnce after every write. The
 * live set is read back from disk on purpose: the in-memory changelog `ours`
 * snapshot can be older than the merged one persistMerged just wrote, and a
 * live set built from it would mark origin's newest shards as orphans.
 */
async function gcEvidenceNow () {
  const cache = await readJson(`${DATA}/ai-summaries.json`, {})
  const doc = await loadChangelog(DATA)
  // Stand down, never guess: the changelog's entry copies can name shards the
  // cache does not, so a live set built without it could delete evidence a
  // record still points at. A cycle that cannot read its own changelog has
  // bigger problems than directory width, and must still publish what it has.
  if (!doc) {
    log('[gc-evidence] skipped: data/changelog.json is unreadable, so the live set would be incomplete')
    return { scanned: 0, kept: 0, orphans: 0, orphanBytes: 0, duplicates: 0, duplicateBytes: 0, moved: 0, movedBytes: 0, unrecognized: 0 }
  }
  // Hygiene is maintenance; a filesystem surprise in it must never cost the
  // cycle its publish. Log and carry on -- the next cycle retries.
  try {
    const acc = await gcEvidence(DATA, liveEvidenceHashes(cache, doc))
    if (acc.orphans || acc.duplicates || acc.moved) {
      log(`[gc-evidence] removed ${acc.orphans} orphan shard(s) (${sizeText(acc.orphanBytes)})` +
        `${acc.duplicates ? `, dropped ${acc.duplicates} duplicate(s) (${sizeText(acc.duplicateBytes)})` : ''}` +
        `${acc.moved ? `, moved ${acc.moved} flat shard(s) into prefix dirs (${sizeText(acc.movedBytes)})` : ''}` +
        `; ${acc.kept} live shard(s) kept`)
    }
    return acc
  } catch (err) {
    log(`[gc-evidence] skipped this cycle: ${err.message}`)
    return { scanned: 0, kept: 0, orphans: 0, orphanBytes: 0, duplicates: 0, duplicateBytes: 0, moved: 0, movedBytes: 0, unrecognized: 0 }
  }
}

/**
 * Collect the evidence store by hand: the same walk the relay runs after
 * every cycle (see gcEvidenceNow), with a report and --dry-run. --push must
 * run where the relay runs: a stale local checkout computes a live set that
 * predates origin, and publishing it would delete evidence the current
 * records name.
 */
async function cmdGcEvidence (argv) {
  const dryRun = argv.includes('--dry-run')
  const { acquired, result: acc } = await withLock(LOCK, async () => {
    const cache = await readJson(`${DATA}/ai-summaries.json`, {})
    const doc = await loadChangelog(DATA)
    // Never collect against a partial live set: the changelog's entry copies
    // can name shards the cache does not.
    if (!doc) throw new Error('gc-evidence needs data/changelog.json: its ai/eli5 copies name evidence shards the cache alone does not')
    const stats = await gcEvidence(DATA, liveEvidenceHashes(cache, doc), { dryRun })
    if (!dryRun && (stats.orphans || stats.duplicates || stats.moved) && argv.includes('--push')) {
      await commitAndPushData({ message: `data: collect ${stats.orphans + stats.duplicates} unreferenced evidence shard(s) (${utcStamp()} UTC)` })
    }
    return stats
  })
  if (!acquired) {
    log('another generate/backfill run holds the worktree lock: skipping evidence GC')
    return
  }
  log(`[gc-evidence] ${acc.scanned} shard(s): ${acc.kept} kept, ${acc.orphans} orphan(s) removed (${sizeText(acc.orphanBytes)})` +
    `${acc.duplicates ? `, ${acc.duplicates} duplicate(s) removed (${sizeText(acc.duplicateBytes)})` : ''}` +
    `${acc.moved ? `, ${acc.moved} flat shard(s) moved into prefix dirs (${sizeText(acc.movedBytes)})` : ''}` +
    `${acc.unrecognized ? `; ${acc.unrecognized} unrecognized file(s) left alone` : ''}`)
  if (!acc.orphans && !acc.duplicates && !acc.moved) return
  if (dryRun) log('[gc-evidence] dry run: nothing changed')
  else if (argv.includes('--push')) log('[gc-evidence] collected changes pushed with the shared race handling')
  else log('[gc-evidence] data written locally, not committed (pass --push)')
}

// ---------------------------------------------------------------------------
// Daily roll-ups: a settled day's changes as a short, user-facing bullet
// digest, rendered at the top of that day's page. Catch-up writes them the
// first cycle after the day's last row summarizes; the command below is the
// report and the manual drain (used once to fill the recent window).

async function writeRollupBatch (pending, { endsAt = Infinity, env = process.env } = {}) {
  let written = 0
  for (const { day, entries } of pending) {
    if (Date.now() >= endsAt) break
    try {
      const rollup = await generateRollup(day, entries, { dataDir: DATA, env })
      written++
      log(`[rollup] ${day}: ${rollup.bullets.length} bullet(s) (${rollup.model || 'unknown model'} @ ${rollup.provider || 'unknown provider'})${rollup.dropped ? `, ${rollup.dropped} of the model's bullets dropped` : ''}`)
    } catch (err) {
      log(`[rollup] ${day} failed: ${shortError(err)}`)
    }
  }
  return written
}

// The in-cycle drain. Capped so a first deploy with a window of pending days
// cannot turn one cycle into a spend binge; newest first, so today's readers
// get their pages before the archive fills.
async function writeSettledRollups (entries, { endsAt = Infinity } = {}) {
  if (process.env.CHANGELOG_ROLLUP === '0' || !llmConfigured()) return 0
  if (Date.now() >= endsAt) return 0
  const limit = Math.max(0, Number(process.env.CHANGELOG_ROLLUP_LIMIT || 2))
  if (!limit) return 0
  const pending = forwardRollupBacklog({ entries }, { rollups: await loadRollups(DATA), limit })
  if (!pending.length) return 0
  const env = Number.isFinite(endsAt) ? { ...process.env, LLM_DEADLINE_AT: String(endsAt) } : process.env
  return await writeRollupBatch(pending, { endsAt, env })
}

/**
 * Daily roll-ups: a settled day's changes as a short bullet digest, shown above
 * the day's entries.
 *   rollups                       list settled days with no current digest
 *   rollups --backfill [N]        write the N newest pending digests (default 10)
 *   rollups --day YYYY-MM-DD      write one day, settled or not
 *   rollups --force               rewrite even when the stored digest is current
 *   rollups --push                commit and push what was written
 */
async function cmdRollups (argv) {
  const doc = await loadChangelog(DATA)
  if (!doc?.entries?.length) throw new Error('data/changelog.json missing: run generate first')
  const force = argv.includes('--force')
  const dayIdx = argv.indexOf('--day')
  const { acquired, result } = await withLock(LOCK, async () => {
    const rollups = await loadRollups(DATA)
    let pending
    if (dayIdx !== -1) {
      const day = argv[dayIdx + 1]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('rollups --day needs a YYYY-MM-DD date')
      const rows = doc.entries.filter(e => !e.noise && (e.day || String(e.date || '').slice(0, 10)) === day)
      if (!rows.length) throw new Error(`no meaningful entries recorded on ${day}`)
      const missing = rows.filter(e => !e.ai?.title || !e.ai?.summary).length
      if (missing) throw new Error(`${day} still has ${missing} unsummarized row(s): wait for the enrichment drain`)
      if (!force && rollups[day]?.v === ROLLUP_V && rollups[day]?.source === rollupFingerprint(day, rows)) {
        log(`[rollups] ${day} is already current (${rollups[day].bullets.length} bullet(s)); pass --force to rewrite it`)
        return { written: 0, pending: 0 }
      }
      pending = [{ day, entries: rows }]
    } else {
      const backfill = argv.indexOf('--backfill')
      if (backfill === -1) {
        pending = rollupBacklog(doc, { rollups })
        const stale = pending.filter(p => rollups[p.day]).length
        log(`[rollups] ${Object.keys(rollups).length} stored, ${pending.length} pending (${pending.length - stale} missing, ${stale} stale/older-version)`)
        for (const p of pending.slice(0, 10)) log(`[rollups]   ${p.day} (${rollups[p.day] ? 'stale' : 'missing'})`)
        if (pending.length > 10) log(`[rollups]   ... ${pending.length - 10} more`)
        return { written: 0, pending: pending.length }
      }
      const amount = Math.max(1, Number(argv[backfill + 1]) || 10)
      pending = rollupBacklog(doc, { rollups, limit: amount, force })
      if (!pending.length) {
        log('[rollups] every settled, digestible day is current')
        return { written: 0, pending: 0 }
      }
      log(`[rollups] writing ${pending.length} digest(s), newest first${force ? ' (forced rewrite)' : ''}`)
    }
    const requested = pending.length
    const written = await writeRollupBatch(pending)
    if (written && argv.includes('--push')) {
      await commitAndPushData({ message: `data: write ${written} day roll-up(s) (${utcStamp()} UTC)` })
    } else if (written) {
      log('[rollups] data written locally, not committed (pass --push)')
    }
    return { written, pending: requested - written }
  })
  if (!acquired) {
    log('another generate/backfill run holds the worktree lock: skipping roll-ups')
    return
  }
  if (result?.pending) log(`[rollups] ${result.pending} digest(s) still pending`)
}

/**
 * The CI half of the size budget: the same check as the relay's pre-push
 * guard, visible in generator-check so a growing file fails a run long before
 * GitHub would reject a push.
 */
async function cmdCheckSize () {
  const files = await trackedDataFiles(ROOT, DATA)
  const { over, near } = findOverBudget(files)
  for (const f of near) log(`[check-size] WARNING ${relative(ROOT, f.path)} is ${sizeText(f.bytes)} (warn at ${sizeText(SIZE_WARN_BYTES)})`)
  for (const f of over) log(`[check-size] FAIL ${relative(ROOT, f.path)} is ${sizeText(f.bytes)} (budget ${sizeText(SIZE_MAX_BYTES)})`)
  const evidence = await evidenceStats(DATA)
  log(`[check-size] evidence store: ${evidence.files} shard(s), widest directory ${evidence.widest} (${evidence.dirs} prefix dir(s))` +
    `${evidence.flat ? `, ${evidence.flat} legacy flat shard(s) awaiting migration` : ''}`)
  if (evidence.widest > EVIDENCE_WIDTH_WARN) {
    log(`[check-size] WARNING evidence directory width ${evidence.widest} exceeds the ${EVIDENCE_WIDTH_WARN}-shard guidance; the hash fan-out is not keeping up`)
  }
  const largest = [...files].sort((a, b) => b.bytes - a.bytes)[0]
  if (!over.length) {
    log(`[check-size] ${files.length} tracked files under data/: largest is ${largest ? `${relative(ROOT, largest.path)} at ${sizeText(largest.bytes)}` : 'none'}`)
    return
  }
  process.exitCode = 1
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
    const doc = await loadChangelog(DATA)
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

  const doc = await loadChangelog(dataDir)
  if (!doc?.entries?.length) {
    console.error('Error: changelog.json missing: run generate first.')
    if (IS_MAIN) process.exit(1)
    return { ok: false, error: 'missing_changelog' }
  }
  // Human corrections reach Discord too, not only the rendered site.
  applyOverrides(doc.entries, await readJson(`${dataDir}/overrides.json`, {}))

  const statePath = `${dataDir}/state.json`
  const state = (await readJson(statePath, null)) || {}
  const lastBroadcast = state.lastBroadcastSha

  // Candidates: meaningful commits only. data/changelog.json is stored
  // OLDEST-first (sortEntries), but every walk below wants newest-first before
  // reversing into send order -- so the list is sorted explicitly instead of
  // trusted. Walking the raw order used to broadcast the OLDEST entries first,
  // then pin lastBroadcastSha to the list's head and log "no new commits"
  // forever while new work piled up at the other end.
  const meaningful = doc.entries
    .filter(e => !e.noise)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.sha < b.sha ? 1 : -1)))
  let pending = []

  if (force || !lastBroadcast) {
    // The newest `limit`, sent in the order they landed (oldest of them first).
    pending = meaningful.slice(0, limit).reverse()
  } else {
    const idx = meaningful.findIndex(e => e.sha === lastBroadcast)
    if (idx === -1) {
      // A watermark this history does not hold (rescan, re-dated rows):
      // continue from the newest single commit rather than replaying history.
      pending = meaningful.slice(0, 1)
    } else if (idx > 0) {
      // Everything newer than the watermark, oldest of them first.
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

