// generator/lib/story.mjs - conservative, same-day story context.
// Candidate links use specific paths or shared identifiers, not category alone.
// Explicit access-transition evidence supplies the headline; related ELI5 text
// supplies context. These are heuristics, not proof of a shared policy change.
// Recompute at render time so newly arrived entries require neither another API
// call nor cache invalidation. Never mutate per-commit summaries.
//
// One deliberate reach across the day boundary: a version bump usually lands
// the morning after the work it ships, so a bump row also joins the previous
// day's clustering. Links and notes always point at a member's own day.
import { isBumpEntry } from './analyze.mjs'

function previousDay (day) {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// Files whose *name* says nothing about which change this is. Two entries both
// editing a README are not one story, and pairing them would put a note on rows
// that have nothing to do with each other.
const GENERIC_BASENAMES = new Set([
  'readme', 'package', 'lock', 'licence', 'license', 'gitignore', 'dockerfile',
  'changelog', 'index', 'constants', 'types', 'utils', 'helpers', 'config',
  'test', 'tests', 'spec', 'setup', 'main', 'mod'
])

// Words that put a sentence in the access domain, and words that say it moved.
// Both are needed: this pair is the gate that keeps the feature off rows that
// merely mention a plan or a region.
const ACCESS_RE = /\b(full[-\s]?access|limited[-\s]?access|allow[-\s]?list|eligible|eligibility|grandfather(?:ed|ing)?|cut[-\s]?over|plan pools?|free tier|country tiers?|country list|blocked|approv(?:ed|al) countries)\b/i
// Deliberately no "now" and no "change"/"changed": "a single list now holds every
// country approved for full access ... does not change who is eligible today" is
// the *misleading* line this module exists to qualify, and a lexicon that reads
// it as a recorded change would suppress exactly the note that fixes it.
const MOVED_RE = /\b(lost|loses?|left|leaves?|leaving|gains?|gained|gets?|got|receiv(?:e|es|ed)|added|removed|no longer|switched?|moved|exits?|exited|keeps?|kept|retains?|retained|start(?:ed|s)?|stop(?:ped|s)?|reduced|restored|regained|extended|granted|opens?|opened|cut[-\s]?over|cutoff|cut-off)\b/i

// A bare CONSTANT_CASE identifier: the vocabulary two entries about one change
// share even when their titles do not.
const CONST_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

const NOTE_MAX = 2
const PARSED_MAX = 3

function flat (s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function basename (p) {
  return String(p || '').split('/').pop() || ''
}

function stemOf (p) {
  return basename(p).replace(/\.[^.]+$/, '')
}

export function entryTitle (e) {
  return flat(e?.ai?.title || e?.title || e?.messageTitle)
}

// Every path an entry touched, as stored.
export function touchedPaths (e) {
  const f = e?.files || {}
  return [...(f.added || []), ...(f.removed || []), ...(f.renamed || []), ...(f.modified || [])]
}

// The prose an entry says about itself, in the order a reader meets it.
export function entryText (e) {
  return [entryTitle(e), e?.ai?.summary, e?.summary, ...(e?.facts || []), e?.eli5?.text]
    .filter(Boolean).join(' ')
}

// Paths that can carry a link, minus the ones every change touches.
export function linkPaths (e) {
  return touchedPaths(e).filter(p => typeof p === 'string' &&
    !/(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.|(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|README(?:\.[^/]*)?)$/i.test(p) &&
    !GENERIC_BASENAMES.has(stemOf(p).toLowerCase()))
}

// The identifiers an entry is *about*: CONSTANT_CASE names it names, and the
// basenames of the files it touched. Two entries that never share a constant
// still look like one change when they edit the same file ("freebuff-countries").
export function storyTokens (e) {
  const out = new Set()
  for (const m of entryText(e).matchAll(CONST_RE)) out.add(m[0])
  for (const p of linkPaths(e)) {
    const stem = stemOf(p)
    if (stem && !GENERIC_BASENAMES.has(stem.toLowerCase())) out.add(stem)
  }
  return out
}

export function accessStory (s) {
  const t = flat(s)
  return ACCESS_RE.test(t) && MOVED_RE.test(t)
}

// Only explicit eligibility transitions qualify. Broad word co-occurrence (for
// example "added" plus "full access") confuses housekeeping with policy changes.
export function accessEvidence (e) {
  const sources = [...(e?.facts || []), e?.ai?.summary, e?.eli5?.text].filter(Boolean)
  for (const source of sources) {
    for (const sentence of String(source).split(/(?<=[.!?])\s+/)) {
      const text = sentence.replace(/`/g, '').trim()
      if (/\b(?:not|never|would|could|might|if)\b/i.test(text)) continue
      if (!/\b(?:lost|left|exited|removed from|gained|regained) (?:the )?(?:full[- ]access|full free access|allowlist)|\bno longer eligible\b/i.test(text)) continue
      // Keep the dated access statement, not the ad metrics following its colon.
      const headline = text.split(/:\s/)[0]
        .replace(/\bSG\b/g, 'Singapore').replace(/\bIL\b/g, 'Israel')
      return /[.!?]$/.test(headline) ? headline : headline + '.'
    }
  }
  return ''
}

export function isConsequential (e) {
  return !!accessEvidence(e)
}
// A cluster is a connected set: a link needs one shared specific file, or two
// shared identifiers when the code was reached by different paths.
function linkedDesc (a, b) {
  for (const p of a.paths) if (b.paths.includes(p)) return true
  let shared = 0
  for (const t of a.tokens) if (b.tokens.has(t) && ++shared >= 2) return true
  return false
}

function describe (e) {
  return {
    entry: e,
    title: entryTitle(e),
    paths: linkPaths(e),
    tokens: storyTokens(e),
    line: flat(e.eli5?.text),
    access: isConsequential(e)
  }
}

function clustersOf (list, day = list[0]?.day) {
  const desc = list.map(describe)
  const seen = new Array(desc.length).fill(false)
  const out = []
  for (let i = 0; i < desc.length; i++) {
    if (seen[i]) continue
    seen[i] = true
    const queue = [i]
    const members = []
    while (queue.length) {
      const at = desc[queue.pop()]
      members.push(at)
      for (let j = 0; j < desc.length; j++) {
        if (seen[j] || desc[j] === at) continue
        if (!linkedDesc(at, desc[j])) continue
        seen[j] = true
        queue.push(j)
      }
    }
    if (members.length < 2) continue
    // Oldest first: the day lead reads as the story happened, and the entry whose
    // line was written before the other one existed comes before it.
    members.sort((a, b) => String(a.entry.date || '').localeCompare(String(b.entry.date || '')) ||
      String(a.entry.sha || '').localeCompare(String(b.entry.sha || '')))
    // A cluster whose only native member is one row and the rest are borrowed
    // bumps is still a real link (the bump ships that row), but it needs one
    // member that belongs to this day.
    if (!members.some(m => m.entry.day === day)) continue
    out.push({
      day,
      access: members.some(m => m.access),
      members: members.map(m => ({
        sha: m.entry.sha,
        anchor: String(m.entry.sha || '').slice(0, 12),
        title: m.title,
        line: m.line,
        raw: m.entry
      }))
    })
  }
  return out.sort((a, b) => b.members.length - a.members.length)
}

// The note exists to keep a plain-English line honest, so it fires only where a
// reader is told something in the access domain that a related entry contradicts:
// the related line records the access change, this one is about access without
// recording it. Anything else is noise the existing RELATED line already covers,
// and quoting a second line that *also* omits the change would bury it again.
function noteWanted (entry, peer) {
  const mine = flat(entry?.eli5?.text)
  const theirs = flat(peer?.eli5?.text)
  if (!mine || !theirs || !ACCESS_RE.test(mine) || accessStory(mine)) return false
  return !!(accessEvidence(entry) || accessEvidence(peer))
}

/**
 * Every same-day cluster, plus the note each entry should carry.
 *
 * Returns `{ notes: Map<sha, Note[]>, days: Map<day, Cluster[]> }`. Noise rows are
 * excluded: a lockfile riding along in a snapshot is not part of the story, and a
 * cluster page must not link out of a row that says nothing.
 */
export function buildStoryIndex (entries) {
  const notes = new Map()
  const days = new Map()
  const byDay = new Map()
  const push = (day, e) => {
    const list = byDay.get(day) || []
    list.push(e)
    byDay.set(day, list)
  }
  for (const e of entries || []) {
    if (!e || e.noise || !e.day) continue
    if (!entryTitle(e)) continue
    push(e.day, e)
    if (isBumpEntry(e)) {
      const prev = previousDay(e.day)
      if (prev) push(prev, e)
    }
  }
  for (const [day, list] of byDay) {
    // A bump borrowed from tomorrow must not seed a cluster by itself; drop the
    // list when nothing native to the day is in it.
    if (!list.some(e => e.day === day)) continue
    const clusters = clustersOf(list, day)
    if (!clusters.length) continue
    days.set(day, clusters)
    for (const cluster of clusters) {
      for (const m of cluster.members) {
        const rel = cluster.members.filter(p => p !== m && noteWanted(m.raw, p.raw))
        if (!rel.length) continue
        // A note written under day D for a bump that lives on D+1 must not
        // overwrite the one its own day computed.
        if (m.raw.day !== day && notes.has(m.sha)) continue
        notes.set(m.sha, rel.slice(0, NOTE_MAX).map(p => ({
          sha: p.sha, day: p.raw.day || day, anchor: p.anchor, title: p.title,
          text: [accessEvidence(m.raw) || accessEvidence(p.raw), p.line].filter(Boolean).join(' ')
        })))
      }
    }
  }
  return { notes, days }
}

/** The clusters worth a day-level line: a real story, and one that moved access. */
export function dayStories (index, day) {
  return (index?.days?.get(day) || []).filter(c => c.access && c.members.length >= 2)
}

// Lead with explicit access evidence, followed by the linked entries' own lines.
// The effective date comes from evidence, independently of the publication day.
export function dayStoryLead (clusters) {
  const c = (clusters || [])[0]
  if (!c) return null
  const shown = c.members.filter(m => m.line).slice(0, PARSED_MAX)
  const headline = c.members.map(m => accessEvidence(m.raw)).find(Boolean)
  if (!shown.length || !headline) return null
  return {
    headline,
    day: c.day,
    count: c.members.length,
    rest: c.members.length - shown.length,
    parts: shown.map(m => ({ anchor: m.anchor, day: m.raw?.day || c.day, title: m.title, text: m.line }))
  }
}