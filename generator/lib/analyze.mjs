// generator/lib/analyze.mjs — turns freebuff git history into changelog entries.
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
import { git, US, RS } from './util.mjs'

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
      date: date.trim(),
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

// ---------------------------------------------------------------------------
// 3. Semantic extractors
// ---------------------------------------------------------------------------

// Model catalog rows look like:
//   | **GPT-5.6 Luna** | Full access | Strong all-around with native images |
const MODEL_ROW_RE = /^\|\s*\*\*(.+?)\*\*\s*\|/

export function extractModelTableChanges (patch) {
  const added = [], removed = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const m = MODEL_ROW_RE.exec(line.slice(1))
      if (m) added.push(m[1].trim())
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const m = MODEL_ROW_RE.exec(line.slice(1))
      if (m) removed.push(m[1].trim())
    }
  }
  return { added, removed }
}

// Pricing lines like `input: 0.25, output: 1` etc. in constants files.
export function extractVersionBump (patch) {
  const adds = [...patch.matchAll(/^\+\s*"version":\s*"([\d.]+)"/gm)].map(x => x[1])
  return adds.length ? adds[adds.length - 1] : null
}

// Slash-commands registry: cli/src/constants/commands.ts or similar.
export function extractSlashCommandChanges (patch) {
  const added = [...patch.matchAll(/^\+\s*name:\s*'([/a-z0-9-]+)'/gm)].map(x => x[1])
  const removed = [...patch.matchAll(/^-\s*name:\s*'([/a-z0-9-]+)'/gm)].map(x => x[1])
  return {
    added: added.filter(c => c.startsWith('/')),
    removed: removed.filter(c => c.startsWith('/'))
  }
}

const AREA_MAP = [
  [/^cli\//, 'CLI'],
  [/^common\//, 'Shared/Core'],
  [/^packages\/agent-runtime\//, 'Agent Runtime'],
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
    p === 'bun.lock' || p === 'package-lock.json' || p === 'yarn.lock' ||
    /^snapcraft\/icons\//.test(p) ||
    /\.svg$/.test(p) ||
    p === '.bun-version'
  )
}

const TEST_RE = /(^|\/)(__tests__|tests?)\/|\.test\.tsx?$/

// ---------------------------------------------------------------------------
// 4. Entry builder for one sync commit
// ---------------------------------------------------------------------------

export async function analyzeSyncCommit (repoDir, commit, prevSha, repoMeta) {
  const files = await diffNameStatus(repoDir, prevSha, commit.sha)
  const { additions, deletions } = await diffNumstat(repoDir, prevSha, commit.sha)
  const meaningful = files.filter(f => !isNoiseFile(f.path))
  const areas = [...new Set(meaningful.map(f => areaOf(f.path)))].filter(a => a !== 'Repo')

  const facts = []
  const patchTargets = pickPatchTargets(meaningful)

  let modelChanges = null
  let version = null
  let cmdChanges = null
  if (patchTargets.length) {
    const patch = await diffPatch(repoDir, prevSha, commit.sha, patchTargets)
    const readmePatch = patchForFile(patch, 'README.md')
    if (readmePatch) {
      const mc = extractModelTableChanges(readmePatch)
      if (mc.added.length || mc.removed.length) modelChanges = mc
    }
    const pkgPatch = patchForFile(patch, 'cli/release/package.json')
    if (pkgPatch) version = extractVersionBump(pkgPatch) || version
    if (/(commands|slash)/i.test(patchTargets.join(' '))) {
      const cc = extractSlashCommandChanges(patch)
      if (cc.added.length || cc.removed.length) cmdChanges = cc
    }
    facts.push(...extractCommentFacts(patch))
  }

  const added = meaningful.filter(f => f.status === 'added' && !TEST_RE.test(f.path)).map(f => f.path)
  const removed = meaningful.filter(f => f.status === 'removed' && !TEST_RE.test(f.path)).map(f => f.path)
  const renamed = meaningful.filter(f => f.status === 'renamed')
  const modified = meaningful.filter(f => f.status === 'modified')

  const entry = {
    kind: 'sync',
    sha: commit.sha,
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
      meaningful: meaningful.length,
      added: added.slice(0, 12),
      removed: removed.slice(0, 12),
      renamed: renamed.slice(0, 8).map(r => ({ from: r.from, to: r.path })),
      modified: modified.slice(0, 16).map(m => m.path)
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
    if (p === 'README.md') return 10
    if (/package\.json$/.test(p)) return 9
    if (/commands?\.(ts|tsx|js)$/.test(p) || /slash/i.test(p)) return 8
    if (/constants?\//.test(p)) return 7
    if (/\.md$/.test(p)) return 5
    if (/\.tsx?$/.test(p) && !TEST_RE.test(p)) return 3
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
// Consecutive added/removed comment lines are joined into paragraphs; only
// mostly-prose, sentence-terminated paragraphs survive (kills identifier junk).
function extractCommentFacts (patch) {
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
  return b.replace(/\.(ts|tsx|js|json|md)$/, '')
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
  const areas = [...new Set(meaningful.map(f => areaOf(f.path)))].filter(a => a !== 'Repo')
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
      total: files.length, meaningful: meaningful.length,
      added: meaningful.filter(f => f.status === 'added').map(f => f.path).slice(0, 12),
      removed: meaningful.filter(f => f.status === 'removed').map(f => f.path).slice(0, 12),
      renamed: [], modified: meaningful.filter(f => f.status === 'modified').map(f => f.path).slice(0, 16)
    },
    stats,
    facts: []
  }
  entry.summary = commit.subject
  entry.title = entryTitle(entry)
  entry.tags = tagsFor(entry)
  return entry
}

// Filter: skip commits whose meaningful content is nil.
export function skipEntry (e) {
  if (e.kind === 'sync') {
    if (e.files.meaningful === 0 && !e.modelChanges && !e.version) return true
    if (e.files.total > 60 && e.files.meaningful <= 4 && !e.modelChanges && !e.version) return false
    return false
  }
  return false
}
