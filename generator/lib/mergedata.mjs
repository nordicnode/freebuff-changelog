// generator/lib/mergedata.mjs - ordering-invariant merge for the two files
// that *both* writers touch: data/changelog.json (hourly analyze + the backfill
// daemon) and data/ai-summaries.json (the LLM cache).
//
// A cycle holds a changelog.json snapshot in memory for minutes while the LLM
// runs. Writing that snapshot back afterwards reverts whatever the other writer
// pushed in the meantime — not as a git conflict (the hunks can land cleanly),
// but as a silent regression of headSha + generatedAt, which is exactly what
// makes the deployed site report "[stale 184m]" while new commits keep landing.
//
// So every write goes through here: re-read what is on disk, keep the newer
// document as the base, and graft only *our* additions on top. Both files are
// commutative under these rules, so commit order stops mattering.
import { existsSync } from 'node:fs'
import { readJson, writeJson, shortHash, eli5Source, normalizeDate } from './util.mjs'
import { pruneStaleCache } from './versions.mjs'

export function sortEntries (entries) {
  return entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sha < b.sha ? -1 : 1))
}

// A summary counts only if it carries content; error stubs never do.
function usableAi (e) {
  return e && e.ai && (e.ai.summary || e.ai.title) ? e.ai : null
}

// A plain-English line belongs to one particular summary: eli5.src is the hash of
// the title+summary it was written from. A merge must therefore not keep an ELI5
// that explains a summary nobody has any more, and with one candidate on each
// side it must reach the same answer whichever writer happened to push first.
function pickEli5 (ours, theirs, entry) {
  if (!ours) return theirs
  if (!theirs) return ours
  if (entry.ai?.title || entry.ai?.summary) {
    const want = shortHash(eli5Source(entry))
    if (ours.src === want && theirs.src !== want) return ours
    if (theirs.src === want && ours.src !== want) return theirs
  }
  const or = ours.rollup ?? 0
  const tr = theirs.rollup ?? 0
  if (or !== tr) return or > tr ? ours : theirs
  const ov = ours.v ?? 1
  const tv = theirs.v ?? 1
  if (ov !== tv) return ov > tv ? ours : theirs
  // Equal standing: settle on the content, not on who won the merge.
  return String(ours.src) <= String(theirs.src) ? ours : theirs
}

function stampOf (doc) {
  return Date.parse(doc?.generatedAt || '') || 0
}

/**
 * Merge two changelog documents. The one with the newer generatedAt wins the
 * scalar fields (headSha, counts, generatedAt) because it reflects a later
 * analyze pass; entries are unioned by SHA, and AI summaries are grafted from
 * whichever side has the better one.
 */
export function mergeChangelog (ours, theirs) {
  if (!ours || !Array.isArray(ours.entries)) return theirs || ours
  if (!theirs || !Array.isArray(theirs.entries)) return ours || theirs

  const [base, other] = stampOf(ours) >= stampOf(theirs) ? [ours, theirs] : [theirs, ours]
  const entries = base.entries.slice()
  const bySha = new Map(entries.map(e => [e.sha, e]))
  let grafted = 0

  for (const e of other.entries) {
    const cur = bySha.get(e.sha)
    if (!cur) {
      entries.push(e)
      bySha.set(e.sha, e)
      continue
    }
    // Only reach into the base entry when we have a strictly better summary.
    const mine = usableAi(e)
    const theirsAi = usableAi(cur)
    if (mine && (!theirsAi || (theirsAi.v ?? 1) < (mine.v ?? 1) || (!theirsAi.rollup && mine.rollup))) {
      cur.ai = mine
      grafted++
    }
    // ...and its plain-English line has to follow whatever summary ended up here.
    const kept = pickEli5(cur.eli5, e.eli5, cur)
    if (kept && kept !== cur.eli5) cur.eli5 = kept
  }

  // Every write passes through here, which makes this the place a stale in-memory
  // snapshot gets healed rather than re-published: an entry analyzed before the UTC
  // normalization still carries `-07:00`, and sortEntries -- plus every day page and
  // release window the site renders -- compares those strings.
  for (const e of entries) normalizeDate(e)

  return {
    ...base,
    counts: { ...base.counts, entries: entries.length },
    entries: sortEntries(entries)
  }
}

/**
 * Union two LLM caches. Keys are content-addressed (sha + prompt version +
 * patch hash), so equal keys mean equal inputs; on collision prefer a real
 * summary over an error stub, then the newer write.
 */
// Keys from retired prompt versions are dropped on every merge: a local prune
// would otherwise be undone the moment origin's copy (still carrying them) is
// unioned back in. Entries keep their own copy of every summary, so nothing on
// the site depends on these keys.
export function mergeAiCache (ours, theirs) {
  const a = ours || {}
  const b = theirs || {}
  const out = { ...a, ...b }
  for (const key of Object.keys(out)) {
    if (!a[key] || !b[key]) continue
    out[key] = betterCacheEntry(a[key], b[key])
  }
  pruneStaleCache(out)
  return out
}

function entryScore (v) {
  return v?.error ? 0 : 1
}

// A real summary always beats an error stub; otherwise the newer write wins.
function betterCacheEntry (x, y) {
  const sx = entryScore(x)
  const sy = entryScore(y)
  if (sx !== sy) return sx > sy ? x : y
  return (Date.parse(y?.at || '') || 0) > (Date.parse(x?.at || '') || 0) ? y : x
}

/**
 * Merge-safe write for data/open-prs.json.
 *
 * Two independent writers push this file -- the local daemon and the hourly CI
 * backstop -- and neither knows what the other just fetched. Last push wins,
 * which is how a CI run whose page 2 answered HTTP 500 published 60 PRs over the
 * daemon's complete 116 and the page read "60 open" again. So the union is taken
 * by PR number: a PR either side saw stays listed, a field one side filled in
 * (diffstat, preview) survives the other side's blank, and the count can only
 * move toward GitHub's own total, never below it.
 *
 * `listComplete` is the permission to *forget*: it says the stored set is exactly
 * the open set, so a PR missing from it has closed and its cached preview can go.
 * A union of a complete list with a short one is not complete -- the short side
 * may simply have failed to see a PR, and deleting on that assumption is how 56
 * previews disappeared once. Only two complete sides make a complete merge.
 */
export function mergeOpenPrs (ours, theirs) {
  const norm = (v) => Array.isArray(v) ? { prs: v } : (v || {})
  const a = norm(ours)
  const b = norm(theirs)
  const byNum = new Map()
  // `theirs` is applied last, so a fresher record of the same PR wins -- except
  // where it simply knows less, which the per-field guard below protects.
  for (const p of [...(a.prs || []), ...(b.prs || [])]) {
    if (!p || p.number == null) continue
    const prev = byNum.get(p.number)
    if (!prev) { byNum.set(p.number, { ...p }); continue }
    const merged = { ...prev }
    for (const [k, v] of Object.entries(p)) {
      // A page-1 list row carries additions: null where a per-PR call filled it;
      // hasDiff is only ever set true. Never let a lesser record erase the better.
      if (v == null || v === false) {
        if (k === 'hasDiff' && v === false && prev.hasDiff === true) continue
        if (k === 'hasDiff') continue
        if (merged[k] == null) merged[k] = v
        continue
      }
      if (Array.isArray(v) && v.length === 0 && Array.isArray(prev[k]) && prev[k].length > 0) {
        continue
      }
      merged[k] = v
    }
    byNum.set(p.number, merged)
  }
  const prs = [...byNum.values()]
    .sort((x, y) => String(y.created || '').localeCompare(String(x.created || '')))
  const total = Math.max(Number(a.total) || 0, Number(b.total) || 0, prs.length) || null
  const fetchedAt = (Date.parse(b.fetchedAt || '') || 0) > (Date.parse(a.fetchedAt || '') || 0)
    ? (b.fetchedAt || a.fetchedAt)
    : (a.fetchedAt || b.fetchedAt)
  // Still short of what GitHub reported? Then this is unfinished work, not a
  // smaller repo: partial keeps the cache hot so the next run chases the rest.
  const partial = Boolean(a.partial || b.partial) || (total != null && prs.length < total)
  return {
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(total != null ? { total } : {}),
    listComplete: Boolean(a.listComplete && b.listComplete),
    prs,
    ...(partial ? { partial: true } : {})
  }
}

/**
 * Merge-safe write for data/state.json. lastSha must never move backward, or
 * the next analyze pass re-scans commits it already handled and inflates
 * counts.commitsScanned.
 */
export function mergeSyncState (ours, theirs) {
  const a = ours || {}
  const b = theirs || {}
  return (Date.parse(b.updatedAt || '') || 0) > (Date.parse(a.updatedAt || '') || 0) ? b : a
}

/**
 * Snapshot everything this process is allowed to write, so the copy survives a
 * divergence reset that replaces data/ with origin's version. `overrides` carries
 * in-memory-only work (a cycle grafts AI summaries onto entries without touching
 * changelog.json until it commits), so it must survive too.
 */
export async function capturePendingWrites (DATA, overrides = {}) {
  const onDisk = {}
  for (const name of ['changelog.json', 'ai-summaries.json', 'state.json', 'open-prs.json']) {
    const path = `${DATA}/${name}`
    // Only carry files that exist: a missing ai-summaries.json must not be
    // materialized as {} by an unrelated write, which would make a quiet
    // cycle look like a change worth committing.
    if (existsSync(path)) onDisk[path] = await readJson(path, null)
  }
  return { ...onDisk, ...overrides }
}

const MERGERS = {
  'changelog.json': mergeChangelog,
  'ai-summaries.json': mergeAiCache,
  'state.json': mergeSyncState,
  'open-prs.json': mergeOpenPrs
}

/**
 * Re-read each pending file from disk and graft our snapshot onto it. Called
 * before every commit, and again after any realignment with origin.
 */
export async function persistMerged (pending) {
  for (const [path, ours] of Object.entries(pending)) {
    if (ours === null || ours === undefined) continue
    const merger = MERGERS[path.split('/').pop()]
    await writeJson(path, merger ? merger(ours, await readJson(path, null)) : ours)
  }
}
