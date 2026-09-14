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
import { git, readJson, writeJson, writeText, log, ymd, pruneDiffs, pool, withLock } from './lib/util.mjs'
import { capturePendingWrites, persistMerged } from './lib/mergedata.mjs'
import {
  listCommits, isSyncCommit, analyzeSyncCommit, analyzeCommunityCommit,
  extractCleanDiff, churnLabel, testLabel, SYNC_SUBJECT, TEST_RE, extractRawDiff, EMPTY_TREE } from './lib/analyze.mjs'
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
  const clean = await extractCleanDiff(REPO_DIR, base, e.sha, 48000, !e.testOnly)
  if (clean.trim()) return clean
  // A churn row's entire change IS the lockfile, so the clean form is empty by
  // construction. CHANGELOG_LLM_CHURN=1 sends the raw diff instead; off by
  // default because "dependency versions moved" is what the deterministic label
  // already says, and it costs ~1,900 calls to be told it again.
  return e.noise && process.env.CHANGELOG_LLM_CHURN === '1'
    ? extractRawDiff(REPO_DIR, base, e.sha, 12000)
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

async function fetchOpenPrs () {
  // Nice-to-have, degrade silently. Cached 6h to protect the rate limit
  // (hourly generate would otherwise burn 1 call/run + previews).
  try {
    const cached = await readJson(`${DATA}/open-prs.json`, null)
    if (cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < 6 * 3600000 && cached.prs?.length) {
      return cached.prs
    }
    const headers = { 'user-agent': 'freebuff-changelog', accept: 'application/vnd.github+json' }
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch('https://api.github.com/repos/CodebuffAI/freebuff/pulls?state=open&sort=created&direction=desc&per_page=60', { headers, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return cached?.prs || null
    const prs = (await res.json()).map(p => ({
      number: p.number, title: p.title, url: p.html_url, author: p.user?.login,
      created: p.created_at, updated: p.updated_at, draft: p.draft, comments: p.comments,
      additions: p.additions, deletions: p.deletions, files: p.changed_files
    }))
    // Per-PR stats need one extra call each: fetch with bounded concurrency.
    // Missing stats degrade to null (card hides the diffstat).
    const ghGet = async (path, accept) => {
      try {
        const r = await fetch(`https://api.github.com${path}`, { headers: { ...headers, ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(15000) })
        if (!r.ok) return null
        return accept ? await r.text() : await r.json()
      } catch { return null }
    }
    await pool(prs.filter(p => p.additions == null).map(p => async () => {
      const full = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}`)
      if (full) { p.additions = full.additions; p.deletions = full.deletions; p.files = full.changed_files; p.comments = full.comments ?? p.comments }
    }), 4)
    // Inline diff preview (first ~120 lines): fetched once per PR, persisted
    // in data/pr-diffs/, served from /pr-diffs/<n>.diff. Missing file
    // degrades to a GitHub link. Skips PRs already on disk so refreshes
    // cost ~0 calls when the list is unchanged.
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises')
    await mk(resolve(DATA, 'pr-diffs'), { recursive: true })
    await pool(prs.filter(p => !existsSync(resolve(DATA, `pr-diffs/${p.number}.diff`))).map(p => async () => {
      const diff = await ghGet(`/repos/CodebuffAI/freebuff/pulls/${p.number}`, 'application/vnd.github.diff')
      if (typeof diff === 'string' && diff.startsWith('diff --git')) {
        await wf(resolve(DATA, `pr-diffs/${p.number}.diff`), diff.split('\n').slice(0, 120).join('\n'))
        p.hasDiff = true
      }
    }), 4)
    // Mark previews already on disk (skipped above, still viewable).
    for (const p of prs) {
      if (!p.hasDiff && existsSync(resolve(DATA, `pr-diffs/${p.number}.diff`))) p.hasDiff = true
    }
    await writeJson(`${DATA}/open-prs.json`, { fetchedAt: new Date().toISOString(), prs })
    return prs
  } catch { return null }
}

function decorate (e) {
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
  const churn = (lockOnly || e.files.total === 0) && !e.modelChanges && !e.version && !e.cmdChanges
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
      const n = await enrichWithLlm(toEnrich, llmPatchFor, DATA)
      log(`LLM enriched ${n} new entries`)
    }
  }
  // ELI5 scans the whole entry set rather than only this run's additions: the
  // summary it explains may have been written minutes ago by the other pass.
  // This call is what makes a brand-new entry arrive with its plain-English line
  // already attached instead of waiting for a backfill.
  const eli5N = await enrichEli5(entries, DATA)
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
  // write. backfillDiffs sets hasDiff when it creates a file, pruneDiffs deletes
  // files older than 90 days, and running prune after the write left 58 rows
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
  await prunePrDiffs(prs || [])

  log(`wrote ${entries.length} entries (${added} new this run)` + (prs ? `, ${prs.length} open PRs` : ''))
  // Newest last, matching analyze order: callers front-load these for
  // summarization so a fresh upstream commit is not stuck behind the backlog.
  return { newShas: newlyAddedEntries.map(e => e.sha) }
}

// Retention: delete pr-diffs/*.diff for PRs no longer open. Stale previews
// accumulate as PRs merge; the client degrades to a GitHub link when missing.
export async function prunePrDiffs (openPrs) {
  const { readdir, unlink } = await import('node:fs/promises')
  const dir = resolve(DATA, 'pr-diffs')
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
  const isCurrent = (e) => e.ai?.title && (e.ai?.v ?? 1) >= PROMPT_V
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
      priorityShas: new Set(freshShas.slice(-limit))
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
      priorityShas: new Set(freshShas.slice(-limit))
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
    await commitAndPushData({
      message: didSummarize
        ? `data: LLM backfill (${utcStamp()} UTC)`
        : `data: update changelog (${utcStamp()} UTC)`,
      // entries carry this cycle's AI grafts in memory only until we write them.
      overrides: { [`${DATA}/changelog.json`]: existing }
    })
  } else if (didSync || didSummarize) {
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
  await buildSite({ changelog, openPrs: prs, dist })

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
  const calls = llmConfigured(env) ? await enrichWithLlm(entries, llmPatchFor, DATA, env, { retryErrors: true }) : 0
  const eli5 = llmConfigured(env) ? await enrichEli5(entries, DATA, env, { retryErrors: true }) : 0
  if (!llmConfigured(env)) log('LLM not configured (CHANGELOG_LLM=1 and LLM_API_KEY required in .env): stored diffs only')

  const isCurrent = (e) => e.ai?.title && (e.ai?.v ?? 1) >= PROMPT_V
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
