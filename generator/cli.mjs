// generator/cli.mjs — entrypoint: generate (analyze upstream → data/) and
// build (data/ → dist/ static site).
//
//   node generator/cli.mjs generate [--repo URL] [--full]
//   node generator/cli.mjs build
//   node generator/cli.mjs preview [port]
import { mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, readJson, writeJson, writeText, log, ymd } from './lib/util.mjs'
import {
  listCommits, isSyncCommit, analyzeSyncCommit, analyzeCommunityCommit,
  diffNameStatus, diffPatch, SYNC_SUBJECT
} from './lib/analyze.mjs'
import { enrichWithLlm, llmConfigured } from './lib/llm.mjs'
import { buildSite } from './lib/site.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data')
const CACHE = resolve(ROOT, '.cache')
const REPO_DIR = resolve(CACHE, 'freebuff')
const REPO_URL = process.env.FREEBUFF_REPO || 'https://github.com/CodebuffAI/freebuff.git'
const META = { repoUrl: 'https://github.com/CodebuffAI/freebuff', compareUrl: 'https://github.com/CodebuffAI/freebuff/compare' }

const TEST_RE = /(^|\/)(__tests__|tests?)\/|\.test\.tsx?$/
const NOISE_ONLY_RE = /^(bun\.lock|README\.md|README\.zh-CN\.md|\.bun-version)$/

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
  // Nice-to-have, degrade silently. Uses unauthenticated API (or GITHUB_TOKEN).
  try {
    const headers = { 'user-agent': 'freebuff-changelog', accept: 'application/vnd.github+json' }
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch('https://api.github.com/repos/CodebuffAI/freebuff/pulls?state=open&sort=created&direction=desc&per_page=60', { headers, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    return (await res.json()).map(p => ({
      number: p.number, title: p.title, url: p.html_url, author: p.user?.login,
      created: p.created_at, updated: p.updated_at, draft: p.draft, comments: p.comments, additions: p.additions, deletions: p.deletions
    }))
  } catch { return null }
}

function decorate (e) {
  const testOnly = (e.files.added.length + e.files.removed.length + e.files.modified.length) > 0 &&
    [...e.files.added, ...e.files.removed, ...e.files.modified].every(p => TEST_RE.test(p))
  const lockOnly = e.files.meaningful === 0
  e.skip = lockOnly || (testOnly && !e.modelChanges && !e.version && !e.cmdChanges)
  if (e.modelChanges) e.category = 'Model Catalog'
  else if (e.cmdChanges) e.category = 'Commands'
  else if (e.areas.includes('CLI')) e.category = 'CLI'
  else if (e.areas.includes('SDK')) e.category = 'SDK'
  else if (e.areas.includes('Agent Runtime')) e.category = 'Agent Runtime'
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
    log(state.lastSha && !isAncestor ? 'history rewritten — full rescan' : 'full scan')
    commits = await listCommits(REPO_DIR)
  }

  const existing = await readJson(`${DATA}/changelog.json`, { version: 1, entries: [] })
  const bySha = new Map(existing.entries.map(e => [e.sha, e]))
  let added = 0, updated = 0

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
    e.title = e.title || deriveTitle(e)
    bySha.set(c.sha, e)
    added++
    if (added % 200 === 0) log(`${added} entries so far (${c.sha.slice(0, 8)})`)
  }

  let entries = [...bySha.values()].filter(e => !e.skip)
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sha < b.sha ? -1 : 1))

  if (llmConfigured()) {
    const getPatch = async (e) => {
      if (e.kind !== 'sync' || !e.prevSha) return ''
      const files = await diffNameStatus(REPO_DIR, e.prevSha, e.sha)
      const targets = files.map(f => f.path).filter(p => !p.endsWith('bun.lock') && !TEST_RE.test(p)).slice(0, 8)
      if (!targets.length) return ''
      return diffPatch(REPO_DIR, e.prevSha, e.sha, targets)
    }
    const n = await enrichWithLlm(entries, getPatch, DATA)
    log(`LLM enriched ${n} entries`)
  }

  const changelog = {
    version: 1,
    repo: META.repoUrl,
    generatedAt: new Date().toISOString(),
    headSha: head,
    counts: {
      commitsScanned: commits.length,
      entries: entries.length,
      syncEra: entries.filter(e => e.kind === 'sync').length,
      community: entries.filter(e => e.kind === 'community').length
    },
    entries
  }
  await writeJson(`${DATA}/changelog.json`, changelog)
  await writeJson(`${DATA}/state.json`, { lastSha: head, runs: (state.runs || 0) + 1, updatedAt: changelog.generatedAt })

  const prs = await fetchOpenPrs()
  if (prs) await writeJson(`${DATA}/open-prs.json`, prs)

  log(`wrote ${entries.length} entries (${added} new this run)` + (prs ? `, ${prs.length} open PRs` : ''))
}

function deriveTitle (e) {
  if (e.modelChanges) {
    const { added = [], removed = [] } = e.modelChanges
    if (added.length && removed.length) return `${added[0]} replaces ${removed[0]} in the model lineup`
    if (added.length) return `New model available: ${added[0]}`
    if (removed.length) return `${removed[0]} removed from the model lineup`
  }
  if (e.version) return `Release ${e.version}`
  return e.summary.split(/[.:]/)[0].slice(0, 70)
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

async function cmdBuild () {
  const changelog = await readJson(`${DATA}/changelog.json`, null)
  if (!changelog) throw new Error('data/changelog.json missing — run generate first')
  const prs = await readJson(`${DATA}/open-prs.json`, [])
  const dist = resolve(ROOT, 'dist')
  const t0 = Date.now()
  await buildSite({ changelog, openPrs: prs, dist })
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
      catch { res.writeHead(404); res.end('404') }
    }
  }).listen(port, () => log(`preview: http://localhost:${port}`))
}

function MIME (f) {
  if (f.endsWith('.html')) return 'text/html; charset=utf-8'
  if (f.endsWith('.json')) return 'application/json; charset=utf-8'
  if (f.endsWith('.xml')) return 'application/rss+xml; charset=utf-8'
  if (f.endsWith('.css')) return 'text/css'
  if (f.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv
if (cmd === 'generate') await cmdGenerate(rest)
else if (cmd === 'build') await cmdBuild()
else if (cmd === 'preview') await cmdPreview(Number(rest[0]) || 8788)
else {
  console.log(`usage:\n  node generator/cli.mjs generate [--full]   # fetch freebuff, analyze new commits\n  node generator/cli.mjs build                     # render static site → dist/\n  node generator/cli.mjs preview [port]              # local preview of dist/`)
  process.exit(cmd ? 1 : 0)
}
