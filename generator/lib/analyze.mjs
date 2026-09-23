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
async function diffText (repoDir, range, pathspecs, maxBytes, contextLines = 25) {
  const tmp = `${tmpdir()}/fb-diff-${randomBytes(8).toString('hex')}.patch`
  try {
    const ok = await git(['diff', '--no-color', `-U${contextLines}`, ...range, `--output=${tmp}`, '--', ...pathspecs], repoDir, { allowFail: true })
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
export async function extractCleanDiff (repoDir, base, head, maxBytes = 250000, excludeTests = false, contextLines = 25) {
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
  return diffText(repoDir, range, pathspecs, maxBytes, contextLines)
}

// `git show <ref>:<path>`, memoized per process. The summary pass and the ELI5
// pass read the same files for the same entry minutes apart, and the header,
// outline and README extractors each re-read them; one read per (ref, path)
// is enough. Bounded so a long backfill cannot grow it without limit.
const SHOW_CACHE = new Map()
const SHOW_CACHE_MAX = 3000

export async function showCached (repoDir, ref, path) {
  const key = `${repoDir}\0${ref}\0${path}`
  if (SHOW_CACHE.has(key)) return SHOW_CACHE.get(key)
  const out = (await git(['show', `${ref}:${path}`], repoDir, { allowFail: true })) || ''
  if (SHOW_CACHE.size >= SHOW_CACHE_MAX) SHOW_CACHE.delete(SHOW_CACHE.keys().next().value)
  SHOW_CACHE.set(key, out)
  return out
}

export function clearShowCache () { SHOW_CACHE.clear() }

/**
 * Extract leading module-level documentation comments or headers from touched files.
 * Provides ground-truth architectural purpose directly to the LLM to prevent hallucinations.
 */
export async function extractFileHeaders (repoDir, ref, files, maxFiles = 6, maxLinesPerFile = 40) {
  if (!repoDir || !ref || !files || !files.length) return []
  const targets = files
    .map(f => (typeof f === 'string' ? f : f?.path || ''))
    .filter(p => p && /\.(?:ts|tsx|js|mjs|cjs|py|go|rs|md)$/i.test(p) && !/(?:test|spec|__tests__)/i.test(p))
    .slice(0, maxFiles)

  const headers = []
  for (const path of targets) {
    try {
      const content = await showCached(repoDir, ref, path)
      if (!content) continue
      const lines = content.split('\n').slice(0, maxLinesPerFile)
      if (/\.md$/i.test(path)) {
        const mdSnippet = lines.slice(0, 25).join('\n').trim()
        if (mdSnippet) headers.push({ path, header: mdSnippet })
        continue
      }
      const commentLines = []
      let inBlock = false
      let seenComment = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        if (i === 0 && trimmed.startsWith('#!')) continue
        if (!inBlock && (trimmed.startsWith('/**') || trimmed.startsWith('/*'))) {
          inBlock = true
          seenComment = true
          commentLines.push(line)
          if (trimmed.endsWith('*/') && trimmed.length > 2) inBlock = false
        } else if (inBlock) {
          commentLines.push(line)
          if (trimmed.endsWith('*/')) {
            inBlock = false
            break
          }
        } else if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
          seenComment = true
          commentLines.push(line)
        } else if (trimmed === '') {
          if (seenComment) commentLines.push(line)
        } else if (!seenComment && (trimmed.startsWith('import ') || trimmed.startsWith('} from ') || trimmed.startsWith('export *') || /^const .+ = require\(/.test(trimmed))) {
          // Allow leading imports before top comment block
          continue
        } else {
          break
        }
      }
      const headerText = commentLines.join('\n').trim()
      if (headerText) {
        headers.push({ path, header: headerText })
      }
    } catch {
      // ignore individual git read errors (e.g. deleted files or binary)
    }
  }
  return headers
}

/**
 * Longitudinal commit lineage: finds up to `maxEntries` previous commits that modified
 * any of the same files as `targetEntry`, establishing how the subsystem evolved.
 */
export function findFileHistory (entries, targetEntry, maxEntries = 10) {
  if (!entries || !targetEntry) return []
  const targetFiles = new Set(
    [...(targetEntry.files?.modified || []), ...(targetEntry.files?.added || [])]
      .filter(f => f && !/(?:test|spec|__tests__)/i.test(f) && !/(?:bun\.lock|package-lock|yarn\.lock)/i.test(f))
  )
  if (!targetFiles.size) return []

  const targetIdx = entries.findIndex(e => e.sha === targetEntry.sha)
  let pool = []
  if (targetIdx !== -1) {
    const isOldestFirst = entries.length < 2 || String(entries[0].date || '') <= String(entries[entries.length - 1].date || '')
    if (isOldestFirst) {
      pool = entries.slice(0, targetIdx).reverse()
    } else {
      pool = entries.slice(targetIdx + 1)
    }
  } else {
    pool = [...entries]
      .filter(e => e.sha !== targetEntry.sha && (!targetEntry.date || e.date <= targetEntry.date))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }

  const history = []
  for (const prev of pool) {
    if (history.length >= maxEntries) break
    if (prev.noise) continue
    const prevFiles = [...(prev.files?.modified || []), ...(prev.files?.added || []), ...(prev.files?.removed || [])]
    const overlap = prevFiles.filter(f => targetFiles.has(f))
    if (overlap.length > 0) {
      history.push({
        sha: prev.sha.slice(0, 8),
        date: prev.day || (prev.date ? prev.date.slice(0, 10) : ''),
        overlap,
        title: prev.ai?.title || prev.title || '',
        summary: prev.ai?.summary || prev.summary || ''
      })
    }
  }
  return history
}

/**
 * For small/focused modules (<= 250 lines), injects the complete source file.
 * For larger modules (> 250 lines), extracts the public exported interface outline.
 */
export async function extractFullOrOutlinedFiles (repoDir, ref, files, maxLines = 250, maxFiles = 4) {
  if (!repoDir || !ref || !files || !files.length) return { fullFiles: [], exportOutlines: [] }
  const targets = files
    .map(f => (typeof f === 'string' ? f : f?.path || ''))
    .filter(p => p && /\.(?:ts|tsx|js|mjs|cjs|py|go|rs|md)$/i.test(p) && !/(?:test|spec|__tests__)/i.test(p))
    .slice(0, maxFiles)

  const fullFiles = []
  const exportOutlines = []

  for (const path of targets) {
    try {
      const content = await showCached(repoDir, ref, path)
      if (!content) continue
      const lines = content.split('\n')
      if (lines.length <= maxLines) {
        fullFiles.push({ path, content: content.trim(), lines: lines.length })
      } else {
        const exports = lines
          .filter(l => /^\s*export\s+(const|function|type|interface|class|enum|let|var|async\s+function|default)\s+/.test(l))
          .slice(0, 30)
        if (exports.length) {
          exportOutlines.push({ path, outline: exports.join('\n').trim(), totalLines: lines.length })
        }
      }
    } catch {
      // ignore individual git read errors
    }
  }
  return { fullFiles, exportOutlines }
}

/**
 * Finds the nearest parent directory README or architecture guide for touched files.
 */
export async function extractSubsystemDocs (repoDir, ref, files, maxDocs = 2) {
  if (!repoDir || !ref || !files || !files.length) return []
  const targets = files
    .map(f => (typeof f === 'string' ? f : f?.path || ''))
    .filter(p => p && !/(?:test|spec|__tests__)/i.test(p))

  const seenPaths = new Set()
  const docs = []

  for (const file of targets) {
    if (docs.length >= maxDocs) break
    const parts = file.split('/')
    while (parts.length > 1 && docs.length < maxDocs) {
      parts.pop()
      const candidate = parts.join('/') + '/README.md'
      if (seenPaths.has(candidate)) break
      seenPaths.add(candidate)
      try {
        const content = await showCached(repoDir, ref, candidate)
        if (content) {
          const overview = content.split('\n').slice(0, 35).join('\n').trim()
          docs.push({ path: candidate, content: overview })
          break
        }
      } catch {
        // continue climbing
      }
    }
  }
  return docs
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

// The two package files whose bumps mark a shippable build. `cli/release/`
// feeds the 1.0.x line (e.version, release pages); `freebuff/cli/release/`
// feeds the 0.0.x line (e.freebuffVersion, ELI5 roll-up only, no release page
// per product decision). Track identity is what lets a release-window walk
// stop at the previous bump of the *same* line instead of the nearest bump of
// either line -- the two interleave constantly.
export const VERSION_TRACKS = {
  'cli/release/package.json': 'codebuff-cli',
  'freebuff/cli/release/package.json': 'freebuff-cli'
}

// Old rows predate versionTrack, so windows must also infer it from the file
// lists below. That inference is conservative on purpose: an unknown track
// means "same line as whoever asks", never "stop here".
export function versionTrackOf (e) {
  if (e && typeof e.versionTrack === 'string' && e.versionTrack) return e.versionTrack
  return null
}

export function isBumpEntry (e) {
  if (!e) return false
  if (versionTrackOf(e) || e.version || e.freebuffVersion) return true
  // Legacy rows predate versionTrack AND freebuffVersion (the 0.0.x line was
  // never extracted): a versionless row whose only meaningful file is a
  // release manifest is a bump by shape. meaningful<=1 keeps mixed rows
  // (manifest riding along with real work, e.g. a4b3d0fa mean=3) out of the
  // boundary set -- they are window *content*, not its edge.
  // NOTE: stats.additions counts the whole snapshot including lockfile churn
  // (1.0.688 itself is +47/-55), so shape comes from the file lists only.
  const mods = [...(e.files?.added || []), ...(e.files?.modified || [])]
  if ((e.files?.meaningful ?? 99) > 1) return false
  return mods.length === 1 && (mods[0] in VERSION_TRACKS)
}

export const TEST_RE = /(^|\/)(__tests__|tests?|fixtures?|mocks?)\/|\.(test|spec)\.[jt]sx?$/

// Deterministic weight, with the reason it was given. The reason travels to the
// badge tooltip so a reader (and the LLM, which may override the weight) can see
// what the rule saw. A bump-only row is `notable`, not `major`: the label moved,
// and the release page carries the story; `major` is for a model, a command, or
// a bump that also ships code.
export const LARGE_CHANGE_LINES = 400

export function significanceOf (e) {
  const f = e?.files || {}
  const lines = (e?.stats?.additions || 0) + (e?.stats?.deletions || 0)
  if (e?.modelChanges) return { significance: 'major', reason: 'model catalog changed' }
  const bump = !!(e?.version || e?.freebuffVersion)
  const bumpOnlyShape = bump && (f.meaningful ?? 99) <= 1 && !(f.added || []).length && !(f.removed || []).length
  if (bump && !bumpOnlyShape) return { significance: 'major', reason: 'version bump shipping code' }
  if (e?.cmdChanges) return { significance: 'notable', reason: 'slash commands changed' }
  if (bumpOnlyShape) return { significance: 'notable', reason: 'version bump' }
  if ((f.added || []).length) return { significance: 'notable', reason: 'new files' }
  if ((f.removed || []).length) return { significance: 'notable', reason: 'files removed' }
  if (lines > LARGE_CHANGE_LINES) return { significance: 'notable', reason: `large change (${lines} lines)` }
  return { significance: 'minor', reason: 'edits to existing files' }
}

export function commitNatureOf (e) {
  if (!e) return 'production'
  if (e.testOnly || e.files?.testOnly) return 'test-only'
  if (e.noise || e.churn) return 'churn'
  if (isBumpEntry(e)) return 'release-bump'
  const files = e.files
  if (files) {
    const active = [
      ...(files.added || []),
      ...(files.modified || []),
      ...(files.removed || []),
      ...(files.renamed ? files.renamed.map(r => r.to || r.path) : [])
    ]
    if (active.length > 0) {
      if (active.every(p => TEST_RE.test(p))) return 'test-only'
      if (active.every(p => p.startsWith('docs/') || p.endsWith('.md'))) return 'docs-only'
      if (active.every(p => p.endsWith('.json') || p.endsWith('.yaml') || p.endsWith('.yml') || p.endsWith('.toml'))) return 'config-only'
    }
  }
  return 'production'
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

export const MONOREPO_COMPONENTS = [
  {
    prefix: 'cli/',
    pattern: /^cli\//,
    area: 'CLI',
    desc: 'Command-line interface, terminal UI, keyboard shortcuts, slash commands (/ask, /undo, /diff, /byok), terminal rendering, settings.'
  },
  {
    prefix: 'packages/agent-runtime/',
    pattern: /^packages\/agent-runtime\//,
    area: 'Agent Runtime',
    desc: 'Core autonomous agent loop, tool execution engine, subagent orchestration, tool runner, execution planning.'
  },
  {
    prefix: 'packages/code-map/',
    pattern: /^packages\/code-map\//,
    area: 'Code Map',
    desc: 'Code structure intelligence, AST parsing via Tree-Sitter, syntax tree symbol extraction.'
  },
  {
    prefix: 'packages/llm-providers/',
    pattern: /^packages\/llm-providers\//,
    area: 'LLM Providers',
    desc: 'Model provider adapters, OpenAI-compatible streaming endpoints, protocol translation.'
  },
  {
    prefix: 'common/',
    pattern: /^common\//,
    area: 'Shared/Core',
    desc: 'Core types, model catalog definitions, free model picker configurations, shared protocols, telemetry, auth, advertising marketplace, and first-party sponsored ad placement campaigns.'
  },
  {
    prefix: 'sdk/',
    pattern: /^sdk\//,
    area: 'SDK',
    desc: 'Public SDK client library, developer extension points, programmatic access to Freebuff.'
  },
  {
    prefix: 'agents/',
    pattern: /^agents\//,
    area: 'Agents',
    desc: 'Built-in agent definitions, prompt templates, system instructions.'
  },
  {
    prefix: 'freebuff/',
    pattern: /^freebuff\//,
    area: 'Packaging',
    desc: 'Package manifests, release packaging, binary distribution configs.'
  },
  {
    prefix: 'evals/',
    pattern: /^evals\//,
    area: 'Evals',
    desc: 'Agent evaluation benchmarks, test harnesses, accuracy scoring.'
  },
  {
    prefix: 'docs/',
    pattern: /^docs\//,
    area: 'Docs',
    desc: 'Documentation, setup guides, protocol specifications.'
  },
  {
    prefix: 'scripts/',
    pattern: /^scripts\//,
    area: 'Tooling',
    desc: 'Internal build scripts, local development helpers, dev environment automation.'
  },
  {
    prefix: '.github/',
    pattern: /^\.github\//,
    area: 'CI',
    desc: 'GitHub Actions workflows, automated CI/CD checks, PR hygiene automation.'
  },
  {
    prefix: 'assets/',
    pattern: /^assets\//,
    area: 'Assets',
    desc: 'Static branding assets, images, icons.'
  }
]

export const AREA_MAP = [
  ...MONOREPO_COMPONENTS.map(c => [c.pattern, c.area]),
  [/^packages\//, 'Packages']
]

export function areaOf (path) {
  for (const [re, name] of AREA_MAP) if (re.test(path)) return name
  return 'Repo'
}

export function formatArchitectureMap (components = MONOREPO_COMPONENTS) {
  const lines = [
    'Freebuff Monorepo Architecture Context:',
    ...components.map(c => `- \`${c.prefix}\`: ${c.desc}`)
  ]
  return lines.join('\n')
}

// Glossary candidates from the upstream docs: every `## Heading` in docs/**.md
// and the package READMEs, with the first sentence beneath it as a hint. The
// result seeds data/glossary.json; a human fills in or deletes definitions, and
// only filled definitions are ever injected into a prompt.
export async function discoverGlossary (repoDir, ref = 'origin/main', { maxTerms = 80 } = {}) {
  const out = {}
  if (!repoDir) return out
  const list = await git(['ls-tree', '-r', '--name-only', ref], repoDir, { allowFail: true })
  if (!list) return out
  const docs = list.split('\n').map(s => s.trim()).filter(p => /^docs\/.*\.md$|^(?:cli|sdk|common|web|agents|freebuff)\/README\.md$/i.test(p)).slice(0, 60)
  for (const path of docs) {
    const text = await showCached(repoDir, ref, path)
    if (!text) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = /^##\s+([A-Z][\w .'/&-]{2,40})\s*$/.exec(lines[i])
      if (!m) continue
      const term = m[1].trim()
      if (/^(?:overview|introduction|usage|installation|getting started|examples?|notes?|see also|license|contributing|faq|table of contents|prerequisites|development|testing|configuration|architecture)$/i.test(term)) continue
      if (out[term] !== undefined) continue
      let hint = ''
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const t = lines[j].trim()
        if (!t || t.startsWith('#') || t.startsWith('|') || t.startsWith('```') || t.startsWith('-') || t.startsWith('*')) continue
        const first = /^[^.!?]+[.!?]/.exec(t.replace(/[`*_]/g, ''))
        hint = (first ? first[0] : t.replace(/[`*_]/g, '')).slice(0, 160)
        break
      }
      out[term] = hint
      if (Object.keys(out).length >= maxTerms) return out
    }
  }
  return out
}

export async function discoverMonorepoArchitecture (repoDir, ref = 'origin/main') {
  if (!repoDir) return [...MONOREPO_COMPONENTS]
  try {
    const rootTree = await git(['ls-tree', '-d', '--name-only', ref], repoDir, { allowFail: true })
    if (!rootTree) return [...MONOREPO_COMPONENTS]
    const rootNames = rootTree.split('\n').map(s => s.trim()).filter(Boolean)

    let pkgNames = []
    if (rootNames.includes('packages')) {
      const pkgsTree = await git(['ls-tree', '-d', '--name-only', `${ref}:packages`], repoDir, { allowFail: true })
      if (pkgsTree) {
        pkgNames = pkgsTree.split('\n').map(s => s.trim()).filter(Boolean).map(p => `packages/${p}`)
      }
    }

    const allPaths = [...rootNames.filter(r => r !== 'packages'), ...pkgNames]
    const unmapped = []

    for (const p of allPaths) {
      if (p.includes('.') && !p.startsWith('.github')) continue
      const pathWithSlash = p.endsWith('/') ? p : `${p}/`
      const isMapped = MONOREPO_COMPONENTS.some(c => c.prefix === pathWithSlash || c.pattern.test(pathWithSlash))
      if (!isMapped) {
        let desc = ''
        try {
          const pkgJson = await git(['show', `${ref}:${p}/package.json`], repoDir, { allowFail: true })
          if (pkgJson) {
            const parsed = JSON.parse(pkgJson)
            desc = parsed.description || parsed.name || ''
          }
        } catch { /* not a node package or unreadable */ }

        const areaName = p.replace(/^packages\//, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        unmapped.push({
          prefix: pathWithSlash,
          pattern: new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
          area: areaName,
          desc: desc || `Monorepo subsystem ${p}/`
        })
      }
    }
    return [...MONOREPO_COMPONENTS, ...unmapped]
  } catch {
    return [...MONOREPO_COMPONENTS]
  }
}

export function isNoiseFile (p) {
  return (
    /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p) ||
    p === '.bun-version' ||
    /^snapcraft\/icons\//.test(p) ||
    /\.svg$/.test(p)
  )
}

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
  let entryStructured = null

  let modelChanges = null
  let version = null
  let freebuffVersion = null
  let versionTrack = null
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
    for (const [pkgPath, track] of Object.entries(VERSION_TRACKS)) {
      const pkgPatch = patchForFile(patch, pkgPath)
      const bumped = pkgPatch ? extractVersionBump(pkgPatch) : null
      if (!bumped) continue
      if (track === 'codebuff-cli') version = bumped
      else freebuffVersion = bumped
      // First bump wins when a snapshot touches both manifests: the row is one
      // release of one line, and the codebuff-cli page owns the combined range.
      if (!versionTrack) versionTrack = track
    }
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
    const structured = await pruneKnownInputs(repoDir, prevSha, extractStructuredFacts(patch))
    if (hasStructuredFacts(structured)) entryStructured = structured
  }

  // Consistent source file lists (tests excluded so headlines and chips match real code)
  const added = sourceMeaningful.filter(f => f.status === 'added').map(f => f.path)
  const removed = sourceMeaningful.filter(f => f.status === 'removed').map(f => f.path)
  const renamed = sourceMeaningful.filter(f => f.status === 'renamed')
  const modified = sourceMeaningful.filter(f => f.status === 'modified').map(f => f.path)

  const cleanBody = (commit.body || '')
    .replace(/^Source:\s*[\w./-]+@[0-9a-f]{40}\s*$/m, '')
    .trim()

  const entry = {
    kind: 'sync',
    sha: commit.sha,
    prevSha,
    url: `${repoMeta.repoUrl}/commit/${commit.sha}`,
    compareUrl: `${repoMeta.compareUrl}/${prevSha.slice(0, 12)}...${commit.sha.slice(0, 12)}`,
    date: commit.date,
    sourceSha: sourceRef(commit),
    ...(cleanBody ? { messageBody: cleanBody } : {}),
    ...(entryStructured ? { structured: entryStructured } : {}),
    version,
    ...(freebuffVersion ? { freebuffVersion } : {}),
    ...(versionTrack ? { versionTrack } : {}),
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
  entry.commitNature = commitNatureOf(entry)
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
// Added comments take precedence, supplemented by surrounding context comments.
export function extractCommentFacts (patch) {
  const addedFacts = []
  const contextFacts = []
  let buf = []
  let isAddedBlock = false
  // Docs prose is not a code comment. In a .md diff a markdown bullet (`*
  // Staff accounts only.`) and a heading (`# Guide`) match the comment markers
  // below and were fed to the model as "comments the developers wrote beside
  // this code" -- misattributing documentation as developer intent. Doc files
  // contribute nothing here; their text is already in the diff itself.
  let isDocFile = false

  const flush = () => {
    if (!buf.length) return
    let text = buf.join(' ').replace(/\s+/g, ' ').trim()
    const target = isAddedBlock ? addedFacts : contextFacts
    buf = []
    isAddedBlock = false
    // JSDoc tags carry the audience and the units ("@param limit Daily cap in
    // cents for advertisers"): keep them as "name: description".
    const tag = /^@(param|returns?|throws|default|deprecated|since)\s+(?:\{[^}]*\}\s*)?(?:(\w+)\s+)?[-:]?\s*(.*)$/.exec(text)
    if (tag) text = `${tag[1] === 'param' && tag[2] ? tag[2] : tag[1]}: ${tag[3] || tag[2] || ''}`.trim()
    // 20, not 35: "Staff accounts only." is 20 characters and exactly the kind
    // of sentence this exists to keep. 92% of rows carried no fact at 35.
    if (text.length < 20 || text.length > 300) return
    if (!/^[A-Z"'\[(@-]|^[a-z]+: /.test(text)) return // drop mid-sentence continuations
    text = text.replace(/^(TODO|FIXME|NOTE|WHY|HOW)\s*:?\s*/i, '')
    const lower = (text.match(/[a-z]/g) || []).length
    if (lower < text.length * 0.5) return
    if ((text.split(/\s+/).filter(w => /[a-z]{3,}/i.test(w)).length) < 3) return
    if (!/[.!?]$/.test(text) && !tag) return
    if (/^(Removed|Added|Modified|See|See also)\b.*\b(docs|test|section)\b/i.test(text) && text.length < 80) return
    target.push(text)
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      isDocFile = DOC_FILE_RE.test(line.split(' b/').pop() || '')
      continue
    }
    if (isDocFile) continue
    const m = /^([+ -])\s*(?:\/\/|\/\*+|\*+|#(?!!))\s?(.*)$/.exec(line)
    if (!m) { flush(); continue }
    if (m[1] === '-') { flush(); continue }
    if (m[1] === '+') isAddedBlock = true
    const t = m[2].replace(/\*\/\s*$/, '').replace(/\/+$/, '').trim()
    if (!t) { flush(); continue }
    // A JSDoc tag starts its own fact even mid-block.
    if (/^@\w+/.test(t) && buf.length) flush()
    buf.push(t)
    if (buf.join(' ').length > 280) flush()
  }
  flush()
  return [...new Set([...addedFacts, ...contextFacts])].slice(0, 8)
}

// ---------------------------------------------------------------------------
// Structured facts: typed, deterministic, and copied into the prompt verbatim.
//
// The prompt asks the model to "describe only what literal value changed"; this
// hands it the literal values. Constants that changed value (old -> new), new
// env vars read, new CLI flags, exports added or removed, and the names of new
// tests -- which are the nearest thing to a behavior spec the diff contains and
// were previously stripped from the prompt along with the test hunks.
// Every item is also added to the grounding corpus and shown as a chip.

export const STRUCTURED_LIMITS = { constants: 12, constantsIntroduced: 8, envVars: 12, flags: 12, exportsAdded: 16, exportsRemoved: 16, testNames: 14 }

const CONST_LINE_RE = /^([+-])\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/
const ENV_RE = /process\.env\.([A-Z][A-Z0-9_]{2,})|env\(['"`]([A-Z][A-Z0-9_]{2,})['"`]\)|\benv\.([A-Z][A-Z0-9_]{2,})\b/g
// Only the opening quote is required: template literals and `--flag=...`
// values never close with a quote adjacent to the flag name.
const FLAG_RE = /['"`](--[a-z][a-z0-9-]{1,40})\b/g
const EXPORT_RE = /^([+-])\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/
const TEST_NAME_RE = /^\+\s*(?:it|test|describe)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])((?:(?!\1).){8,140})\1/

function trimValue (v) {
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

// A value that is only the opening of a multi-line literal (`[`, `{`, `new Map(`)
// is not a value; reporting `[ -> [] as const` misleads more than it informs.
function isOpenerValue (v) {
  return /^[[{(]$|[[{(,]$|^new \w+\($|=>\s*[{(]?$/.test(String(v).trim())
}

const DOC_FILE_RE = /\.(?:mdx?|txt|rst)$/i
// Flags on a line that invokes another program are that program's flags, not
// ours (`git(['rev-parse', '--verify', '--quiet'])`).
const SUBPROCESS_LINE_RE = /\b(?:git|spawn(?:Sync)?|exec(?:Sync|File|FileSync)?|execa|run|\$)\s*\(|\[\s*['"`](?:git|npm|bun|npx|pnpm|yarn|docker|node)['"`]/

export function extractStructuredFacts (patch) {
  const out = { constants: [], constantsIntroduced: [], envVars: [], flags: [], exportsAdded: [], exportsRemoved: [], testNames: [] }
  if (!patch) return out
  const removedConst = new Map()
  const addedConst = new Map()
  const removedExports = new Set()
  const addedExports = new Set()
  const envSeen = new Set()
  const envBefore = new Set()
  const flagSeen = new Set()
  const flagBefore = new Set()
  const tests = new Set()
  let inTestFile = false
  let inDocFile = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = line.split(' b/').pop() || ''
      inTestFile = TEST_RE.test(path)
      inDocFile = DOC_FILE_RE.test(path)
      continue
    }
    const sign = line[0]
    if (sign !== '+' && sign !== '-') continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    const c = CONST_LINE_RE.exec(line)
    if (c && !inTestFile && !inDocFile && !isOpenerValue(c[3])) (c[1] === '-' ? removedConst : addedConst).set(c[2], trimValue(c[3]))
    const x = EXPORT_RE.exec(line)
    if (x && !inTestFile && !inDocFile) (x[1] === '-' ? removedExports : addedExports).add(x[2])
    // Docs mentioning an existing variable or flag for the first time are not
    // introducing it; subprocess argument lists are another program's flags.
    if (!inTestFile && !inDocFile) {
      for (const m of line.matchAll(ENV_RE)) {
        const name = m[1] || m[2] || m[3]
        if (!name) continue
        if (sign === '+') envSeen.add(name); else envBefore.add(name)
      }
      if (!SUBPROCESS_LINE_RE.test(line)) {
        for (const m of line.matchAll(FLAG_RE)) {
          if (sign === '+') flagSeen.add(m[1]); else flagBefore.add(m[1])
        }
      }
    }
    if (sign === '+') {
      const t = TEST_NAME_RE.exec(line)
      if (t) tests.add(t[2].replace(/\s+/g, ' ').trim())
    }
  }
  for (const [name, to] of addedConst) {
    const from = removedConst.get(name)
    if (from != null && from !== to) out.constants.push({ name, from, to })
    // A brand-new CONSTANT_CASE definition is the other checkable half of
    // "describe only what literal value changed": the prompt previously only
    // received old -> new pairs, so a newly defined limit arrived with no
    // literal attached and the model free-associated one.
    else if (from == null) out.constantsIntroduced.push({ name, to })
  }
  // Reads that exist on the removed side too are moved code, not new inputs.
  out.envVars = [...envSeen].filter(n => !envBefore.has(n))
  out.flags = [...flagSeen].filter(f => !flagBefore.has(f))
  out.exportsAdded = [...addedExports].filter(n => !removedExports.has(n))
  out.exportsRemoved = [...removedExports].filter(n => !addedExports.has(n))
  out.testNames = [...tests]
  for (const k of Object.keys(STRUCTURED_LIMITS)) out[k] = out[k].slice(0, STRUCTURED_LIMITS[k])
  return out
}

export function hasStructuredFacts (s) {
  return !!s && Object.values(s).some(v => Array.isArray(v) && v.length)
}

// "Newly read" and "newly introduced" are diff-local claims: the before side
// of a patch only shows the hunks that moved, so an env var already read in
// forty untouched places looks brand new when its call site is relocated, and
// a renamed test title was always there in the file's older copy. Checking
// each candidate against the base tree settles it; `git grep` exits non-zero
// when the name is genuinely absent, and allowFail turns that (or a broken
// rev) into "not found", so a failed lookup keeps the claim rather than
// silently dropping a real fact. Bounded checks keep one enrich pass cheap.
export async function pruneKnownInputs (repoDir, base, structured, { maxChecks = 24 } = {}) {
  if (!repoDir || !base || !hasStructuredFacts(structured)) return structured
  let checks = maxChecks
  const knownAt = async (needle) => {
    if (checks-- <= 0) return false
    // `-e` names the pattern explicitly: a flag like `--old-flag` would
    // otherwise be parsed as another git option instead of the search term.
    const hit = await git(['grep', '-l', '-F', '-e', needle, base, '--'], repoDir, { allowFail: true })
    return hit != null && hit.trim() !== ''
  }
  const prune = async (list) => {
    const keep = []
    for (const item of list) if (!(await knownAt(item))) keep.push(item)
    return keep
  }
  const pruneNamed = async (list) => {
    const keep = []
    for (const item of list) if (!(await knownAt(item?.name || item))) keep.push(item)
    return keep
  }
  return {
    ...structured,
    // A "new" constant whose name already exists at the base rev is moved code
    // too. Value-changed pairs are never pruned: those names are old by
    // definition and the grep would eat every real change.
    constantsIntroduced: await pruneNamed(structured.constantsIntroduced || []),
    envVars: await prune(structured.envVars || []),
    flags: await prune(structured.flags || []),
    testNames: await prune(structured.testNames || [])
  }
}

// Prompt lines. Each list is labelled with what the model may conclude from it.
export function formatStructuredFacts (s) {
  if (!hasStructuredFacts(s)) return []
  const lines = ['Structured facts (extracted mechanically from the diff; copy names and values verbatim, never round or rename):']
  if (s.constants.length) lines.push(`- Constants whose value changed: ${s.constants.map(c => `${c.name}: ${c.from} -> ${c.to}`).join(' ; ')}`)
  if (s.constantsIntroduced?.length) lines.push(`- Constants newly defined: ${s.constantsIntroduced.map(c => `${c.name} = ${c.to}`).join(' ; ')} (a definition alone changes nothing at runtime; if the diff shows no reader, say it is in place and does nothing yet)`)
  if (s.envVars.length) lines.push(`- Environment variables newly read: ${s.envVars.join(', ')}`)
  if (s.flags.length) lines.push(`- Command-line flags newly introduced: ${s.flags.join(', ')}`)
  if (s.exportsAdded.length) lines.push(`- Exports added: ${s.exportsAdded.join(', ')}`)
  if (s.exportsRemoved.length) lines.push(`- Exports removed: ${s.exportsRemoved.join(', ')}`)
  if (s.testNames.length) lines.push(`- Behavior asserted by new tests (test titles, verbatim; the hunks themselves are omitted): ${s.testNames.map(t => `"${t}"`).join(' ; ')}`)
  return lines
}

// Text for the grounding corpus.
export function structuredFactsText (s) {
  if (!hasStructuredFacts(s)) return ''
  return [
    ...s.constants.flatMap(c => [c.name, c.from, c.to]),
    ...(s.constantsIntroduced || []).flatMap(c => [c.name, c.to]),
    ...s.envVars, ...s.flags, ...s.exportsAdded, ...s.exportsRemoved, ...s.testNames
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Diff ordering for the prompt budget. `git diff` emits files alphabetically,
// so a 90 KB `__snapshots__/x.snap` or a generated schema could crowd out the
// 3 KB `.ts` that is the change. Source first, then docs and config, then
// generated or test files, and within a tier smaller files first so the budget
// covers as many whole files as possible.

export function diffPartPriority (part) {
  const head = String(part).split('\n', 1)[0]
  const path = (head.split(' b/').pop() || '').trim()
  if (/(?:^|\/)__snapshots__\/|\.snap$|\.(?:lock|lockb|min\.js|map)$|(?:^|\/)(?:generated|gen|dist|build)\//i.test(path)) return 4
  if (TEST_RE.test(path)) return 3
  if (/\.(?:md|mdx|json|ya?ml|toml|txt|csv)$/i.test(path)) return 2
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|sql|css|scss|html|sh)$/i.test(path)) return 0
  return 1
}

export function prioritizeDiffParts (parts) {
  return parts
    .map((p, i) => ({ p, i, pri: diffPartPriority(p), len: p.length }))
    .sort((a, b) => a.pri - b.pri || a.len - b.len || a.i - b.i)
    .map(x => x.p)
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

// A cheap path-and-title test for the `security` tag on brand-new rows (the
// summary-aware version lives in llm.mjs: isSecurityEntry, used at build time).
export const SECURITY_HINT_RE = /\b(?:security|secur(?:e|ed|ing)|trust(?:ed|s)? (?:gate|boundary|floor|prompt|list|publisher|enforcement)|untrusted|checksums?\b|sha-?256|signature verif|tamper(?:ing)?|hijack(?:ing)?|steering (?:var|prefix|environment)|sandbox(?:ing)?|(?:process|sandbox|container|dotenv) isolation|credential (?:leak|leakage|theft|storage|permission|redaction|stripping|mode|file)|credentials?\.json|secret (?:leak|leakage|redaction|stripping|exposure|scanning)|token leak|permission(?:s)? (?:mode|bits|tighten)|0o?[67]00\b|owner-only|redirect (?:allowlist|gate)|(?:protocol|tls|ssl|crypto|cipher|version) downgrade|downgrade attack|https-to-http|csrf|xss|(?:prompt|command|sql|code|script|crlf|shell|template) injection|injection attack|exfiltrat(?:e|ion|ing)|ban sweep|anti-abuse|foreign[- ]client (?:detection|signals?|enforcement))\b/i

export function securityHint (e) {
  const paths = [...(e?.files?.added || []), ...(e?.files?.modified || [])]
  if (paths.length > 0 && paths.every(f => /^(?:common\/src\/ads\/|.*ad-provider.*|.*imprezia.*|.*paid-social.*|.*marketing.*)/.test(f))) return false
  const nonAdFiles = paths.filter(f => !/^(?:common\/src\/ads\/|docs\/|marketing\/|\.github\/)/.test(f))
  if (nonAdFiles.some(p => /(?:^|\/)(?:auth|security|trust|permissions?|credentials?|sandbox|agent-dir-trust|agent-publisher-trust|checksums?|write-binary-checksums|foreign-client-signals|runtime-app-url|disposable-email)[^/]*\.[a-z]+$/i.test(p))) return true
  return SECURITY_HINT_RE.test(`${e?.messageTitle || ''} ${e?.messageBody || ''}`)
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
  if (e.freebuffVersion) bits.push(`Freebuff CLI release ${e.freebuffVersion} published.`)
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
  if (e.freebuffVersion) return `Freebuff CLI ${e.freebuffVersion}`
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
    ...(commit.body?.trim() ? { messageBody: commit.body.trim() } : {}),
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
  entry.commitNature = commitNatureOf(entry)
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
