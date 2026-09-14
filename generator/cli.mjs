// generator/cli.mjs - entrypoint: generate (analyze upstream -> data/) and
// build (data/ → dist/ static site).
//
//   node generator/cli.mjs generate [--repo URL] [--full]
//   node generator/cli.mjs build
//   node generator/cli.mjs preview [port]
import { mkdir, readFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, readJson, writeJson, writeText, log, ymd, pruneDiffs, pool } from './lib/util.mjs'
import {
  listCommits, isSyncCommit, analyzeSyncCommit, analyzeCommunityCommit,
  diffNameStatus, diffPatch, extractCleanDiff, SYNC_SUBJECT, TEST_RE
} from './lib/analyze.mjs'
import { enrichWithLlm, llmConfigured } from './lib/llm.mjs'
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
  e.skip = lockOnly || (testOnly && !e.modelChanges && !e.version && !e.cmdChanges)
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
    if (e.skip) { bySha.set(c.sha, { sha: c.sha, skip: true, date: e.date }); continue }
    bySha.set(c.sha, e)
    newlyAddedEntries.push(e)
    added++
    if (added % 200 === 0) log(`${added} entries so far (${c.sha.slice(0, 8)})`)
  }

  let entries = [...bySha.values()].filter(e => !e.skip)
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sha < b.sha ? -1 : 1))

  // Hourly sync behavior: only generate diffs & summarize NEWLY added entries this run.
  // Backfilling of historical/existing entries is handled by the 1-minute loop (npm run backfill / watch).
  const toEnrich = (full || !state.lastSha) ? entries : newlyAddedEntries
  if (toEnrich.length > 0) {
    await backfillDiffs(toEnrich, 500)
    if (llmConfigured()) {
      const getPatch = async (e) => {
        if (e.kind !== 'sync') return ''
        const prev = e.prevSha || (await git(['rev-parse', `${e.sha}^`], REPO_DIR, { allowFail: true }))?.trim()
        if (!prev) return ''
        const files = await diffNameStatus(REPO_DIR, prev, e.sha)
        const targets = files.map(f => f.path).filter(p => !p.endsWith('bun.lock') && !TEST_RE.test(p)).slice(0, 8)
        if (!targets.length) return ''
        return diffPatch(REPO_DIR, prev, e.sha, targets)
      }
      const n = await enrichWithLlm(toEnrich, getPatch, DATA)
      log(`LLM enriched ${n} new entries`)
    }
  }

  const prevScanned = existing.counts?.commitsScanned || 0
  const changelog = {
    version: 1,
    repo: META.repoUrl,
    generatedAt: new Date().toISOString(),
    headSha: head,
    counts: {
      commitsScanned: full || !isAncestor ? commits.length : (prevScanned || entries.length) + commits.length,
      entries: entries.length,
      syncEra: entries.filter(e => e.kind === 'sync').length,
      community: entries.filter(e => e.kind === 'community').length
    },
    entries
  }
  await writeJson(`${DATA}/changelog.json`, changelog)
  await writeJson(`${DATA}/state.json`, { lastSha: head, runs: (state.runs || 0) + 1, updatedAt: changelog.generatedAt })
  await pruneDiffs(resolve(DATA, 'diffs'), entries)

  const prs = await fetchOpenPrs()

  log(`wrote ${entries.length} entries (${added} new this run)` + (prs ? `, ${prs.length} open PRs` : ''))
}

async function backfillDiffs (entries, max = 1000) {
  const diffDir = resolve(DATA, 'diffs')
  await mkdir(diffDir, { recursive: true })
  const syncs = entries.filter(e => e.kind === 'sync').reverse()
  let count = 0
  for (const e of syncs) {
    const diffFile = resolve(diffDir, `${e.sha}.diff`)
    if (existsSync(diffFile)) {
      e.hasDiff = true
      continue
    }
    if (count >= max) continue
    const prev = e.prevSha || (await git(['rev-parse', `${e.sha}^`], REPO_DIR, { allowFail: true }))?.trim()
    if (!prev) continue
    const diff = await extractCleanDiff(REPO_DIR, prev, e.sha)
    if (diff) {
      await writeText(diffFile, diff)
      e.hasDiff = true
      count++
    }
  }
  if (count > 0) log(`generated ${count} diffs in data/diffs/`)
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

async function cmdCatchUp (argv) {
  // Cheap local check first: idle cycles exit before any network.
  const existing = await readJson(`${DATA}/changelog.json`, { version: 1, entries: [] })
  let entries = existing.entries || []
  if (!entries.length) {
    log('no entries found: running generate first')
    await cmdGenerate(argv)
    return
  }

  const syncEntries = entries.filter(e => e.kind === 'sync')
  const unsummarizedSync = syncEntries.filter(e => !e.ai?.title)
  log(`[backfill] ${syncEntries.length} total sync entries (${unsummarizedSync.length} remaining to summarize)`)

  if (unsummarizedSync.length === 0) {
    log('[backfill] all existing sync entries already have AI summaries!')
    return
  }

  // Work exists: sync with origin before expensive calls.
  const currentBranch = (await git(['branch', '--show-current'], ROOT, { allowFail: true }))?.trim() || 'main'
  try {
    await git(['pull', '--rebase', 'origin', currentBranch], ROOT, { allowFail: true })
  } catch {}

  const head = await ensureRepo()
  await backfillDiffs(entries, 1000)

  if (llmConfigured()) {
    const getPatch = async (e) => {
      if (e.kind !== 'sync') return ''
      const prev = e.prevSha || (await git(['rev-parse', `${e.sha}^`], REPO_DIR, { allowFail: true }))?.trim()
      if (!prev) return ''
      const files = await diffNameStatus(REPO_DIR, prev, e.sha)
      const targets = files.map(f => f.path).filter(p => !p.endsWith('bun.lock') && !TEST_RE.test(p)).slice(0, 8)
      if (!targets.length) return ''
      return diffPatch(REPO_DIR, prev, e.sha, targets)
    }
    let limit = Number(process.env.CHANGELOG_LLM_LIMIT || 5)
    const limitIdx = argv.indexOf('--limit')
    if (limitIdx !== -1 && argv[limitIdx + 1]) {
      limit = Number(argv[limitIdx + 1]) || limit
    }
    const envWithLimit = { ...process.env, CHANGELOG_LLM_LIMIT: String(limit) }
    const n = await enrichWithLlm(entries, getPatch, DATA, envWithLimit, { retryErrors: true })
    const remaining = entries.filter(e => e.kind === 'sync' && !e.ai?.title).length
    log(`[backfill] enriched ${n} entries with LLM (${remaining} remaining)`)
    if (remaining < unsummarizedSync.length) {
      await writeJson(`${DATA}/changelog.json`, existing)
    }
  } else {
    log('LLM not configured (CHANGELOG_LLM=1 and LLM_API_KEY required in .env)')
  }

  if (argv.includes('--push')) {
    const status = (await git(['status', '--porcelain', 'data/'], ROOT, { allowFail: true })) || ''
    if (status.trim()) {
      log('committing and pushing data to git…')
      await git(['pull', '--rebase', 'origin', currentBranch], ROOT, { allowFail: true })
      await git(['add', 'data'], ROOT)
      const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 16)
      await git(['commit', '-m', `data: LLM backfill (${nowUtc} UTC)`], ROOT)
      await git(['push', 'origin', currentBranch], ROOT)
      log('pushed to origin: Cloudflare Pages will deploy automatically.')
    } else {
      log('data is already up to date: nothing to push.')
    }
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

const [, , cmd, ...rest] = process.argv
if (cmd === 'generate') await cmdGenerate(rest)
else if (cmd === 'catch-up') await cmdCatchUp(rest)
else if (cmd === 'watch' || cmd === 'backfill') await cmdWatch(rest)
else if (cmd === 'build') await cmdBuild()
else if (cmd === 'preview') await cmdPreview(Number(rest[0]) || 8788)
else {
  console.log(`usage:
  node generator/cli.mjs generate [--full]       # analyze upstream freebuff (hourly sync)
  node generator/cli.mjs catch-up [--push]      # single batch LLM backfill
  node generator/cli.mjs backfill [--push]      # 1-minute continuous backfill loop
  node generator/cli.mjs watch [--push]         # alias for backfill
  node generator/cli.mjs build                  # render static site → dist/
  node generator/cli.mjs preview [port]         # local preview of dist/`)
  process.exit(cmd ? 1 : 0)
}
