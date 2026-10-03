// data/rollups/<day>.json: the settled day's changes as a short, user-facing
// bullet digest, rendered at the top of that day's page.
//
// Why a separate pass: the day page is exhaustive, and its rows are written for
// readers who open one change. A reader arriving at a day wants to know what
// happened in it in a few lines -- the entry titles are internal ("SDK BYOK
// store gains add model reusing endpoint with independent key") and the
// summaries are technical. The digest is a condensation of material the
// pipeline already verified, and it is generated once, when the day is settled,
// instead of being derived at render time where it would cost every build and
// could not be reviewed as one artifact.
//
// A day is settled when it is in the past; it is digestible when every
// feature change carries a summary, or a day of grace has passed so a row
// that will never summarize cannot hold the whole day's digest hostage. The
// `source` fingerprint is the exact input the bullets were written from: a late
// entry or a rewritten summary changes it, and the digest is regenerated from
// the new day. Nothing here runs at build time -- the site renderer only reads
// the stored file.
//
// The digest covers *feature* changes only. A release-bump row carries the
// release roll-up ("Updated Freebuff CLI to 0.2.4, ..."), and its member changes
// are their own entries, digested on their own days; letting bump rows into the
// input produced page after page of version labels and buried the actual fixes.
// Test-only rows are plumbing by the same reasoning.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, shortHash, writeJson } from './util.mjs'
import { callScopedLlm, cleanText, DEFAULT_LLM_MODEL, servedModelOf } from './llm.mjs'
import { isBumpEntry } from './analyze.mjs'

export const ROLLUP_DIR = 'rollups'
export const ROLLUP_V = 3
export const ROLLUP_MAX_BULLETS = 24
export const ROLLUP_BULLET_CHARS = 140
// How long a settled day may wait for rows that have not summarized before the
// digest goes out without them. Without a bound, one parked row (a provider
// outage the pipeline gave up on) would keep the day's page digest-less
// forever; the fingerprint makes the digest refresh if the row ever lands.
export const ROLLUP_SETTLE_GRACE_MS = 24 * 60 * 60 * 1000

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function rollupPath (dataDir, day) {
  return join(dataDir, ROLLUP_DIR, `${day}.json`)
}

// Bullets are shown as plain text, so a model that slips into markdown (a code
// fence, a file path, a PR number) costs that bullet, not the page. A digest of
// a day does not need identifiers: the named thing is one click away.
const BULLET_REJECT = [
  /`/,
  /(?:\/[\w.-]+){2,}/,
  /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml)\b/i,
  /#\d+/,
  /\b[0-9a-f]{7,40}\b/,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, // CONSTANT_CASE
  /\b[a-z][a-z0-9]*_[a-z0-9]+\b/, // snake_case
  /\b\w+\(\)/ // function calls
]

// camelCase words that are product names, not identifiers. Everything else in
// that shape (freebucksTimeZoneHeaders, useGravityAd) is construction work the
// prompt should have translated into what the thing does.
const CAMEL_ALLOW = new Set(['ios', 'ipados', 'macos', 'iphone', 'ipad', 'ipod', 'ebay', 'youtube', 'whatsapp', 'linkedin', 'esim', 'xai'])
const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g

function camelIdentifiers (text) {
  const out = []
  for (const m of String(text).matchAll(CAMEL_RE)) {
    if (!CAMEL_ALLOW.has(m[0].toLowerCase())) out.push(m[0])
  }
  return out
}

function usableText (e) {
  return !!(e?.ai?.title && e.ai?.summary)
}

// What the digest may restate: a summarized feature change. Bump rows carry the
// release text, not the day's features; test-only rows are plumbing.
function digestible (e) {
  return !e?.noise && !e?.testOnly && !isBumpEntry(e) && usableText(e)
}

function dayOf (e) {
  return e?.day || String(e?.date || '').slice(0, 10) || ''
}

function dayEndMs (day) {
  return Date.parse(`${day}T00:00:00Z`) + 86400000
}

function nowMs (now) {
  return typeof now === 'number' ? now : new Date(now ?? Date.now()).getTime()
}

// The exact material the bullets may restate: the verified title and summary of
// each change, the plain-English line when one exists, and the reader-facing
// flags that say who the change is for. This string is both the prompt body and
// the fingerprint source, so a digest is never reused against different input.
export function rollupInput (day, entries = []) {
  const lines = [`Day: ${day} (UTC)`]
  for (const e of entries) {
    if (!digestible(e)) continue
    const ai = e.ai
    const flags = [ai.significance, ai.audience, ai.userVisible === true ? 'user-visible' : null, ai.breaking ? 'breaking' : null].filter(Boolean)
    lines.push('', `- ${flags.length ? `[${flags.join(', ')}] ` : ''}${cleanText(ai.title, 140)}`)
    lines.push(`  ${cleanText(ai.summary, 700, true)}`)
    const plain = e.eli5?.text ? cleanText(e.eli5.text, 400, true) : ''
    if (plain) lines.push(`  Plain English: ${plain}`)
  }
  return lines.join('\n')
}

export function rollupFingerprint (day, entries = []) {
  return shortHash(rollupInput(day, entries))
}

export function buildRollupPrompt (day, input) {
  return `You write the daily roll-up for a changelog site: the bullet list at the top of one day's page, above the individual entries. It is how most readers learn what shipped that day, so it must cover the day's features and changes completely enough that they do not have to open an entry. Every word must be true to the verified material below.

Rules:
- Cover the day. Write one bullet for every change that alters what a Freebuff user can do, see, or pay: features, fixes, behavior, models, prices, permissions, slash commands, limits. A busy day runs to a dozen bullets or more; do not compress several unrelated changes into one bullet and do not drop a change because it seems small.
- Write about the change itself, never about the release that carried it. No version numbers, no release names, and no "the release".
- A bullet belongs here only if a user could notice it. Verbs like Added a helper, Updated a schema, Logged, Gated, Rotated, Pinned, Scoped, Renamed and Refactored almost always mean construction work: leave those out, however notable the material calls them. Do not write about analytics or ad-serving internals (events, schemas, fields, experiment arms), database or BigQuery work, logging and error serializers, internal helpers, or a change you cannot describe without naming code.
- If a bullet only makes sense to someone reading the code, it is not a feature: drop it.
- Lead every bullet with a past-tense verb: Added, Fixed, Updated, Improved, Simplified, Prevented, Removed, Changed.
- One idea per bullet, one sentence, at most ${ROLLUP_BULLET_CHARS} characters, ending with a period. Do not join two changes with "and": split them into separate bullets.
- Plain text only: no markdown, no backticks, no file paths, no commit or PR references, no version numbers, no internal module or job names. Never write code identifiers (camelCase, snake_case or CONSTANT_CASE names), function names, flags, schema fields or event names. Translate them into what the thing does: say "the freebucks timezone header", not "freebucksTimeZoneHeaders".
- Never use em dashes. Use commas, parentheses, or hyphens.
- Order bullets by what a reader would care about most, not by the order below.
- At most ${ROLLUP_MAX_BULLETS} bullets, and never more than the number of changes below.
- Use only facts, names, and numbers present in the material. If a detail is not there, leave it out. Do not add benefits, motivations, or availability the material does not state.

Output JSON only, no prose and no code fences: {"bullets":["...","..."]}

Material:
${input}
`
}

// Shape rules only: a model that answers prose, an empty list, or a bullet full
// of internal identifiers fails here (and callLlm re-asks once) instead of
// putting machine text on a day page.
export function validateRollupOut (out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.bullets)) throw new Error('rollup output missing a bullets array')
  const bullets = []
  const seen = new Set()
  for (const raw of out.bullets) {
    if (typeof raw !== 'string') continue
    let b = cleanText(raw, ROLLUP_BULLET_CHARS + 80, true).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim()
    if (!b) continue
    if (!/[.!?]$/.test(b)) b += '.'
    if (b.length > ROLLUP_BULLET_CHARS + 40) continue
    if (BULLET_REJECT.some(re => re.test(b))) continue
    if (camelIdentifiers(b).length) continue
    // The same change restated twice reads as padding and ships even when both
    // records are real (a bump row and its member row). Punctuation differs
    // between restatements, so equality is on the normalized words.
    const key = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    bullets.push(b)
    if (bullets.length >= ROLLUP_MAX_BULLETS) break
  }
  if (!bullets.length) throw new Error('rollup output had no usable bullets')
  return { bullets }
}

// Whether a settled day can be digested now: at least one feature change has
// text, and either every feature change does or the grace window has passed.
// Release bumps and test-only rows are not features and never hold the digest.
// Rows that are still queued keep it from being written half-formed; rows that
// are parked stop it from being written at all.
export function dayRollupReady (day, entries = [], { now = Date.now() } = {}) {
  const features = entries.filter(e => !e?.noise && !e?.testOnly && !isBumpEntry(e))
  const text = features.filter(usableText)
  if (!text.length) return false
  if (text.length === features.length) return true
  return nowMs(now) - dayEndMs(day) >= ROLLUP_SETTLE_GRACE_MS
}

/**
 * The settled days whose digest is missing, stale (the day changed since it was
 * written) or from an older prompt version, newest first. `doc` is a loaded
 * changelog; `rollups` is loadRollups' map. Days with no meaningful changes are
 * skipped -- there is nothing a reader would want digested -- and so are days
 * whose entries have not summarized yet inside the grace window.
 */
export function rollupBacklog (doc, { rollups = {}, now = Date.now(), limit = Infinity, force = false } = {}) {
  const today = new Date(nowMs(now)).toISOString().slice(0, 10)
  const byDay = new Map()
  for (const e of doc?.entries || []) {
    const day = dayOf(e)
    if (!DAY_RE.test(day) || day >= today) continue
    if (e.noise) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(e)
  }
  const pending = []
  for (const [day, entries] of byDay) {
    if (!dayRollupReady(day, entries, { now })) continue
    const source = rollupFingerprint(day, entries)
    const current = rollups[day]
    if (!force && current?.v === ROLLUP_V && current.source === source && Array.isArray(current.bullets) && current.bullets.length) continue
    pending.push({ day, entries: entries.filter(digestible), source })
  }
  pending.sort((a, b) => (a.day < b.day ? 1 : -1))
  return limit === Infinity ? pending : pending.slice(0, Math.max(0, limit))
}

/**
 * The automatic pass's slice of the backlog: forward-only. It covers the
 * frontier -- the days after the newest stored digest -- so a newly settled day
 * is digested on its own and an outage window heals when the relay returns.
 * Everything older is a historical window that only an explicit backfill should
 * spend on; draining it automatically would turn "forward-only" into "the whole
 * archive at two days per cycle". With nothing stored yet, the frontier is the
 * newest settled day itself, so the first automatic digest starts the frontier
 * instead of silently backfilling history.
 */
export function forwardRollupBacklog (doc, { rollups = {}, now = Date.now(), limit = Infinity } = {}) {
  const pending = rollupBacklog(doc, { rollups, now })
  if (!pending.length) return pending
  const stored = Object.keys(rollups).filter(day => DAY_RE.test(day)).sort()
  const out = stored.length
    ? pending.filter(p => p.day > stored[stored.length - 1])
    : pending.slice(0, 1)
  return limit === Infinity ? out : out.slice(0, Math.max(0, limit))
}

export async function saveRollup (dataDir, rollup) {
  await writeJson(rollupPath(dataDir, rollup.day), rollup)
}

// Every stored digest, keyed by day, for the site build. A missing directory is
// an empty map: a checkout that has never rolled one up builds fine.
export async function loadRollups (dataDir) {
  const out = {}
  let names = []
  try { names = (await readdir(join(dataDir, ROLLUP_DIR))).filter(n => DAY_RE.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).sort() } catch { return out }
  for (const name of names) {
    const rollup = await readJson(join(dataDir, ROLLUP_DIR, name), null)
    if (rollup?.day && Array.isArray(rollup.bullets) && rollup.bullets.length) out[rollup.day] = rollup
  }
  return out
}

/**
 * Write one day's digest. One model call over the day's verified records; the
 * answer is stored with the model that served it and the fingerprint of the
 * input, so the next cycle can tell current from stale without diffing prose.
 */
export async function generateRollup (day, entries, { dataDir, env = process.env } = {}) {
  const input = rollupInput(day, entries)
  const prompt = buildRollupPrompt(day, input)
  const { out, requests } = await callScopedLlm(prompt, env, validateRollupOut, { stage: 'day-rollup' })
  const rollup = {
    day,
    v: ROLLUP_V,
    at: new Date().toISOString(),
    source: rollupFingerprint(day, entries),
    model: servedModelOf(requests, env.LLM_MODEL || DEFAULT_LLM_MODEL),
    bullets: out.bullets
  }
  await saveRollup(dataDir, rollup)
  return rollup
}
