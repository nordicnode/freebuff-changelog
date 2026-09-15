// generator/lib/analyze.mjs - turns freebuff git history into changelog entries.
//
// The public repo CodebuffAI/freebuff is a mirror: a bot pushes "Sync public
// snapshot from freebuff-private" commits whose diffs each contain one real
// change from the private repo. Commit messages carry no info, so the diff IS
// the changelog. Strategy:
//   1. Segment history: sync-snapshot commits vs. real (community) commits.
//   2. For each sync commit, diff parent..commit and extract structured facts
//      (model catalog moves, version bumps, file adds/removes, touched areas).
//   3. Classify + render a deterministic summary; an optional LLM layer can
//      rewrite summaries later (cached per commit, see generator/lib/llm.mjs).
import { git, US, RS, toUtc } from './util.mjs'
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export const SYNC_SUBJECT = 'Sync public snapshot from freebuff-private'

const LOG_FORMAT = ['%H', '%P', '%cI', '%s', '%an', '%b'].join(US) + RS

// ---------------------------------------------------------------------------
// 1. History segmentation
// ---------------------------------------------------------------------------

export async function listCommits (repoDir, { since, until } = {}) {
  const args = ['-c', 'core.quotepath=false', 'log', 'origin/main', `--format=${LOG_FORMAT}`, '--reverse']
  if (since) args.push(`--since=${since}`)
  if (until) args.push(`--until=${until}`)
  const out = await git(args, repoDir)
  const commits = []
  for (const rec of out.split(RS)) {
    const t = rec.replace(/^\n/, '')
    if (!t.trim()) continue
    const [sha, parents, date, subject, author, body] = t.split(US)
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() ? parents.trim().split(' ') : [],
      date: toUtc(date.trim()),
      subject: (subject || '').trim(),
      author: (author || '').trim(),
      body: (body || '').trim()
    })
  }
  return commits
}

export function isSyncCommit (c) {
  return c.subject.startsWith('Sync public snapshot')
}

export function sourceRef (c) {
  const m = /Source:\s*[\w./-]+@([0-9a-f]{40})/.exec(c.body || '')
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// 2. Diff facts
// ---------------------------------------------------------------------------

export async function diffNameStatus (repoDir, base, head) {
  // -M enables rename detection so renames don't show as add+delete.
  const out = await git(['diff', '--find-renames', '-M', '--name-status', `${base}...${head}`], repoDir)
  const files = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const st = parts[0]
    if (st.startsWith('R')) files.push({ status: 'renamed', path: parts[parts.length - 1], from: parts[1] })
    else if (st === 'A') files.push({ status: 'added', path: parts[1] })
    else if (st === 'D') files.push({ status: 'removed', path: parts[1] })
    else if (st === 'M') files.push({ status: 'modified', path: parts[1] })
    else files.push({ status: st.toLowerCase(), path: parts[1] ?? parts[parts.length - 1] })
  }
  return files
}

export async function diffNumstat (repoDir, base, head) {
  const out = await git(['diff', '--numstat', `${base}...${head}`], repoDir)
  let additions = 0, deletions = 0
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+)\t(\d+)\t/)
    if (m) { additions += Number(m[1]); deletions += Number(m[2]) }
  }
  return { additions, deletions }
}

// Targeted textual diff, restricted to interesting files (skip bun.lock, etc).
export async function diffPatch (repoDir, base, head, paths, maxBytes = 24000) {
  const args = ['diff', '--no-color', '-U3', `${base}...${head}`, '--']
  for (const p of paths) args.push(p)
  const out = await git(args, repoDir)
  if (!out) return ''
  return out.length > maxBytes ? out.slice(0, maxBytes) + '\n…[truncated]…\n' : out
}

// Clean unified diff of a commit for in-browser inspection, excluding lockfiles.
// With excludeTests, pure test files drop out too (matches what the LLM prompt claims).
const DIFF_TRUNCATED = '\n\n… [diff truncated: view full diff on GitHub] …\n'

/**
 * `git diff` into a temp file, read back at most maxBytes.
 *
 * Writing to a file rather than to stdout is the point. One snapshot commit in
 * this repo produced a 67 MB diff: execFile's maxBuffer threw, and because the
 * throw happened inside a `git` call the whole backfill run died. Truncating the
 * returned string caps what we *keep*, never what git streams through the
 * process, so it cannot protect against that.
 */
async function diffText (repoDir, range, pathspecs, maxBytes) {
  const tmp = `${tmpdir()}/fb-diff-${randomBytes(8).toString('hex')}.patch`
  try {
    const ok = await git(['diff', '--no-color', '-U3', ...range, `--output=${tmp}`, '--', ...pathspecs], repoDir, { allowFail: true })
    if (ok === null) return ''
    let fh
    try {
      fh = await open(tmp, 'r')
    } catch { return '' } // git wrote nothing at all: an empty diff
    try {
      const buf = Buffer.allocUnsafe(maxBytes + 1)
      const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0)
      if (bytesRead === 0) return ''
      const over = bytesRead > maxBytes
      return buf.subarray(0, over ? maxBytes : bytesRead).toString('utf8') + (over ? DIFF_TRUNCATED : '')
    } finally { await fh.close() }
  } finally { await rm(tmp, { force: true }) }
}

// Clean unified diff of a commit for in-browser inspection, excluding lockfiles.
// With excludeTests, pure test files drop out too (matches what the LLM prompt claims).
export async function extractCleanDiff (repoDir, base, head, maxBytes = 48000, excludeTests = false) {
  // `base...head` needs two commits; the empty tree is neither, so a root commit
  // diffs against it directly.
  const range = base === EMPTY_TREE ? [EMPTY_TREE, head] : [`${base}...${head}`]
  const pathspecs = ['.',
    ':(exclude)*bun.lock*',
    ':(exclude)*package-lock.json',
    ':(exclude)*pnpm-lock.yaml',
    ':(exclude)*yarn.lock']
  if (excludeTests) {
    pathspecs.push(':(exclude)*__tests__*', ':(exclude)*test.*', ':(exclude)*spec.*', ':(exclude)*/tests/*')
  }
  return diffText(repoDir, range, pathspecs, maxBytes)
}

// ---------------------------------------------------------------------------
// 3. Semantic extractors
// ---------------------------------------------------------------------------

// Model catalog rows look like:
//   | **GPT-5.6 Luna** | Full access | Strong all-around with native images |
// Tables are classified by header: model tables start with a Model/模型 cell,
// product tables with Product/产品. Header gating (not a product-name denylist)
// decides what counts, so new product rows can never leak into the catalog.
const MODEL_ROW_RE = /^\|\s*\*\*(.+?)\*\*\s*\|/
const MODEL_HEADER_RE = /^\|\s*(model|模型)\s*\|/i
const PRODUCT_HEADER_RE = /^\|\s*(product|产品)\s*\|/i

// Split markdown text into consecutive-pipe-line tables with header + rows.
export function parseMarkdownTables (text) {
  const tables = []
  let current = null
  for (const raw of text.split('\n')) {
    if (/^\s*\|/.test(raw)) {
      if (!current) current = []
      current.push(raw.trim())
    } else {
      if (current && current.length >= 2) tables.push(current)
      current = null
    }
  }
  if (current && current.length >= 2) tables.push(current)
  return tables
}

function isModelTable (lines) {
  const header = lines[0]
  if (!MODEL_HEADER_RE.test(header)) return false
  return !PRODUCT_HEADER_RE.test(header)
}

// Model names from tables classified as model tables. Separator rows
// (| --- | --- |) never match MODEL_ROW_RE, so no special-casing needed.
export function catalogFromReadme (text) {
  const names = new Set()
  for (const lines of parseMarkdownTables(text || '')) {
    if (!isModelTable(lines)) continue
    for (const line of lines.slice(1)) {
      const m = MODEL_ROW_RE.exec(line)
      if (m) names.add(m[1].trim())
    }
  }
  return names
}

// Full row cells per model name, for before/after snapshot embeds.
export function catalogRowsFromReadme (text) {
  const rows = new Map()
  for (const lines of parseMarkdownTables(text || '')) {
    if (!isModelTable(lines)) continue
    for (const line of lines.slice(1)) {
      const m = MODEL_ROW_RE.exec(line)
      if (!m) continue
      const cells = line.split('|').slice(1, -1).map(c => c.replace(/\*\*/g, '').trim())
      if (cells.length >= 2) rows.set(m[1].trim(), cells.slice(0, 3))
    }
  }
  return rows
}

export function diffCatalogs (before, after) {
  const added = [...after].filter(m => !before.has(m))
  const removed = [...before].filter(m => !after.has(m))
  return { added, removed }
}

async function showFileAt (repoDir, rev, path) {
  const out = await git(['show', `${rev}:${path}`], repoDir, { allowFail: true })
  return out || ''
}

// Snapshot compare: parse the full model tables before/after instead of
// scanning hunks. Immune to hunk fragmentation, diff truncation, and
// product-table rows (header-gated). EN is primary, ZH cross-checks it.
// Returns { added, removed, tables } where tables holds full row cells for
// snapshot embeds (before/after per changed model).
export async function snapshotModelChanges (repoDir, base, head) {
  const beforeText = await showFileAt(repoDir, base, 'README.md')
  const afterText = await showFileAt(repoDir, head, 'README.md')
  const beforeEn = catalogFromReadme(beforeText)
  const afterEn = catalogFromReadme(afterText)
  if (!beforeEn.size && !afterEn.size) return null
  const en = diffCatalogs(beforeEn, afterEn)
  const beforeZh = catalogFromReadme(await showFileAt(repoDir, base, 'README.zh-CN.md'))
  const afterZh = catalogFromReadme(await showFileAt(repoDir, head, 'README.zh-CN.md'))
  const zh = diffCatalogs(beforeZh, afterZh)
  const tables = {}
  const beforeRows = catalogRowsFromReadme(beforeText)
  const afterRows = catalogRowsFromReadme(afterText)
  const changed = new Set([...en.added, ...en.removed])
  for (const name of changed) {
    tables[name] = { before: beforeRows.get(name) || null, after: afterRows.get(name) || null }
  }
  const withTables = (r) => ({ ...r, tables })
  // Both languages track the same catalog: intersect to kill translation lag.
  // Fall back to EN when ZH is absent (older history) or disagrees entirely.
  const zhEmpty = !zh.added.length && !zh.removed.length
  const agree = (a, b) => a.every(x => b.includes(x))
  if (!beforeZh.size && !afterZh.size) return withTables(en)
  if (zhEmpty && (en.added.length || en.removed.length)) return withTables(en)
  if (agree(en.added, zh.added) && agree(en.removed, zh.removed)) return withTables(en)
  if (agree(zh.added, en.added) && agree(zh.removed, en.removed)) return withTables({ ...zh })
  const added = en.added.filter(x => zh.added.includes(x))
  const removed = en.removed.filter(x => zh.removed.includes(x))
  return withTables({ added, removed })
}

export function extractModelTableChanges (patch) {
  // Hunk-scanning fallback for when full snapshots are unavailable (old
  // history without README at that rev). Best-effort: header-gated when the
  // hunk includes a table header, product-name guard otherwise. Prefer
  // snapshotModelChanges whenever both SHAs are available.
  const rawAdded = [], rawRemoved = []
  let inProductTable = false
  for (const line of patch.split('\n')) {
    if (/^(@@|diff --git)/.test(line)) inProductTable = false
    if (PRODUCT_HEADER_RE.test(line) || /Choose your Freebuff/i.test(line)) {
      inProductTable = true
      continue
    }
    if (MODEL_HEADER_RE.test(line) || /model catalog/i.test(line)) {
      inProductTable = false
      continue
    }
    if (inProductTable) continue

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const m = MODEL_ROW_RE.exec(line.slice(1))
      if (m) {
        const name = m[1].trim()
        if (!isProductName(name)) rawAdded.push(name)
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const m = MODEL_ROW_RE.exec(line.slice(1))
      if (m) {
        const name = m[1].trim()
        if (!isProductName(name)) rawRemoved.push(name)
      }
    }
  }

  // Net set differences: a model present in both added and removed only had description/metadata modified
  const added = rawAdded.filter(m => !rawRemoved.includes(m))
  const removed = rawRemoved.filter(m => !rawAdded.includes(m))
  return { added, removed }
}

// Fallback-only guard for headerless hunks: the product table has no Model
// header in-range, so its rows look identical to catalog rows.
const PRODUCT_NAMES = new Set([
  'Freebuff Desktop',
  'Freebuff CLI',
  'Freebuff Web',
  'Freebuff Cloud',
  'Freebuff Chat',
  'Freebuff Enterprise'
])

function isProductName (name) {
  return PRODUCT_NAMES.has(name) || /^Freebuff (Desktop|CLI|Web|Cloud|Chat|Enterprise)/i.test(name)
}

// Version bump in package.json
export function extractVersionBump (patch) {
  const adds = [...patch.matchAll(/^\+\s*['"]version['"]:\s*['"]([\d.]+)['"]/gm)].map(x => x[1])
  return adds.length ? adds[adds.length - 1] : null
}

// Slash-commands registry: cli/src/data/slash-commands.ts holds ALL_SLASH_COMMANDS
// with string `id:` fields. Snapshot both revs and set-diff the ids: renames
// (same block, new id) surface as add+remove, description edits as nothing.
const CMD_REGISTRY = 'cli/src/data/slash-commands.ts'
const CMD_ID_RE = /^\s*id:\s*['"`]([^'"`]+)['"`]/gm

export function commandIdsFromRegistry (text) {
  const ids = new Set()
  for (const m of (text || '').matchAll(CMD_ID_RE)) ids.add(m[1])
  return ids
}

export async function snapshotCommandChanges (repoDir, base, head) {
  const before = commandIdsFromRegistry(await showFileAt(repoDir, base, CMD_REGISTRY))
  const after = commandIdsFromRegistry(await showFileAt(repoDir, head, CMD_REGISTRY))
  if (!before.size && !after.size) return null
  const added = [...after].filter(c => !before.has(c)).map(c => '/' + c)
  const removed = [...before].filter(c => !after.has(c)).map(c => '/' + c)
  return { added, removed }
}

// Slash-commands registry: cli/src/constants/commands.ts or similar.
export function extractSlashCommandChanges (patch) {
  const rawAdded = [...patch.matchAll(/^\+\s*name:\s*['"`]([/a-z0-9-]+)['"`]/gm)].map(x => x[1])
  const rawRemoved = [...patch.matchAll(/^-\s*name:\s*['"`]([/a-z0-9-]+)['"`]/gm)].map(x => x[1])
  const filteredAdded = rawAdded.filter(c => c.startsWith('/'))
  const filteredRemoved = rawRemoved.filter(c => c.startsWith('/'))
  return {
    added: filteredAdded.filter(c => !filteredRemoved.includes(c)),
    removed: filteredRemoved.filter(c => !filteredAdded.includes(c))
  }
}

const AREA_MAP = [
  [/^cli\//, 'CLI'],
  [/^common\//, 'Shared/Core'],
  [/^packages\/agent-runtime\//, 'Agent Runtime'],
  [/^packages\/code-map\//, 'Code Map'],
  [/^packages\/llm-providers\//, 'LLM Providers'],
  [/^packages\//, 'Packages'],
  [/^sdk\//, 'SDK'],
  [/^agents\//, 'Agents'],
  [/^docs\//, 'Docs'],
  [/^freebuff\//, 'Packaging'],
  [/^evals\//, 'Evals'],
  [/^scripts\//, 'Tooling'],
  [/^\.github\//, 'CI'],
  [/^assets\//, 'Assets']
]

export function areaOf (path) {
  for (const [re, name] of AREA_MAP) if (re.test(path)) return name
  return 'Repo'
}

export function isNoiseFile (p) {
  return (
    /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p) ||
    p === '.bun-version' ||
    /^snapcraft\/icons\//.test(p) ||
    /\.svg$/.test(p)
  )
}

export const TEST_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[jt]sx?$/

// ---------------------------------------------------------------------------
// 4. Entry builder for one sync commit
// ---------------------------------------------------------------------------

export async function analyzeSyncCommit (repoDir, commit, prevSha, repoMeta) {
  const files = await diffNameStatus(repoDir, prevSha, commit.sha)
  const { additions, deletions } = await diffNumstat(repoDir, prevSha, commit.sha)
  const meaningful = files.filter(f => !isNoiseFile(f.path))
  // What got filtered out has to be remembered: a row that reports "no source
  // changes" must still be able to name the files it actually touched, or 1,788
  // lockfile commits would be described as merges.
  const churnedPaths = files.filter(f => isNoiseFile(f.path)).map(f => f.path)
  const sourceMeaningful = meaningful.filter(f => !TEST_RE.test(f.path))
  const testOnly = meaningful.length > 0 && sourceMeaningful.length === 0
  // And the same for tests: in a test-only commit these are the *only* files
  // there are, so leaving them out produced rows titled "Shared/Core update"
  // that named nothing and could never be summarized.
  const testPaths = meaningful.filter(f => TEST_RE.test(f.path)).map(f => f.path)
  const areas = [...new Set(meaningful.map(f => areaOf(f.path)))].filter(a => a !== 'Repo')

  const facts = []
  const patchTargets = pickPatchTargets(meaningful)

  let modelChanges = null
  let version = null
  let cmdChanges = null
  const readmeTouched = meaningful.some(f => f.path === 'README.md' || f.path === 'README.zh-CN.md')
  if (readmeTouched) {
    const mc = await snapshotModelChanges(repoDir, prevSha, commit.sha)
    if (mc && (mc.added.length || mc.removed.length)) modelChanges = mc
  }
  if (patchTargets.length) {
    const patch = await diffPatch(repoDir, prevSha, commit.sha, patchTargets)
    if (!modelChanges) {
      const readmePatch = patchForFile(patch, 'README.md') || patchForFile(patch, 'README.zh-CN.md')
      if (readmePatch) {
        const mc = extractModelTableChanges(readmePatch)
        if (mc.added.length || mc.removed.length) modelChanges = mc
      }
    }
    const pkgPatch = patchForFile(patch, 'cli/release/package.json')
    if (pkgPatch) version = extractVersionBump(pkgPatch) || version
    const registryTouched = meaningful.some(f => f.path === CMD_REGISTRY)
    if (registryTouched) {
      const cc = await snapshotCommandChanges(repoDir, prevSha, commit.sha)
      if (cc && (cc.added.length || cc.removed.length)) cmdChanges = cc
    }
    if (!cmdChanges && /(commands|slash)/i.test(patchTargets.join(' '))) {
      const cc = extractSlashCommandChanges(patch)
      if (cc.added.length || cc.removed.length) cmdChanges = cc
    }
    facts.push(...extractCommentFacts(patch))
  }

  // Consistent source file lists (tests excluded so headlines and chips match real code)
  const added = sourceMeaningful.filter(f => f.status === 'added').map(f => f.path)
  const removed = sourceMeaningful.filter(f => f.status === 'removed').map(f => f.path)
  const renamed = sourceMeaningful.filter(f => f.status === 'renamed')
  const modified = sourceMeaningful.filter(f => f.status === 'modified').map(f => f.path)

  const entry = {
    kind: 'sync',
    sha: commit.sha,
    prevSha,
    url: `${repoMeta.repoUrl}/commit/${commit.sha}`,
    compareUrl: `${repoMeta.compareUrl}/${prevSha.slice(0, 12)}...${commit.sha.slice(0, 12)}`,
    date: commit.date,
    sourceSha: sourceRef(commit),
    version,
    areas: areas.length ? areas : ['Repo'],
    modelChanges,
    cmdChanges,
    files: {
      total: files.length,
      meaningful: sourceMeaningful.length,
      rawMeaningful: meaningful.length,
      testOnly,
      churned: churnedPaths.slice(0, 12),
      tests: testPaths.slice(0, 12),
      added: added.slice(0, 12),
      removed: removed.slice(0, 12),
      renamed: renamed.slice(0, 8).map(r => ({ from: r.from, to: r.path })),
      modified: modified.slice(0, 16)
    },
    stats: { additions, deletions },
    facts: facts.slice(0, 6)
  }
  entry.title = entryTitle(entry)
  entry.summary = deterministicSummary(entry)
  entry.tags = tagsFor(entry)
  return entry
}

function pickPatchTargets (files) {
  const score = (p) => {
    if (TEST_RE.test(p)) return 0 // Test assertion comments and mocks must never become changelog facts
    if (p === 'README.md' || p === 'README.zh-CN.md') return 10
    if (/package\.json$/.test(p)) return 9
    if (/commands?\.(ts|tsx|js)$/.test(p) || /slash/i.test(p)) return 8
    if (/constants?\//.test(p)) return 7
    if (/\.md$/.test(p)) return 5
    if (/\.[jt]sx?$/.test(p)) return 3
    return 0
  }
  return files
    .map(f => ({ p: f.path, s: score(f.path) }))
    .filter(x => x.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(x => x.p)
}

function patchForFile (patch, file) {
  const re = new RegExp(`^diff --git a/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} b/`, 'm')
  const start = patch.search(re)
  if (start === -1) return null
  const next = patch.indexOf('\ndiff --git ', start + 5)
  return next === -1 ? patch.slice(start) : patch.slice(start, next)
}

// Pull out informative code comments the Freebuff team leaves in diffs
// (they write unusually thorough rationale comments; e.g. model retirements).
// Consecutive added comment lines are joined into paragraphs; only
// mostly-prose, sentence-terminated paragraphs survive (kills identifier junk).
export function extractCommentFacts (patch) {
  const facts = []
  let buf = []
  const flush = () => {
    if (!buf.length) return
    let text = buf.join(' ').replace(/\s+/g, ' ').trim()
    buf = []
    if (text.length < 45 || text.length > 300) return
    if (!/^[A-Z"'\[(-]/.test(text)) return // drop mid-sentence continuations
    text = text.replace(/^(TODO|FIXME|NOTE|WHY|HOW)\s*:?\s*/i, '')
    const lower = (text.match(/[a-z]/g) || []).length
    if (lower < text.length * 0.5) return
    if ((text.match(/[a-z]{3,}/g) || []).length < 9) return
    if (!/[.!?]$/.test(text)) return
    if (/^(Removed|Added|Modified|See|See also)\b.*\b(docs|test|section)\b/i.test(text) && text.length < 80) return
    facts.push(text)
  }
  for (const line of patch.split('\n')) {
    const m = /^([+-])\s*(?:\/\/|\/\*+|\*+)\s?(.*)$/.exec(line)
    if (!m) { flush(); continue }
    // Only capture added comments; ignore deletions and flush on deletion
    if (m[1] !== '+') { flush(); continue }
    const t = m[2].replace(/\*\/\s*$/, '').trim()
    if (!t) { flush(); continue }
    buf.push(t)
    if (buf.join(' ').length > 280) flush()
  }
  flush()
  return [...new Set(facts)].slice(0, 5)
}

function tagsFor (e) {
  const tags = []
  if (e.modelChanges) tags.push('models')
  if (e.version) tags.push('release')
  if (e.cmdChanges) tags.push('commands')
  if (e.files.added.length) tags.push('new-files')
  if (e.files.removed.length) tags.push('removals')
  if (e.areas.some(a => a === 'SDK')) tags.push('sdk')
  if (e.areas.some(a => a === 'CLI')) tags.push('cli')
  if (e.files.total > 25) tags.push('large')
  return tags
}

// ---------------------------------------------------------------------------
// 5. Deterministic summaries (LLM layer may override later)
// ---------------------------------------------------------------------------

export function deterministicSummary (e) {
  const bits = []
  if (e.modelChanges) {
    const { added = [], removed = [] } = e.modelChanges
    if (added.length && removed.length) bits.push(`Model catalog: ${listPhrase(added)} replaced ${listPhrase(removed)} in the free model picker.`)
    else if (added.length) bits.push(`Model catalog: ${listPhrase(added)} added to the free model picker.`)
    else if (removed.length) bits.push(`Model catalog: ${listPhrase(removed)} removed from the free model picker.`)
  }
  if (e.version) bits.push(`CLI release ${e.version} published.`)
  if (e.cmdChanges) {
    if (e.cmdChanges.added.length) bits.push(`New slash commands: ${e.cmdChanges.added.map(c => '`' + c + '`').join(', ')}.`)
    if (e.cmdChanges.removed.length) bits.push(`Removed slash commands: ${e.cmdChanges.removed.map(c => '`' + c + '`').join(', ')}.`)
  }
  if (e.files.added.length) bits.push(`New files: ${e.files.added.slice(0, 4).map(p => '`' + p + '`').join(', ')}${e.files.added.length > 4 ? ` (+${e.files.added.length - 4} more)` : ''}.`)
  if (e.files.removed.length) bits.push(`Removed: ${e.files.removed.slice(0, 4).map(p => '`' + p + '`').join(', ')}${e.files.removed.length > 4 ? ` (+${e.files.removed.length - 4} more)` : ''}.`)
  if (e.files.renamed.length) bits.push(`Renamed ${e.files.renamed.length} file(s).`)
  if (!bits.length && e.files.modified.length) {
    const areas = e.areas.join(', ')
    bits.push(`${areas === 'Repo' ? 'Internal' : areas} changes across ${e.files.modified.length} file(s) (+${e.stats.additions}/−${e.stats.deletions}).`)
  }
  return bits.join(' ') || `${e.areas.join(', ')}: ${e.files.total} file(s) changed.`
}

// Commits that touch no source at all: dependency lockfiles, icon assets, or
// merges with nothing against their first parent. They are *listed* (the site's
// job is to mirror the repository, and 30% of recent commits were silently
// missing) but marked, so they can be dimmed and kept out of feeds, search and
// the LLM queue -- there is nothing for a model to describe.
export function churnLabel (e) {
  const f = e.files || {}
  // `churned` carries the paths isNoiseFile() filtered out. Without it a
  // lockfile commit and a merge look identical -- both have an empty *source*
  // file list -- and 1,788 "bun.lock" rows were being published as "Merge
  // commit", which is not merely ugly, it is false.
  const paths = [...(f.added || []), ...(f.removed || []), ...(f.modified || []), ...(f.churned || [])]
  const stats = `+${e.stats.additions}/−${e.stats.deletions}`
  if (!paths.length) {
    // A real merge has an empty diff; a row from data written before `churned`
    // existed has files but no names. Only the first may be called a merge.
    if (!f.total) {
      return { kind: 'merge', title: 'Merge commit', summary: 'Merge into main with no changes against its first parent.' }
    }
    return { kind: 'other', title: 'Non-source files updated', summary: `Only non-source files changed (${f.total} file${f.total === 1 ? '' : 's'}, ${stats}).` }
  }
  const names = [...new Set(paths.map(p => p.split('/').pop()))]
  const shown = names.slice(0, 3).map(p => '`' + p + '`').join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '')
  const isLock = p => /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p) || p === '.bun-version'
  const isAsset = p => /\.svg$/.test(p) || /icons?\//.test(p)
  if (paths.every(isLock)) {
    return { kind: 'lockfile', title: 'Dependency lockfile updated', summary: `Only ${shown} changed (${stats}): resolved dependency versions, no source or model-catalog edits.` }
  }
  if (paths.every(isAsset)) {
    return { kind: 'assets', title: 'Icon and image assets updated', summary: `Only image assets changed (${shown}, ${stats}): no source edits.` }
  }
  return { kind: 'other', title: 'Non-source files updated', summary: `No source files changed (${shown}, ${stats}).` }
}

// Test-only commits: real work landed, but no shipped code moved. These rows
// need their own wording because files.added/modified are built from the
// *source* file list, which is empty for them by construction.
export function testLabel (e) {
  const paths = e.files.tests?.length
    ? e.files.tests
    : [...(e.files.added || []), ...(e.files.modified || []), ...(e.files.removed || [])]
  const names = [...new Set(paths.map(p => p.split('/').pop().replace(/\.(test|spec)\.[jt]sx?$/, '')))]
  const shown = names.slice(0, 3).map(p => '`' + p + '`').join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '')
  const stats = `+${e.stats.additions}/−${e.stats.deletions}`
  return {
    title: names.length ? `Test coverage: ${names[0]}` : 'Test suite updated',
    summary: names.length
      ? `Tests only (${shown}, ${stats}): the suite moved, no shipped code edits.`
      : `Tests only (${e.files.total} file(s), ${stats}): the suite moved, no shipped code edits.`
  }
}

function listPhrase (arr) {
  arr = arr.slice(0, 5)
  return arr.length === 1 ? arr[0] : arr.slice(0, -1).join(', ') + ' and ' + arr.at(-1)
}

export function entryTitle (e) {
  if (e.kind === 'community') return e.messageTitle
  if (e.modelChanges) {
    const { added = [], removed = [] } = e.modelChanges
    if (added.length && removed.length) return `${added[0]} replaces ${removed[0]} in the free model lineup`
    if (added.length) return `New model: ${added[0]}`
    if (removed.length) return `${removed[0]} retired from the lineup`
  }
  if (e.version) return `Version ${e.version}`
  if (e.cmdChanges?.added?.length) return `New slash command ${e.cmdChanges.added[0]}`
  const area = e.areas.filter(a => a !== 'Repo')[0]
  if (e.files.added.length && e.files.added.length >= e.files.meaningful) return `New ${area ? area.toLowerCase() + ' ' : ''}files landed`
  if (e.files.removed.length && !e.files.added.length) return `${area || 'Code'} cleanup${e.files.removed.length ? ': ' + shortBaseName(e.files.removed[0]) + (e.files.removed.length > 1 ? ` and ${e.files.removed.length - 1} more` : '') : ''}`
  const first = e.files.modified[0]
  if (first) return `${area || 'Project'} update: ${shortBaseName(first)}`
  return `${area || 'Project'} update`
}

function shortBaseName (p) {
  const b = p.split('/').pop()
  return b.replace(/\.(test|spec)\.[jt]sx?$/, '').replace(/\.(ts|tsx|js|jsx|json|md)$/, '')
}

// ---------------------------------------------------------------------------
// 6. Community (non-sync) commits
// ---------------------------------------------------------------------------

export async function analyzeCommunityCommit (repoDir, commit, prevSha, repoMeta) {
  let files = [], stats = { additions: 0, deletions: 0 }
  if (prevSha) {
    files = await diffNameStatus(repoDir, prevSha, commit.sha)
    stats = await diffNumstat(repoDir, prevSha, commit.sha)
  }
  const meaningful = files.filter(f => !isNoiseFile(f.path))
  const sourceMeaningful = meaningful.filter(f => !TEST_RE.test(f.path))
  const testOnly = meaningful.length > 0 && sourceMeaningful.length === 0
  const areas = [...new Set(meaningful.map(f => areaOf(f.path)))].filter(a => a !== 'Repo')
  const churnedPaths = files.filter(f => isNoiseFile(f.path)).map(f => f.path)
  const testPaths = meaningful.filter(f => TEST_RE.test(f.path)).map(f => f.path)
  const prMatch = /\(#(\d+)\)/.exec(commit.subject)
  const verMatch = /[Bb]ump (?:\w+ )*version(?: to)? (\d+\.\d+\.\d+)/.exec(commit.subject)
  const entry = {
    kind: 'community',
    sha: commit.sha,
    url: `${repoMeta.repoUrl}/commit/${commit.sha}`,
    date: commit.date,
    author: commit.author,
    pr: prMatch ? Number(prMatch[1]) : null,
    prUrl: prMatch ? `${repoMeta.repoUrl}/pull/${prMatch[1]}` : null,
    messageTitle: commit.subject,
    version: verMatch ? verMatch[1] : null,
    areas: areas.length ? areas : ['Repo'],
    modelChanges: null,
    cmdChanges: null,
    files: {
      total: files.length,
      meaningful: sourceMeaningful.length,
      rawMeaningful: meaningful.length,
      testOnly,
      churned: churnedPaths.slice(0, 12),
      tests: testPaths.slice(0, 12),
      added: sourceMeaningful.filter(f => f.status === 'added').map(f => f.path).slice(0, 12),
      removed: sourceMeaningful.filter(f => f.status === 'removed').map(f => f.path).slice(0, 12),
      renamed: [],
      modified: sourceMeaningful.filter(f => f.status === 'modified').map(f => f.path).slice(0, 16)
    },
    stats,
    facts: []
  }
  entry.summary = commit.subject
  entry.title = entryTitle(entry)
  entry.tags = tagsFor(entry)
  return entry
}
// The unstripped diff. extractCleanDiff drops lockfiles on purpose -- but for a
// commit whose only change IS bun.lock that leaves nothing, and the stored file
// behind "View inline diff" would be empty. Churn rows get this form instead.
// Git's empty tree object. A root commit has no parent to diff from, so the
// base is "nothing at all" -- which is exactly what this hash names.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// The unstripped diff. extractCleanDiff drops lockfiles on purpose -- but for a
// commit whose only change IS bun.lock that leaves nothing, and the stored file
// behind "View inline diff" would be empty. Churn rows get this form instead.
// The unstripped diff. extractCleanDiff drops lockfiles on purpose -- but for a
// commit whose only change IS bun.lock that leaves nothing, and the stored file
// behind "View inline diff" would be empty. Churn rows get this form instead.
export async function extractRawDiff (repoDir, base, head, maxBytes = 48000) {
  const range = base === EMPTY_TREE ? [EMPTY_TREE, head] : [`${base}...${head}`]
  return diffText(repoDir, range, ['.'], maxBytes)
}
