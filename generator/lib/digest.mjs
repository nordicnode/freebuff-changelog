// generator/lib/digest.mjs - weekly digests and summary-quality metrics.
//
// Both are derived at build time from the entries in hand: no LLM call, no
// cache, nothing to merge. A digest is the week's releases, catalog moves and
// heaviest changes, in that order; the quality panel is the set of numbers the
// prompt work is judged by (prompt-version coverage, unverified names,
// marketing hits, audience split), so a regression shows up on the next deploy.
import { escapeHtml as esc } from './util.mjs'
import { PROMPT_V, ELI5_V, ELI5_HYPE_ROLLUP_RE, WHY_RE, AUDIENCES, isSecurityEntry } from './llm.mjs'

// ISO week key (YYYY-Www) and its Monday, from a YYYY-MM-DD day string.
export function isoWeekOf (day) {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - dow)
  const thursday = new Date(monday)
  thursday.setUTCDate(monday.getUTCDate() + 3)
  const year = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const week = 1 + Math.round(((thursday - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { key: `${year}-W${String(week).padStart(2, '0')}`, monday: monday.toISOString().slice(0, 10), sunday: sunday.toISOString().slice(0, 10) }
}

const SIG_RANK = { major: 0, notable: 1, minor: 2 }

// Newest week first. Each digest carries what a reader wants in the order they
// want it; `top` is capped so a 78-commit day does not become a 78-row digest.
export function buildWeeklyDigests (entries, { topN = 12 } = {}) {
  const byWeek = new Map()
  for (const e of entries || []) {
    if (!e || e.noise || !e.day) continue
    const wk = isoWeekOf(e.day)
    if (!wk) continue
    let w = byWeek.get(wk.key)
    if (!w) {
      w = { key: wk.key, monday: wk.monday, sunday: wk.sunday, entries: [], releases: [], models: [], commands: [], security: [], top: [], days: new Set(), counts: { changes: 0, major: 0, notable: 0, minor: 0 } }
      byWeek.set(wk.key, w)
    }
    w.entries.push(e)
    w.days.add(e.day)
    w.counts.changes++
    const sig = e.ai?.significance || e.significance || 'minor'
    if (w.counts[sig] != null) w.counts[sig]++
    if (e.version || e.freebuffVersion) w.releases.push(e)
    if (e.modelChanges) w.models.push(e)
    if (e.cmdChanges) w.commands.push(e)
    if (isSecurityEntry(e)) w.security.push(e)
  }
  const weeks = [...byWeek.values()]
  for (const w of weeks) {
    const bumpSet = new Set(w.releases.map(e => e.sha))
    w.top = w.entries
      .filter(e => !bumpSet.has(e.sha) && !e.modelChanges)
      .sort((a, b) => (SIG_RANK[a.ai?.significance || a.significance] ?? 2) - (SIG_RANK[b.ai?.significance || b.significance] ?? 2) || (a.date < b.date ? 1 : -1))
      .slice(0, topN)
    w.releases.sort((a, b) => (a.date < b.date ? -1 : 1))
    w.models.sort((a, b) => (a.date < b.date ? -1 : 1))
    w.entries.sort((a, b) => (a.date < b.date ? 1 : -1))
    w.dayCount = w.days.size
    delete w.days
  }
  return weeks.sort((a, b) => (a.key < b.key ? 1 : -1))
}

export function weekLabel (w) {
  return `${w.monday} to ${w.sunday}`
}

function titleOf (e) {
  return e.ai?.title || e.title || ''
}

export function weeklyHeadline (w) {
  const bits = []
  if (w.releases.length) bits.push(`${w.releases.length} release${w.releases.length === 1 ? '' : 's'}`)
  if (w.models.length) bits.push(`${w.models.length} model catalog change${w.models.length === 1 ? '' : 's'}`)
  if (w.commands.length) bits.push(`${w.commands.length} slash command change${w.commands.length === 1 ? '' : 's'}`)
  if (w.security.length) bits.push(`${w.security.length} security-relevant change${w.security.length === 1 ? '' : 's'}`)
  bits.push(`${w.counts.changes} change${w.counts.changes === 1 ? '' : 's'} over ${w.dayCount} day${w.dayCount === 1 ? '' : 's'}`)
  return bits.join(', ')
}

// Plain-text digest for feeds and Discord: sections with one line per entry.
export function weeklyText (w, siteUrl = '') {
  const line = (e) => `- ${(e.day || '').slice(5)} ${titleOf(e)}${siteUrl ? ` (${siteUrl}/day/${e.day}/#${e.sha.slice(0, 12)})` : ''}`
  const out = [weeklyHeadline(w) + '.']
  if (w.releases.length) out.push('', 'Releases:', ...w.releases.map(line))
  if (w.models.length) {
    out.push('', 'Model catalog:')
    for (const e of w.models) {
      const a = e.modelChanges.added || [], r = e.modelChanges.removed || []
      out.push(`- ${(e.day || '').slice(5)} ${a.length ? `+${a.join(', +')}` : ''}${a.length && r.length ? ' ' : ''}${r.length ? `-${r.join(', -')}` : ''}`)
    }
  }
  if (w.top.length) out.push('', 'Notable work:', ...w.top.map(line))
  return out.join('\n')
}

export function weeklyFeedItem (siteUrl, w) {
  const url = `${siteUrl}/week/${w.key}/`
  const sections = []
  const li = (e) => `<li><a href="${siteUrl}/day/${e.day}/#${e.sha.slice(0, 12)}">${esc(e.day)}</a> ${esc(titleOf(e))}${e.eli5?.text ? `<br><small>${esc(e.eli5.text)}</small>` : ''}</li>`
  if (w.releases.length) sections.push(`<p><b>Releases</b></p><ul>${w.releases.map(li).join('')}</ul>`)
  if (w.models.length) sections.push(`<p><b>Model catalog</b></p><ul>${w.models.map(li).join('')}</ul>`)
  if (w.top.length) sections.push(`<p><b>Notable work</b></p><ul>${w.top.map(li).join('')}</ul>`)
  sections.push(`<p><a href="${url}">Full digest</a></p>`)
  const desc = weeklyText(w).slice(0, 1800)
  // The current week is still open: a Sunday-night stamp would be in the
  // future, and many readers hide future items. Use the newest entry instead.
  const newest = w.entries[0]?.date ? Date.parse(w.entries[0].date) : 0
  const sundayEnd = Date.parse(`${w.sunday}T23:59:00Z`)
  const weekOpen = sundayEnd > Date.now()
  const pubDate = new Date(weekOpen ? (newest || Date.now()) : sundayEnd).toUTCString()
  return `<item><title>${esc(`Week ${w.key}: ${weeklyHeadline(w)}`)}</title><link>${url}</link>`
    + `<guid isPermaLink="true">${url}</guid><pubDate>${pubDate}</pubDate>`
    + `<category>weekly</category>`
    + `<description>${esc(desc)}</description>`
    + `<content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/"><![CDATA[${sections.join('')}]]></content:encoded></item>`
}

// ---------------------------------------------------------------------------
// Summary quality, from the entries as they will render.

const DEV_WORDS_RE = /\b(?:codebase|repository|refactor(?:ed|ing)?|endpoint|function|constant|enum|schema|middleware|regex)\b/i
const IDENT_RE = /\b[a-z]+[A-Z][a-zA-Z0-9]+\b|\b[a-z0-9]+_[a-z0-9_]+\b|\.[tj]sx?\b/
const PREAMBLE_RE = /^(?:in this (?:release|update|change)|behind the scenes|under the hood|this (?:release|update|change|commit))/i
const SCOPE_RE = /scope (?:is )?limited to/i

export function summaryQuality (entries) {
  const rows = (entries || []).filter(e => e && !e.noise)
  const withAi = rows.filter(e => e.ai?.title)
  const withEli5 = rows.filter(e => e.eli5?.text)
  const q = {
    changes: rows.length,
    summarized: withAi.length,
    onCurrentPrompt: withAi.filter(e => (e.ai.v ?? 1) >= PROMPT_V).length,
    stalePrompt: withAi.filter(e => (e.ai.v ?? 1) < PROMPT_V).length,
    explained: withEli5.length,
    eli5Current: withEli5.filter(e => (e.eli5.v ?? 1) >= ELI5_V).length,
    eli5Template: withEli5.filter(e => e.eli5.model === 'template').length,
    withEvidence: withAi.filter(e => e.ai.evidence).length,
    ungrounded: withAi.filter(e => e.ai.ungrounded?.length).length,
    verified: withAi.filter(e => e.ai.verify === 'passed').length,
    verifyFlagged: withAi.filter(e => e.ai.verify === 'flagged').length,
    overridden: rows.filter(e => e.overridden).length,
    sigOverridden: withAi.filter(e => e.ai.significance && e.ai.significance !== e.significance).length,
    natureMissing: rows.filter(e => !e.commitNature).length,
    scopeBoilerplate: withAi.filter(e => SCOPE_RE.test(e.ai.summary || '')).length,
    eli5Preamble: withEli5.filter(e => PREAMBLE_RE.test(e.eli5.text)).length,
    eli5Hype: withEli5.filter(e => ELI5_HYPE_ROLLUP_RE.test(e.eli5.text)).length,
    eli5DevWords: withEli5.filter(e => DEV_WORDS_RE.test(e.eli5.text)).length,
    eli5Identifiers: withEli5.filter(e => IDENT_RE.test(e.eli5.text)).length,
    security: rows.filter(isSecurityEntry).length,
    whyVisible: withAi.filter(e => WHY_RE.test(e.ai.summary || '')).length,
    withStructured: rows.filter(e => e.structured && Object.values(e.structured).some(v => Array.isArray(v) && v.length)).length,
    breaking: withAi.filter(e => e.ai.breaking).length,
    lowConfidence: withAi.filter(e => e.ai.confidence === 'low').length,
    withMigration: withAi.filter(e => e.ai.migration).length,
    withUnknowns: withAi.filter(e => e.ai.unknowns).length,
    multiTopic: withAi.filter(e => e.ai.changes?.length >= 2).length,
    prLinked: withAi.filter(e => e.ai.pr || e.pr).length,
    prMatchedByFiles: withAi.filter(e => e.ai.prMatched === 'files').length,
    audience: Object.fromEntries(AUDIENCES.map(a => [a, withAi.filter(e => e.ai.audience === a).length])),
    audienceUnset: withAi.filter(e => !e.ai.audience).length,
    models: {}
  }
  for (const e of withAi) q.models[e.ai.model || '?'] = (q.models[e.ai.model || '?'] || 0) + 1
  return q
}
