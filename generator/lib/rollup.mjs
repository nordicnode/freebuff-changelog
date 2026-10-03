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
import { log, readJson, shortHash, writeJson } from './util.mjs'
import { callScopedLlm, cleanText, DEFAULT_LLM_API_BASE, DEFAULT_LLM_MODEL, rollupLlmEnv, servedModelOf, shortError } from './llm.mjs'
import { isBumpEntry } from './analyze.mjs'

export const ROLLUP_DIR = 'rollups'
// v4: the day's material is de-duplicated before the ask and the answer is
// de-duplicated after it (see De-duplication below), and the prompt names the
// number of changes it may write about. Bumping the version re-queues every
// stored digest, which is the only way an already-duplicated one is repaired.
export const ROLLUP_V = 4
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

// ---------------------------------------------------------------------------
// De-duplication.
//
// Duplicates arrive from both sides, and both had to be stopped. The day's rows
// repeat themselves -- a cherry-picked commit, a merge and its original, the
// same fix re-landed -- so the model was asked about one change twice and
// answered twice; and a model with a dozen changes in front of it restates one
// of them in two bullets. Exact-string equality (what this used to be) only
// caught the laziest form of the second: "Added a first-tab discount." next to
// "Fixed the first tab discount for checkout." still shipped as two lines about
// one change.
//
// The comparison is deliberately deterministic: same input, same verdict, every
// run -- a digest must not depend on a second model's opinion of what is
// similar. Words are lowercased, lightly stemmed, stripped of stopwords, and
// stripped of the leading past-tense verb the prompt mandates (two bullets that
// differ only in Added vs Fixed are the same claim twice). Two texts are one
// change when their normalized words match exactly, when their word sets match,
// when the shorter is contained in the longer and the two are within a factor
// of two in length, or when they share at least DUP_JACCARD of their words. The
// bar is high on purpose: "Added dark mode to the settings page." and "Added
// light mode to the settings page." share 3 of 5 words (0.6) and are two
// changes. Containment only counts once the shorter side has two words of its
// own, so a one-word bullet ("Added caching.") is not swallowed by whatever
// longer bullet happens to mention it. And when both sides state a number, the
// numbers have to agree first (see sameNumbers).

const DUP_JACCARD = 0.75

// Function words carry no identity of their own. Negations stay in ("no",
// "not", "never", "without"): dropping them would merge "Settings reset daily"
// with "Settings no longer reset daily", which are opposite claims.
const DUP_STOPWORDS = new Set((
  'a an the to of in on at for with and or is are was were be been being it its this that these those ' +
  'from by as if when while than then there here their they them you your we our us now also still just ' +
  'more most all any each both into out up down off over under again once only very can could will would ' +
  'should may might do does did done has have had get got let lets longer'
).split(' '))

// The lead verb is boilerplate: the prompt mandates one of a fixed set, so the
// word is not what the bullet is about. The list is wider than the prompt's
// eight because a model that deviates should still be de-duplicated.
const LEAD_VERBS = new Set((
  'added add adds fixed fix fixes updated update updates improved improve improves simplified ' +
  'prevented remove removes removed changed change changes introduced launched enabled disabled ' +
  'moved renamed stopped started made increased reduced rolled shipped released allowed kept bumped ' +
  'upgraded downgraded reverted restored cleaned switched trimmed split merged cut hid showed shows ' +
  'opened opens closed closes gave put got lets'
).split(' '))

function normWords (text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
}

// Suffix stripping only, and only while it stays consistent: 'setting' and
// 'settings' must land on the same token. Rules are reapplied until stable, so
// the plural and the -ing forms of the same word agree ('settings' -> 'sett',
// 'setting' -> 'sett').
function stem (word) {
  let w = word
  for (let i = 0; i < 2; i++) {
    const before = w
    if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3)
    else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2)
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    if (w === before) break
  }
  return w
}

function contentTokens (text) {
  const words = normWords(text)
  const lead = words.length > 1 && LEAD_VERBS.has(words[0]) ? words.slice(1) : words
  const out = new Set()
  for (const w of lead) if (!DUP_STOPWORDS.has(w)) out.add(stem(w))
  return out
}

// The numbers a text states: versions, prices, limits, counts. Split the same
// way as everything else, so "0.2.2" is the set {0, 2}.
function numbersOf (text) {
  const out = new Set()
  for (const w of normWords(text)) if (/\d/.test(w)) out.add(w)
  return out
}

function sameNumbers (a, b) {
  const na = numbersOf(a)
  const nb = numbersOf(b)
  if (!na.size || !nb.size) return true // only one side states a number: the other is the vaguer restatement
  if (na.size !== nb.size) return false
  for (const w of na) if (!nb.has(w)) return false
  return true
}

/**
 * Whether two pieces of text describe the same change. See the block comment
 * above for the four rules and where each of them draws the line.
 */
export function nearDuplicate (a, b) {
  const ka = normWords(a).join(' ')
  const kb = normWords(b).join(' ')
  if (!ka || !kb) return false
  if (ka === kb) return true
  // Numbers are load-bearing: a version, a price or a limit that differs is a
  // different claim however few other words differ. "Upgrade OpenTUI to 0.2.2"
  // and "Upgrade OpenTUI to 0.3.0" share six of seven words and are two changes.
  if (!sameNumbers(a, b)) return false
  const ta = contentTokens(a)
  const tb = contentTokens(b)
  if (!ta.size || !tb.size) return false
  if (ta.size === tb.size && [...ta].every(w => tb.has(w))) return true
  const [short, long] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  let inter = 0
  let contained = true
  for (const w of short) {
    if (long.has(w)) inter++
    else contained = false
  }
  if (contained && short.size >= 2 && short.size * 2 >= long.size) return true
  const union = ta.size + tb.size - inter
  return union > 0 && inter / union >= DUP_JACCARD
}

/**
 * The digestible changes of a day, in its order, with the near-identical rows
 * collapsed into the first of them. Both the prompt body and the number of
 * changes the model is held to come from this, so the lines it sees and the
 * count it must respect can never disagree.
 *
 * Two rows are one change when their titles are the same (a cherry-pick, a
 * revert of a revert, one upgrade split across two commits: the titles match
 * because the change does, while the summaries differ because the diffs do) or
 * when title and summary together read as one change. Measured over the stored
 * corpus: the title arm catches every duplicate pair, the near-duplicate arm
 * would catch none of them on its own -- and both together drop nothing that is
 * not a duplicate.
 */
export function digestibleMaterial (entries = []) {
  const out = []
  const titles = new Set()
  for (const e of entries) {
    if (!digestible(e)) continue
    const ai = e.ai
    const record = {
      flags: [ai.significance, ai.audience, ai.userVisible === true ? 'user-visible' : null, ai.breaking ? 'breaking' : null].filter(Boolean),
      title: cleanText(ai.title, 140),
      summary: cleanText(ai.summary, 700, true),
      plain: e.eli5?.text ? cleanText(e.eli5.text, 400, true) : ''
    }
    const material = `${record.title} ${record.summary}`
    const titleKey = normWords(record.title).join(' ')
    if (titleKey && titles.has(titleKey)) continue
    if (out.some(r => nearDuplicate(`${r.title} ${r.summary}`, material))) continue
    titles.add(titleKey)
    out.push(record)
  }
  return out
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
// Changes that say the same thing are listed once (see digestibleMaterial),
// which is why the first line also states how many there are.
export function rollupInput (day, entries = []) {
  return formatRollupInput(day, digestibleMaterial(entries))
}

function formatRollupInput (day, material) {
  const lines = [`Day: ${day} (UTC), ${material.length} change${material.length === 1 ? '' : 's'}`]
  for (const r of material) {
    lines.push('', `- ${r.flags.length ? `[${r.flags.join(', ')}] ` : ''}${r.title}`)
    lines.push(`  ${r.summary}`)
    if (r.plain) lines.push(`  Plain English: ${r.plain}`)
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
- One bullet per change, and one change per bullet. The first line of the material says how many changes there are; never write more bullets than that, and never write two bullets about the same change -- not with different words, not with a different lead verb. If you notice yourself repeating a change, keep the better of the two.
- If the same change appears twice in the material, it is one change listed twice: write it once.
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

// Shape rules plus de-duplication: a model that answers prose, an empty list,
// or a bullet full of internal identifiers fails here (and callLlm re-asks once)
// instead of putting machine text on a day page -- and a model that says the
// same change twice, in two different sentences, keeps only the first. The
// comparison is the deterministic one in nearDuplicate; exact equality was
// never enough, because a restatement changes its punctuation and its verbs.
//
// `limit` is the number of changes in the material (capped at
// ROLLUP_MAX_BULLETS): more bullets than changes means some of them are the
// same change in disguise, and the extra ones are dropped rather than shipped.
export function validateRollupOut (out, { limit = ROLLUP_MAX_BULLETS } = {}) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.bullets)) throw new Error('rollup output missing a bullets array')
  const max = Math.max(1, Math.min(ROLLUP_MAX_BULLETS, Number(limit) || ROLLUP_MAX_BULLETS))
  const bullets = []
  for (const raw of out.bullets) {
    if (typeof raw !== 'string') continue
    let b = cleanText(raw, ROLLUP_BULLET_CHARS + 80, true).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim()
    if (!b) continue
    if (!/[.!?]$/.test(b)) b += '.'
    if (b.length > ROLLUP_BULLET_CHARS + 40) continue
    if (BULLET_REJECT.some(re => re.test(b))) continue
    if (camelIdentifiers(b).length) continue
    // The same change restated twice reads as padding and ships even when both
    // records are real (a bump row and its member row, or a change the model
    // found worth two bullets).
    if (bullets.some(prev => nearDuplicate(prev, b))) continue
    bullets.push(b)
    if (bullets.length >= max) break
  }
  if (!bullets.length) throw new Error('rollup output had no usable bullets')
  return { bullets }
}

// ---------------------------------------------------------------------------
// The second opinion: a reader's de-duplication.
//
// The rules above catch a restatement that keeps its words. The failure that
// actually ships keeps none of them: "Added in-flight sweep and per-project
// state files so a sponsored run that dies before a terminal report is marked
// failed" next to "Added launch-time sweep recovery for sponsored runs that did
// not write a terminal report" are one change written twice, and they share
// four words out of sixteen. No word-overlap threshold separates that pair from
// two genuinely different changes -- push the threshold down and "dark mode"
// merges with "light mode"; push it up and every real duplicate survives.
//
// So one small call does what a reader does: it is handed the bullet list and
// asked which bullets restate a change an earlier bullet already covers. It
// costs one request per digest (the stage's plan allows 500 an hour), and it is
// strictly optional: when it cannot answer -- a provider outage, a refusal, a
// malformed reply -- the rule-based list ships unchanged, because a digest with
// a duplicate in it is better than no digest at all.
export const ROLLUP_DEDUPE_V = 1

export function buildRollupDedupePrompt (bullets = [], changes = 0) {
  return `You are the last check on the bullet list at the top of one day's changelog page. It was written from that day's ${changes} change${changes === 1 ? '' : 's'}, and every bullet is supposed to be about a different change. A reader must never be shown one change twice, however differently the two sentences put it.

Mark every bullet that says the same thing as an EARLIER bullet in the list. Keep every bullet that is about something no earlier bullet covers, and when you cannot tell whether two bullets describe the same change, keep both: an unnecessary bullet is a small cost, a missing change is a hole in the whole day.
${changes ? `There are ${changes} changes, so at most ${changes} of these bullets can be about different changes.\n` : ''}
Return JSON only, no prose and no code fences: {"drop":[2,5]} with the numbers of the bullets to remove (1-based, unique, ascending, and never all of them).

Bullets:
${bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}
`
}

// Shape rules for the duplicate check: integers in range, no repeats, and never
// an answer that empties the list. A bad answer fails here (and callLlm re-asks
// once) rather than silently deleting the day's digest.
export function validateDedupeOut (out, count) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.drop)) throw new Error('duplicate-check output missing a drop array')
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const seen = new Set()
  const drop = []
  for (const raw of out.drop) {
    const i = Number(raw)
    if (!Number.isInteger(i) || i < 1 || i > n || seen.has(i)) continue
    seen.add(i)
    drop.push(i)
  }
  if (drop.length >= n) throw new Error('duplicate-check wanted to drop every bullet')
  return { drop: drop.sort((a, b) => a - b) }
}

/**
 * Remove restatements from a rule-filtered bullet list, in one model call.
 * Returns the bullets, how many this check removed, and where the verdict came
 * from (`model`, or `rules` when the check was skipped or could not answer).
 * `call` is injectable so the behaviour is testable without a gateway.
 */
export async function dedupeBullets (bullets = [], { changes = 0, env = process.env, call = callScopedLlm } = {}) {
  const ruleBased = { bullets, dropped: 0, source: 'rules' }
  // Fewer than three and there is nothing to choose between; the operator can
  // also turn the paid check off (CHANGELOG_ROLLUP_DEDUPE=0).
  if (bullets.length < 3 || env.CHANGELOG_ROLLUP_DEDUPE === '0') return ruleBased
  try {
    const prompt = buildRollupDedupePrompt(bullets, changes)
    const { out } = await call(prompt, env, o => validateDedupeOut(o, bullets.length), { stage: 'day-rollup-dedupe' })
    const drop = new Set(out.drop)
    const kept = bullets.filter((_, i) => !drop.has(i + 1))
    if (!kept.length) return ruleBased
    return { bullets: kept, dropped: bullets.length - kept.length, source: 'model' }
  } catch (err) {
    log(`[rollup] duplicate check unavailable (${shortError(err)}): shipping the rule-based list`)
    return ruleBased
  }
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
 * Write one day's digest: one model call over the day's verified records, then
 * one small one that reads the answer as a reader would (see dedupeBullets).
 * The answer is stored with the model that served it, the provider that served
 * it and the fingerprint of the input, so the next cycle can tell current from
 * stale without diffing prose, and a digest written by a different provider
 * can be told apart without remembering which run wrote it.
 *
 * The material is de-duplicated first and the answer is held to the number of
 * changes it was given: a model asked about 6 changes may not return 12 bullets,
 * and two bullets about one change are one bullet. `dropped` records how many
 * of the model's bullets did not ship, for whatever reason.
 */
export async function generateRollup (day, entries, { dataDir, env = process.env } = {}) {
  const material = digestibleMaterial(entries)
  if (!material.length) throw new Error('day has no digestible changes')
  const input = formatRollupInput(day, material)
  const prompt = buildRollupPrompt(day, input)
  // A stage with its own provider writes there and only there; without one this
  // is the entry pipeline's route, exactly as before.
  const routeEnv = rollupLlmEnv(env) || env
  const limit = Math.min(ROLLUP_MAX_BULLETS, material.length)
  let rawCount = 0
  const { out, requests } = await callScopedLlm(prompt, routeEnv, o => {
    rawCount = Array.isArray(o?.bullets) ? o.bullets.length : 0
    return validateRollupOut(o, { limit })
  }, { stage: 'day-rollup' })
  const deduped = await dedupeBullets(out.bullets, { changes: material.length, env: routeEnv })
  if (deduped.dropped) log(`[rollup] ${day}: duplicate check dropped ${deduped.dropped} restated bullet(s)`)
  const rollup = {
    day,
    v: ROLLUP_V,
    at: new Date().toISOString(),
    source: shortHash(input),
    model: servedModelOf(requests, routeEnv.LLM_MODEL || DEFAULT_LLM_MODEL),
    provider: routeEnv.LLM_API_BASE || DEFAULT_LLM_API_BASE,
    dropped: Math.max(0, rawCount - deduped.bullets.length),
    bullets: deduped.bullets
  }
  await saveRollup(dataDir, rollup)
  return rollup
}
