// generator/lib/guide.mjs - the part of the guide that is WRITTEN.
//
// facets.mjs compiles the facts. This writes the prose that makes them
// readable, under one rule: the model may only explain the fact set it is
// given, never extend it. So every sentence is checked against that set before
// it is stored, and a passage that names something the facts do not contain is
// rejected rather than published.
//
// The three things that make a self-writing document safe to leave running:
//
//   * A CLOSED WORLD. The prompt contains one facet's compiled items and the
//     commits behind them, and nothing else. The model chooses how to explain,
//     never what to include -- inclusion is the replay's job, and it is
//     deterministic. There is no free-form fact slot to hallucinate into.
//
//   * A FACT HASH, NOT A PROMPT HASH. The cache key is the facet's content
//     hash, so a new model-catalog row rewrites the model paragraph and leaves
//     the other four alone. A guide that regenerated in full would cost five
//     calls a cycle forever; this costs one when one thing changed, and zero
//     when nothing did.
//
//   * THE CURATED SET IS WHAT GETS WRITTEN ABOUT. The public API facet replays
//     to 3,906 live symbols; handing that to the model produces a paragraph
//     about volume. It gets the headline instead -- retirements and
//     supersession chains -- plus the counts, so the prose is about what a
//     person would want to know and the page below still carries the full list.
//
// Coverage travels with the prompt. A facet built from 20 of 7,864 rows is told
// so, which is what lets the paragraph say "as far as the recorded catalog
// changes go" instead of implying the list is exhaustive.

import { readJson, writeJson, log, shortHash } from './util.mjs'
import { mergeAnswerCache } from './mergedata.mjs'
import { callLlm, ungroundedIdentifiers, LLM_REFUSAL_RE } from './llm.mjs'
import { buildGuide } from './facets.mjs'

// Bumping this re-asks every facet once, like PROMPT_V does for summaries.
export const GUIDE_PROMPT_V = 1
export const GUIDE_MAX_CHARS = 900
const GUIDE_CACHE = 'guide.json'

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// Everything a passage is allowed to name: the keys, their current values, and
// the words the commits behind them used. A model that says "GLM 5.3 Flash is
// the default" is grounded only if the facts or a commit title say so.
export function facetCorpus (facet) {
  // The coverage counts and the note are facts the prompt states, so they are
  // part of the closed world: a passage is supposed to be able to say "across
  // the 9 recorded changes", and the grounding check rejected exactly that
  // until the numbers were in here.
  const parts = [facet.label, facet.question, facet.note,
    String(facet.coverage?.rows ?? ''), String(facet.coverage?.of ?? ''), String(facet.coverage?.pct ?? ''),
    String(facet.live ?? ''), String(facet.total ?? ''),
    String(facet.items.filter(i => i.status === 'retired').length), String(facet.items.filter(i => i.status === 'live').length)]
  for (const it of facet.items) {
    parts.push(it.key, it.label, it.detail || '')
    for (const e of it.events) parts.push(e.title || '', e.day || '')
  }
  for (const it of facet.headline || []) parts.push(it.key, it.label, it.detail || '')
  return parts.filter(Boolean).join('\n')
}

// Counting names is half the problem. The other half is a passage making a
// QUALITATIVE claim the facts contradict, and the first draft of the config
// section did exactly that: it wrote that settings "were retired and later
// reintroduced" for a facet whose replay has 401 items and zero retirements.
// No identifier was invented, so the grounding check passed it.
//
// These are the claims the compiled state can actually refute, checked against
// the counts rather than against a word list. An indefinite quantifier is what
// makes them assertions: "no commands have been removed" states the opposite
// and must survive, "several were retired" claims some were.
const INDEFINITE = '(?:some|several|a number of|many|most|various|a few|certain|multiple|numerous|some of|any of)'
const GONE_WORDS = '(?:retired|removed|no longer present|no longer available|discontinued|dropped|gone|withdrawn|taken out)'
const HERE_WORDS = '(?:currently|in the (?:catalog|list|surface|set) now|still present|available today|live)'
const CHANGED_WORDS = '(?:changed|re-tiered|retiered|had its access|changed tier|access tier changed)'
const NEGATION = /(?:no longer|not|n't|never|without|nothing|none|neither|nor)\s*[\w\s]{0,18}$/i

// True when `words` appears in `win` as an assertion rather than inside a
// negation. "no longer present" must not read as "present"; that single missing
// guard is the difference between a check that works and one that fires on
// every correctly-hedged sentence.
function asserts (win, words) {
  for (const m of win.matchAll(new RegExp(words, 'gi'))) {
    if (!NEGATION.test(win.slice(0, m.index))) return true
  }
  return false
}

export function facetContradictions (facet, text) {
  const t = String(text || '')
  const out = []
  // The `i` is load-bearing: the first version of this check had no flags, so
  // a passage opening "A number of configurations were retired" slipped through
  // the exact case the check was written for.
  const re = (body) => new RegExp(body, 'i')
  const retired = facet.items.filter(i => i.status === 'retired').length
  const live = facet.items.filter(i => i.status === 'live').length
  const changed = facet.items.filter(i => i.events.some(e => e.kind === 'changed')).length
  if (retired === 0 && re(`${INDEFINITE}[^.;]{0,60}${GONE_WORDS}|${GONE_WORDS}[^.;]{0,40}${INDEFINITE}`).test(t)) {
    out.push(`the passage says ${facet.noun}s were removed, but the replay has none`)
  }
  if (live === 0 && re(`${INDEFINITE}[^.;]{0,60}${HERE_WORDS}`).test(t)) {
    out.push(`the passage says ${facet.noun}s are present, but the replay has none`)
  }
  if (changed === 0 && re(`${INDEFINITE}[^.;]{0,60}${CHANGED_WORDS}|${CHANGED_WORDS}[^.;]{0,40}${INDEFINITE}`).test(t)) {
    out.push(`the passage says a ${facet.noun}'s details changed, but no recorded event records a value change`)
  }
  // Per-item status, not just per-facet counts. A passage that calls a retired
  // item live, or a live one gone, is wrong in a way no count reveals.
  //
  // Windows around the key, not clause splitting: "MiMo 2.5" contains a period,
  // so a clause split on punctuation cut the key in half and the check never
  // saw it. And every assertion is tested for a negation in front of it, so
  // "no longer present" reads as absence rather than presence.
  for (const it of facet.items) {
    if (!it.key || it.key.length < 3) continue
    const keyRe = new RegExp(it.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    for (const m of t.matchAll(keyRe)) {
      const win = t.slice(Math.max(0, m.index - 70), m.index + it.key.length + 70)
      if (asserts(win, GONE_WORDS) && it.status === 'live') { out.push(`"${it.key}" is called gone, but the replay has it present`); break }
      if (asserts(win, `${HERE_WORDS}|\\bpresent\\b|\\bavailable\\b|\\boffered\\b|\\bin the (?:picker|catalog|CLI)\\b`) && it.status === 'retired') {
        out.push(`"${it.key}" is called present, but the replay has it retired`); break
      }
    }
  }
  // A hash in prose means the passage is narrating the table instead of
  // summarising it, which is the failure the reshaped fact notes were meant to
  // prevent; worth rejecting so it cannot creep back.
  if (/\b[0-9a-f]{7,40}\b/.test(t)) out.push('the passage quotes a commit hash')
  return out
}

// Numbers, in digits or in words, must exist in the fact set. A config section
// once wrote "Forty-one ... including the 401 currently present settings" in one
// sentence: the 401 was grounded, the forty-one was not, and reading it
// side by side is a coin flip. The corpus holds digits, so the words are the
// hole, and this closes it.
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000
}
const HYPHEN_NUM = /^(\w+)[- ](\w+)$/
// The words of a text, hyphen-aware. "forty-one" is ONE token, so wordNumber
// can reassemble it; a scan that split on the hyphen first would have to guess.
const NUM_WORDS = (text) => String(text).toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || []

const TENS = new Set(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'])
const UNITS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'])

function wordNumber (phrase) {
  const parts = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean)
  // Object.hasOwn, never `in`. A plain-object literal inherits from
  // Object.prototype, so `in` said yes to "constructor", "toString" and
  // "valueOf" and wordNumber returned the *function* instead of a number --
  // which then failed every comparison in the caller and was reported as an
  // ungrounded number, throwing away a correct answer that happened to say
  // "the constructor". Every other word was fine.
  if (!parts.length || parts.some(p => !Object.hasOwn(NUMBER_WORDS, p))) return null
  if (parts.length === 1) return NUMBER_WORDS[parts[0]]
  // "forty-one" is the case this exists for: a compound of a ten and a unit.
  if (parts.length === 2 && TENS.has(parts[0]) && UNITS.has(parts[1])) {
    return NUMBER_WORDS[parts[0]] + NUMBER_WORDS[parts[1]]
  }
  if (parts.length === 2 && /hundred|thousand/.test(parts[1])) {
    return NUMBER_WORDS[parts[0]] * NUMBER_WORDS[parts[1]]
  }
  if (parts.length === 3 && /hundred/.test(parts[1])) {
    return NUMBER_WORDS[parts[0]] * 100 + NUMBER_WORDS[parts[2]]
  }
  return null
}

export function ungroundedNumbers (text, corpus) {
  const have = new Set((String(corpus).match(/\d+/g) || []).map(Number))
  const out = []
  const seen = new Set()
  for (const m of String(text).matchAll(/\b(\d{1,7})\b/g)) {
    const n = Number(m[1])
    if (!have.has(n) && !seen.has(n)) { seen.add(n); out.push(m[1]) }
  }
  // Every 1-to-3-word window, not one greedy regex match. The first version
  // used a single `matchAll` with a greedy 3-word group, which swallowed the
  // compound along with the word after it -- "Forty-one sections" matched as
  // one phrase, wordNumber returned null, and the very bug this function was
  // written for passed. Windows are built explicitly so every span is tested.
  const words = NUM_WORDS(text)
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= 3 && i + len <= words.length; len++) {
      const phrase = words.slice(i, i + len).join(' ')
      const n = wordNumber(phrase)
      if (n == null) continue
      if (len === 1 && !words[i].includes('-')) {
        // A bare word is a count only from three to nineteen. Below that it is
        // an article or a pronoun ("one of the commands", "no one"), and
        // rejecting correct prose on nearly every passage is its own bug. From
        // twenty up it is a multiplier, always part of a longer number that the
        // two- and three-word windows have already tested -- which is why
        // "twenty one" is checked and the "twenty" inside it is not.
        if (n < 3 || n >= 20) continue
      }
      // A hyphenated single token is always a whole number, which is the case
      // this function exists for: "forty-one" must be read as 41, not skipped
      // as a multiplier and not shredded into two words.
      if (!have.has(n) && !seen.has(n)) { seen.add(n); out.push(phrase) }
    }
  }
  return out
}

// The closed world the model is shown. Small facets are listed in full, because
// a section that says "the reference list does not name them" is a section about
// the prompt rather than about the product -- which is exactly what the first
// version produced for slash commands, where all 7 live items had been
// collapsed to a count. Large facets fall back to the headline plus counts, so
// 3,906 exported symbols do not become a paragraph about volume.
const FULL_LIST_MAX = 40

// The facts, in a shape worth reading. The first version handed over log lines
// with a `commits:` field, and every draft then narrated the hashes back
// ("DeepSeek V4.1 Flash (0cbff57a) replacing...") -- the model was echoing the
// shape it was given. Hashes belong in the table under the text, not in prose.
function factLines (items) {
  return items.map((it) => {
    const chain = it.events.slice().reverse().map(e => e.kind)
    const since = it.first?.day && it.first.day === it.last?.day
      ? it.last.day
      : `${it.first?.day || '?'} to ${it.last?.day || '?'}`
    return `- ${it.key}${it.detail ? ` (${it.detail})` : ''}: ${it.status === 'retired' ? 'no longer present' : 'present'}, ${chain.length > 1 ? `${chain.join(' then ')}` : chain[0]}, ${since}`
  })
}

export function buildFacetBriefing (facet, { asOf = '', totalRows = 0 } = {}) {
  const live = facet.items.filter(i => i.status === 'live')
  const retired = facet.items.filter(i => i.status === 'retired')
  const full = facet.items.length <= FULL_LIST_MAX
  const shown = full ? facet.items : (facet.headline || []).slice(0, 16)
  const shownLive = shown.filter(i => i.status === 'live')
  const shownRetired = shown.filter(i => i.status === 'retired')
  return [
    `You are writing the opening paragraph of one section of an internal reference page that Freebuff staff use to track how the product has changed. Today is ${asOf || 'unknown'}.`,
    '',
    `SECTION: ${facet.label}`,
    `THE QUESTION IT ANSWERS: ${facet.question}`,
    '',
    'The notes below were compiled by replaying the change log. They are the only material you may use:',
    `Present now (${live.length} in total):`,
    ...factLines(shownLive),
    live.length > shownLive.length ? `- ...and ${live.length - shownLive.length} more that are still present` : '',
    `No longer present (${retired.length} in total):`,
    ...(shownRetired.length ? factLines(shownRetired) : ['- none recorded']),
    retired.length > shownRetired.length ? `- ...and ${retired.length - shownRetired.length} more that are gone` : '',
    '',
    `These notes come from ${facet.coverage.rows} of ${totalRows} tracked changes (${facet.coverage.pct}%). ${facet.note}`,
    '',
    'Write 2-3 sentences for a colleague who already knows the product. Give them the read, not the inventory: what the state of this area is now, what moved recently, and anything notable enough to act on (a replacement, a reversal, a retirement, something that came back).',
    '',
    'Rules:',
    '- Never mention a commit hash, a sha, or a line from these notes. That is what the table below your paragraph is for.',
    '- Do not enumerate. Naming three or four things to make a point is fine; listing all of them is not.',
    '- Use only the notes. If they do not establish something, leave it out rather than reasoning toward it.',
    '- Quote only the counts that appear above, exactly. Never spell a number differently ("forty-one" for 401), never estimate, never round.',
    `- Do not claim something was removed, added or changed unless the notes show at least one. If a list says "none recorded", you may say nothing was removed, and nothing else.`,
    '- If a thing was replaced by another, say which replaced which. If the notes do not say, do not guess.',
    '- The coverage is small, so hedge in a short clause ("across the N recorded changes") rather than implying the picture is complete.',
    '- Write about the product. Never mention the notes, the list, this section, the page, or what you were given.',
    '- No marketing, no superlatives. No em-dashes; use commas or parentheses. No preamble: start with the fact.',
    '',
    'Reply with JSON only: {"briefing": "..."}'
  ].filter(Boolean).join('\n')
}

// The passage must be about Freebuff, not about the material it was written
// from. Caught as a rejection rule rather than a hope: the first draft of the
// command section spent two of its four sentences on the list's shortcomings.
const META_RE = /\b(?:the (?:list|fact set|fact-set|section|page|table|above|input|data|record|records)(?: above)?|this (?:section|page|list)|these (?:facts|entries|items|rows)|as (?:given|provided|shown|listed)|per the (?:list|facts)|not (?:shown|listed|named) individually)\b/i

export function validateBriefing (out, facet) {
  const text = clean(typeof out === 'string' ? out : out?.briefing)
  if (!text) throw new Error('guide briefing is empty')
  if (LLM_REFUSAL_RE.test(text)) throw new Error('guide briefing came back as a refusal')
  if (text.length > GUIDE_MAX_CHARS) throw new Error(`guide briefing is ${text.length} chars, over the ${GUIDE_MAX_CHARS} cap`)
  if (META_RE.test(text)) throw new Error('guide briefing describes its own source material instead of the product')
  const corpus = facetCorpus(facet)
  const bad = ungroundedIdentifiers(text, corpus)
  if (bad.length) throw new Error(`guide briefing names identifiers outside the fact set: ${bad.slice(0, 6).join(', ')}`)
  const nums = ungroundedNumbers(text, corpus)
  if (nums.length) throw new Error(`guide briefing quotes numbers the fact set does not contain: ${nums.slice(0, 6).join(', ')}`)
  const wrong = facetContradictions(facet, text)
  if (wrong.length) throw new Error(`guide briefing contradicts the compiled facts: ${wrong.join('; ')}`)
  return text
}

export function guideCacheKey (facet, model) {
  return `guide:${facet.id}:${facet.hash}:v${GUIDE_PROMPT_V}:${shortHash(model || '')}`
}

// One model for the whole guide, unlike the per-entry routing the summary pass
// uses. A section that changed models mid-document reads as two authors, and
// there is no per-row priority signal here worth splitting on: the model is in
// the key, so changing it re-asks every section exactly once.
const guideModel = (env) => env.LLM_MODEL || 'gpt-4o-mini'

// Write the guide's prose. One call per facet whose facts moved, zero for the
// rest. `guide.json` is a cache in the same shape as ai-summaries.json, so the
// relay's existing merge rules keep two writers from losing each other's work.
export async function writeGuide (entries, dataDir, env = process.env, options = {}) {
  const path = `${dataDir}/${GUIDE_CACHE}`
  const cache = await readJson(path, {})
  const guide = options.guide || buildGuide(entries)
  const models = {}
  let calls = 0
  let reused = 0
  let failed = 0
  for (const facet of guide.facets) {
    const model = guideModel(env)
    const key = guideCacheKey(facet, model)
    models[facet.id] = key
    const hit = cache[key]
    if (hit && !hit.error && options.force !== true) { reused++; continue }
    if (hit?.error && !options.retryErrors) { failed++; continue }
    const prompt = buildFacetBriefing(facet, { asOf: guide.asOf, totalRows: guide.totalRows })
    try {
      const text = await callLlm(prompt, { ...env, LLM_MODEL: model }, 1, (out) => validateBriefing(out, facet))
      cache[key] = { text, model, v: GUIDE_PROMPT_V, facet: facet.id, hash: facet.hash, at: new Date().toISOString() }
      calls++
      log(`guide wrote the ${facet.id} section (${facet.coverage.pct}% coverage, ${facet.items.length} items)`)
    } catch (err) {
      // Parked, not retried in-line: the same facts and the same prompt fail
      // the same way, and burning three attempts per cycle on one bad section
      // is how a backfill turns into an outage.
      cache[key] = { error: String(err.message || err).slice(0, 200), facet: facet.id, hash: facet.hash, at: new Date().toISOString() }
      failed++
      log(`guide could not write the ${facet.id} section: ${String(err.message || err).slice(0, 120)}`)
    }
  }
  // Drop entries for sections that no longer exist or whose facts moved on, so
  // the file cannot grow without bound as the hash changes.
  const keep = new Set(Object.values(models))
  for (const k of Object.keys(cache)) if (k.startsWith('guide:') && !keep.has(k)) delete cache[k]
  if (calls || failed) {
    const merged = mergeAnswerCache(await readJson(path, {}), cache)
    await writeJson(path, merged)
  }
  return { calls, reused, failed, models }
}

// Read the stored prose back for a facet, or null. The site build is offline,
// so it renders whatever is cached and says plainly when a section has none.
export async function loadGuideProse (dataDir) {
  const cache = await readJson(`${dataDir}/${GUIDE_CACHE}`, {})
  const out = {}
  for (const [k, v] of Object.entries(cache)) {
    if (!k.startsWith('guide:') || v?.error || !v.facet) continue
    // Newest write per facet wins if a hash ever leaves two entries behind.
    if (!out[v.facet] || (v.at || '') > (out[v.facet].at || '')) out[v.facet] = v
  }
  return out
}
