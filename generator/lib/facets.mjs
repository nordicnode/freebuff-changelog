// generator/lib/facets.mjs - the observable surface of Freebuff, replayed.
//
// The changelog is an event log. `modelChanges`, `cmdChanges` and the structured
// facts are events: each row says what changed in a named thing, on a day, in a
// commit. Replayed oldest-first they reconstruct the state of the product's
// surface -- what exists now, what it says about itself, when each arrived, and
// which commit established the value in force today.
//
// This is the part of the guide that is COMPILED, not written. Nothing in here
// is prose, so nothing in here can be wrong, and every value carries the commit
// it came from. That buys three things a generated document cannot have:
//
//   * It is a pure function of data/**. No cache key, no prompt version, no API
//     budget, and it is current on every build rather than on every regeneration.
//   * It is falsifiable. Recomputing is the build, so a test can assert the
//     rendered page agrees with the replay (see auditGuide) and a stale guide is
//     a red build instead of a page that quietly lies to a staff member.
//   * It knows what it does not know. `coverage` is reported per facet, so the
//     guide can say how much of the history it actually saw -- and that number
//     doubles as the work-list for improving the upstream extraction.
//
// The LLM layer (guide.mjs) is only allowed to write the connective prose
// between these facts, from this closed fact set, validated against it.

import { shortHash } from './util.mjs'
import { isSecurityEntry } from './llm.mjs'

const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sha < b.sha ? -1 : 1)
const byDateDesc = (a, b) => -byDateAsc(a, b)

function ref (e) {
  if (!e) return null
  const day = e.day || (e.date ? String(e.date).slice(0, 10) : '')
  return {
    sha: e.sha,
    day,
    title: e.ai?.title || e.title || e.messageTitle || '',
    url: day ? `/day/${day}/#${e.sha.slice(0, 12)}` : null
  }
}

// One event in one item's life. `kind` is what happened; `from`/`to` carry the
// value where the event log recorded one, so a supersession chain is data.
function ev (e, kind, extra = {}) {
  return { kind, ...extra, ...ref(e) }
}

// Two adds in a row with no remove between them are the same thing seen twice:
// the extractor read the same name out of two files. Left alone they render as
// "--agent: added -> added -> added -> added", which is noise. A real remove
// between them is exactly what stops a run, so that break is preserved.
function collapse (sorted) {
  const out = []
  for (const e of sorted) {
    const prev = out[out.length - 1]
    if (prev && prev.kind === e.kind && e.kind !== 'changed') {
      prev.seenIn = (prev.seenIn || 1) + 1
      prev.alsoIn = prev.alsoIn || []
      if (!prev.alsoIn.some(x => x.sha === e.sha)) prev.alsoIn.push({ sha: e.sha, day: e.day, title: e.title, url: e.url })
      // Later sightings carry the fresher value, so they win.
      if (e.to) prev.to = e.to
      continue
    }
    out.push({ ...e, seenIn: 1 })
  }
  return out
}

// Replay `events` into per-key timelines. The generic half of every facet: an
// event says key K changed in commit S, and the last one wins.
function replay (events) {
  const items = new Map()
  for (const e of events) {
    if (!e.key) continue
    let it = items.get(e.key)
    if (!it) { it = { key: e.key, events: [] }; items.set(e.key, it) }
    it.events.push(e)
  }
  const out = []
  for (const it of items.values()) {
    const sorted = collapse(it.events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)))
    const last = sorted[sorted.length - 1]
    const current = last.kind === 'removed' ? null : last.to
    out.push({
      key: it.key,
      // A key whose last event is a remove is not in the product. A key that
      // only ever re-stated a value counts as present, because a re-stated
      // value is itself evidence that it still exists.
      status: last.kind === 'removed' ? 'retired' : 'live',
      label: last.label || it.events.find(e => e.label)?.label || it.key,
      detail: current || null,
      first: sorted[0],
      last,
      events: sorted.slice().reverse()
    })
  }
  return out.sort((a, b) => (a.status === b.status ? String(a.label).localeCompare(String(b.label)) : a.status === 'live' ? -1 : 1))
}

// ---------------------------------------------------------------------------
// The facets. Each is a named question a staff member actually asks, and the
// subset of the event log that answers it.

const facetDefs = [
  {
    id: 'models',
    label: 'Model catalog',
    question: 'What can a user pick right now, what can they no longer pick, and what changed?',
    noun: 'model',
    events (entries) {
      const out = []
      for (const e of entries) {
        if (!e.modelChanges) continue
        const tables = e.modelChanges.tables || {}
        const row = (name) => {
          const t = tables[name]
          // `after` is [name, access, description]. The access tier is the part
          // staff get asked about, so it is the part carried as the value.
          const a = t?.after
          return Array.isArray(a) ? (a[1] || a[2] || null) : null
        }
        for (const name of e.modelChanges.added || []) out.push(ev(e, 'added', { key: name, to: row(name) }))
        for (const name of e.modelChanges.removed || []) out.push(ev(e, 'removed', { key: name, from: row(name) }))
        // A row that re-states a catalog entry without adding or removing it
        // still moved that model's tier or blurb, and must not be missed.
        for (const [name, t] of Object.entries(tables)) {
          if (t?.before && t.after && !(e.modelChanges.added || []).includes(name) && !(e.modelChanges.removed || []).includes(name)) {
            out.push(ev(e, 'changed', { key: name, from: t.before[1] || t.before[2] || null, to: t.after[1] || t.after[2] || null }))
          }
        }
      }
      return out
    },
    note: 'Reconstructed from rows whose diff moved the model catalog table.'
  },
  {
    id: 'commands',
    label: 'Slash commands',
    question: 'Which commands exist, which were retired, and when?',
    noun: 'command',
    events (entries) {
      const out = []
      for (const e of entries) {
        if (!e.cmdChanges) continue
        for (const c of e.cmdChanges.added || []) out.push(ev(e, 'added', { key: c }))
        for (const c of e.cmdChanges.removed || []) out.push(ev(e, 'removed', { key: c }))
      }
      return out
    },
    note: 'Reconstructed from rows whose diff added or removed a command definition.'
  },
  {
    id: 'config',
    label: 'Configuration surface',
    question: 'What environment variables and flags exist to configure, and what did they default to?',
    noun: 'setting',
    events (entries) {
      const out = []
      const constant = (e, name) => {
        const c = (e.structured?.constants || []).find(x => x?.name === name)
        return c?.to ?? null
      }
      for (const e of entries) {
        for (const v of e.structured?.envVars || []) out.push(ev(e, 'added', { key: v, to: constant(e, v) }))
        for (const f of e.structured?.flags || []) out.push(ev(e, 'added', { key: f, to: constant(e, f) }))
      }
      // The summary pass records newly introduced settings too, and a value it
      // found that the structured extractor missed is still an event.
      for (const e of entries) {
        for (const v of e.ai?.newEnvVars || []) if (!out.some(x => x.key === v && x.sha === e.sha)) out.push(ev(e, 'added', { key: v }))
        for (const f of e.ai?.newFlags || []) if (!out.some(x => x.key === f && x.sha === e.sha)) out.push(ev(e, 'added', { key: f }))
      }
      return out
    },
    note: 'Reconstructed from rows whose diff introduced a setting. A setting that predates the first recorded diff cannot appear.'
  },
  {
    id: 'api',
    label: 'Public API surface',
    question: 'Which exported symbols does the codebase publish now, and which were removed?',
    noun: 'export',
    events (entries) {
      const out = []
      for (const e of entries) {
        for (const s of e.structured?.exportsAdded || []) out.push(ev(e, 'added', { key: s }))
        for (const s of e.structured?.exportsRemoved || []) out.push(ev(e, 'removed', { key: s, from: s }))
      }
      return out
    },
    note: 'Reconstructed from the export-name extractor, which reads a bounded window of each diff. Treat a removal as a signal to check the code, not as proof of a public break.'
  },
  {
    id: 'breaking',
    label: 'Breaking changes',
    question: 'What broke, and is it still the state of the world?',
    noun: 'change',
    events (entries) {
      const out = []
      for (const e of entries) {
        if (!e.ai?.breaking && !e.ai?.migration) continue
        // Keyed by the commit (a title repeats, a sha does not) but LABELLED
        // with the title, because a delta view of raw shas is unreadable and
        // this is the facet a staff member most wants to read.
        out.push(ev(e, 'added', {
          key: e.sha,
          label: e.ai?.title || e.title || e.sha.slice(0, 8),
          to: e.ai?.migration || e.ai?.breaking || null
        }))
      }
      return out
    },
    note: 'One entry per change the summary pass marked breaking or carrying a migration note.'
  }
]

// Build the whole guide. `since` narrows the view to what a reader has not
// seen: items whose latest event falls on or after it. That is the question a
// returning staff member actually has, and over the same state it costs nothing.
export function buildGuide (entries, { since = '', facets = null } = {}) {
  const rows = (entries || []).filter(e => e && !e.noise)
  const want = facets ? facetDefs.filter(d => facets.includes(d.id)) : facetDefs
  const sinceDay = /^\d{4}-\d{2}-\d{2}$/.test(String(since).slice(0, 10)) ? String(since).slice(0, 10) : ''
  const out = []
  for (const def of want) {
    const events = def.events(rows)
    // Replayed once: the delta view is a filter over the same state, so a second
    // replay could only ever disagree with the first.
    const all = replay(events)
    const items = sinceDay
      // An item is in the delta if its latest event is new. A *retired* item
      // still shows, and shows as retired: "the model you were using is gone"
      // is exactly the news a delta has to carry.
      ? all.filter(it => it.last.day >= sinceDay)
      : all
    const touched = new Set(events.map(e => e.sha))
    out.push({
      id: def.id,
      label: def.label,
      question: def.question,
      noun: def.noun,
      note: def.note,
      items,
      total: all.length,
      live: all.filter(i => i.status === 'live').length,
      coverage: {
        // Of all tracked changes, how many carried facts for this facet. The
        // gap is the point: a 3% number on a staff page is more useful than a
        // confident list that quietly omits 97% of history.
        rows: touched.size,
        of: rows.length,
        pct: rows.length ? Math.round(1000 * touched.size / rows.length) / 10 : 0
      },
      // What a human should actually read, ranked. The public API facet replays
      // to 3,906 live symbols: rendering that as a list is a data dump, not a
      // guide. Retirements are the news, supersession chains are the surprises
      // ("it left and came back"), and everything else is one click away.
      headline: [
        ...items.filter(i => i.status === 'retired'),
        ...items.filter(i => i.status === 'live' && i.events.length > 1)
      ].sort((a, b) => (a.last.day < b.last.day ? 1 : a.last.day > b.last.day ? -1 : 0)).slice(0, 12),
      // A content hash over the facts this facet is built from, so the prose
      // layer can regenerate one section when one section's facts move and
      // leave the rest of the guide alone.
      hash: shortHash(JSON.stringify(items.map(i => [i.key, i.status, i.detail, i.last.sha, i.last.day])))
    })
  }
  return {
    // The NEWEST tracked change, not rows[0]: entries are stored oldest-first,
    // so rows[0] reported the guide as of 2024 while it described 2026.
    asOf: rows.reduce((newest, e) => {
      const d = e.day || String(e.date || '').slice(0, 10)
      return d > newest ? d : newest
    }, ''),
    since: sinceDay,
    totalRows: rows.length,
    facets: out,
    security: rows.filter(isSecurityEntry).length
  }
}

// The falsifiability check. Recomputes the replay and reports anything the
// rendered guide could not justify: a value with no commit behind it, a commit
// that is not in the data, or a status that disagrees with the event order.
// Called by a test, and available to a build step that wants the guide to be
// able to fail loudly rather than quietly go stale.
export function auditGuide (guide, entries) {
  const bySha = new Map((entries || []).map(e => [e.sha, e]))
  const problems = []
  for (const f of guide?.facets || []) {
    const rebuilt = buildGuide(entries, { facets: [f.id] }).facets[0]
    if (!rebuilt) { problems.push(`${f.id}: facet vanished on rebuild`); continue }
    if (rebuilt.items.length !== f.items.length) {
      problems.push(`${f.id}: ${f.items.length} items rendered, ${rebuilt.items.length} on rebuild`)
    }
    const before = new Map(rebuilt.items.map(i => [i.key, `${i.status}|${i.detail || ''}|${i.last.sha}`]))
    for (const it of f.items) {
      const now = before.get(it.key)
      if (now === undefined) problems.push(`${f.id}: "${it.key}" is not in the replay`)
      else if (now !== `${it.status}|${it.detail || ''}|${it.last.sha}`) problems.push(`${f.id}: "${it.key}" does not match the replay`)
    }
    for (const it of f.items) {
      for (const e of it.events) {
        if (!bySha.has(e.sha)) problems.push(`${f.id}: "${it.key}" cites commit ${e.sha.slice(0, 8)}, which is not in the changelog`)
        if (!e.day) problems.push(`${f.id}: "${it.key}" has an event with no day`)
      }
      if (!it.first || !it.last) problems.push(`${f.id}: "${it.key}" has no first/last event`)
    }
  }
  return problems
}

// The delta a returning reader wants, as its own list: what is new, what is
// gone, and what changed value, newest first. Same state, filtered -- not a
// second opinion about what changed.
export function guideDelta (guide) {
  const rows = []
  for (const f of guide?.facets || []) {
    for (const it of f.items) {
      for (const e of it.events) {
        if (e.kind === 'changed' || e.day) rows.push({ facet: f.id, facetLabel: f.label, noun: f.noun, ...e })
      }
    }
  }
  return rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, 400)
}
