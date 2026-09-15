// generator/lib/llm.mjs - optional AI rewrite layer.
//
// Deterministic analysis already produces accurate entries; this layer makes
// them *readable*. It is strictly enrichment: per-commit results are cached in
// data/ai-summaries.json keyed by commit sha + prompt version + patch hash,
// so prompt edits invalidate stale entries (they re-summarize once). If no
// provider is configured, everything still works with deterministic summaries.
//
// Config (env):
//   CHANGELOG_LLM=1            enable
//   LLM_API_KEY                bearer key (or GitHub Models PAT: ghp_...)
//   LLM_API_BASE               default https://api.github.com (GitHub Models,
//                              free tier; any OpenAI-compatible base works)
//   LLM_MODEL                  default github:gpt-4o-mini
//   CHANGELOG_LLM_LIMIT        max commits summarized per run (default 60; 0 = no cap)
//   CHANGELOG_LLM_CONCURRENCY  parallel API calls (default 5)
//   CHANGELOG_ELI5_LIMIT       plain-English pass budget (defaults to the above)
//   CHANGELOG_LLM_CHURN=1      also summarize lockfile/icon-only rows, from their
//                              raw diff (~1,900 extra calls)
//   CHANGELOG_LLM_ERROR_COOLDOWN_MS  retry failed entries after this (default 3600000)
//   CHANGELOG_LLM_TRANSIENT_RETRY_MS  ...but gateway blips retry sooner (default 300000)
//   options.priorityShas       SHAs to summarize ahead of the backlog
import { readJson, writeJson, log, pool, shortHash, eli5Source } from './util.mjs'
import { mergeAiCache } from './mergedata.mjs'
import { extractCommentFacts } from './analyze.mjs'

export function llmConfigured (env = process.env) {
  return env.CHANGELOG_LLM === '1' && !!env.LLM_API_KEY
}

// Bump when buildPrompt changes so stale entries re-summarize exactly once.
export const PROMPT_V = 5

export function firstSentence (s) {
  const m = String(s || '').trim().match(/^[^.?!]+[.?!]/)
  return (m ? m[0] : String(s || '').trim()).trim()
}

function patchHash (patch) {
  return shortHash(patch)
}

export function cacheKey (sha, patch) {
  return `${sha}:v${PROMPT_V}:${patchHash(patch)}`
}

// Word-boundary cut: never slice mid-word or mid-token.
export function truncateWords (s, n) {
  s = String(s || '').trim()
  if (s.length <= n) return s
  const cut = s.lastIndexOf(' ', n)
  return (cut > n * 0.5 ? s.slice(0, cut) : s.slice(0, n)).trim()
}

// Per-file budget: split on file boundaries, cap each file, keep order.
// Head hunks (what changed) survive; tail overflow drops with a marker.
// Better than a flat slice, which silently drops whole trailing files.
export function budgetPatch (patch, maxBytes = 12000, perFile = 3000) {
  const parts = String(patch || '').split(/(?=^diff --git )/m)
  if (parts.length <= 1) {
    return patch.length > maxBytes
      ? patch.slice(0, maxBytes) + '\n…[truncated: full diff on GitHub]…\n'
      : patch
  }
  const out = []
  let used = 0
  for (const p of parts) {
    if (used >= maxBytes) { out.push('\n…[remaining files truncated: full diff on GitHub]…\n'); break }
    const room = Math.min(perFile, maxBytes - used)
    out.push(p.length > room ? p.slice(0, room) + '\n…[file truncated]…\n' : p)
    used += Math.min(p.length, room)
  }
  return out.join('')
}

export function buildPrompt (entry, patch) {
  const lines = [
    'You write changelog entries for Freebuff, a free AI coding agent. Your reader is a TECHNICAL user: a developer who uses Freebuff daily and reads diffs.',
    'Rules: use ONLY facts from the diff and the analysis notes below. Never invent file names, features, or versions.',
    'Title: plain text, max 70 chars, no backticks, no markdown, no trailing period. Lead with the concrete change (model name, command with leading slash, version, subsystem).',
    'Summary shape (2-4 sentences, technical prose, backticks allowed for identifiers):',
    '1. WHAT changed, precisely: names, versions, commands, files. Lead with the user-visible change, then the mechanism.',
    '2. WHY it happened, grounded in the notes/diff (root cause, upstream failure, deprecation). If the reason is not visible, describe the mechanism instead — never invent motives.',
    '3. SCOPE: which packages/surfaces carry the change (core constants, CLI picker, Web/Desktop, docs). Name the files that matter.',
    '4. DETAIL: one concrete technical fact — migration behavior, trait/column change, alias, flag, or follow-up constraint. Never paste raw diff lines. Never write "Nothing to do" or any no-action boilerplate: if no action is needed, say nothing about action at all.',
    `Output a JSON object: {"title": "<plain title>", "summary": "<2-4 sentence summary>", "significance": "${entry.significance || 'minor'}"}.`,
    `Significance (deterministic default "${entry.significance || 'minor'}"): keep it unless the diff clearly contradicts it.`,
    'major = new feature, model added/removed, security, breaking. notable = user-visible behavior/UI change, new file, API change. minor = internal, refactor, types, comments, deps.',
    '',
    'GOOD (technical, precise, no boilerplate): "Muse Spark 1.2 replaces 1.3 in the free model picker after 1.3 began returning upstream 404 model_not_found errors. Saved 1.2 preferences migrate to 1.3 on load; existing live sessions keep running. Covers Web, CLI, and Desktop via FREEBUFF_MODELS plus README tables; 1.2 keeps its fast all-round row."',
    '',
    `Date: ${entry.date}`,
    `Category: ${entry.category || (entry.areas || []).join(', ')}`,
    `Areas: ${(entry.areas || []).join(', ')}`,
    `Stats: +${entry.stats?.additions ?? '?'} / -${entry.stats?.deletions ?? '?'}`,
    `Analysis notes: ${entry.summary}`
  ]
  if (entry.modelChanges) {
    lines.push(`Model catalog: +${entry.modelChanges.added.join(', ')} -${entry.modelChanges.removed.join(', ')}`)
    const tables = entry.modelChanges.tables || {}
    const rows = []
    for (const m of [...(entry.modelChanges.added || []), ...(entry.modelChanges.removed || [])]) {
      const row = tables[m]?.after || tables[m]?.before
      if (row) rows.push(`${m} [${row.slice(1).join(' · ') || row[0]}]`)
    }
    if (rows.length) lines.push(`Model rows (access + traits, use for DETAIL): ${rows.join(' | ')}`)
  }
  if (entry.cmdChanges) lines.push(`Slash commands: +${(entry.cmdChanges.added || []).join(', ')} -${(entry.cmdChanges.removed || []).join(', ')}`)
  if (entry.version) lines.push(`Version bump: ${entry.version}`)
  const files = [...(entry.files?.added || []), ...(entry.files?.modified || []).slice(0, 8)]
  if (files.length) lines.push(`Files: ${files.join(', ')}`)
  const facts = (entry.facts || []).slice(0, 5)
  if (facts.length) lines.push(`Key facts (ground the WHY and DETAIL sentences in these): ${facts.map(f => `- ${f}`).join(' ')}`)
  lines.push('', 'Diff (source hunks; lockfiles and pure test hunks omitted, except in a lockfile-only commit):', '```diff', budgetPatch(patch), '```')
  return lines.filter(Boolean).join('\n')
}

export function parseLlmJson (text) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('LLM returned no JSON')
  }
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1))
}

// Short one-line error for logs and cache: HTML error pages collapse to
// their HTTP status so a 522 tunnel outage logs one line, not a page.
export function shortError (err) {
  const msg = String(err?.message || err || '')
  const m = /LLM HTTP (\d+)/.exec(msg)
  if (m) return `LLM HTTP ${m[1]}`
  return msg.split('\n')[0].slice(0, 120)
}

// `validate` is a parameter because the ELI5 pass speaks to the same gateway
// with a different shape: the repair retry has to check the replacement against
// the schema that was asked for, not the summary one.
async function callLlm (prompt, env, attempt = 1, validate = validateLlmOut) {
  const base = env.LLM_API_BASE || 'https://api.openai.com/v1'
  const model = env.LLM_MODEL || 'gpt-4o-mini'
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(60000)
  })
  if (res.status === 429 && attempt <= 3) {
    // Honor Retry-After; fall back to exponential backoff.
    const waitMs = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt
    log(`LLM rate-limited (429): waiting ${(waitMs / 1000).toFixed(0)}s before retry ${attempt}/3`)
    await new Promise(r => setTimeout(r, Math.min(waitMs, 30000)))
    return callLlm(prompt, env, attempt + 1)
  }
  // 5xx gateways (tunnel 522s included): one delayed retry, then a short error.
  if (res.status >= 500 && res.status <= 599 && attempt === 1) {
    await new Promise(r => setTimeout(r, 5000))
    return callLlm(prompt, env, attempt + 1)
  }
  if (!res.ok) throw new Error(shortError(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`))
  const rawText = await res.text()
  const data = parseLlmJson(rawText)
  const text = data.choices?.[0]?.message?.content ?? ''
  try {
    return validate(parseLlmJson(text))
  } catch (err) {
    if (attempt > 2) throw err
    // One repair pass: ask for valid JSON only, no new analysis.
    log(`LLM output invalid (${err.message}): requesting repair ${attempt}/2`)
    const fixed = await callLlm(`${prompt}\n\nPrevious output was invalid JSON: ${String(text).slice(0, 500)}\nReply with ONLY the corrected JSON object.`, env, attempt + 1, validate)
    return validate(fixed)
  }
}

// Schema gate: titles render via esc() so markdown would show literally;
// strip it here. No-action boilerplate ("Nothing to do", "no action
// needed") is rejected for one repair pass. Significance falls back to
// the deterministic default.
const NOACTION_RE = /nothing to do|no action (is )?needed|no changes? required|you don'?t need to do anything/i

export function validateLlmOut (out, fallbackSig = 'minor') {
  if (!out || typeof out !== 'object') throw new Error('LLM output not an object')
  const rawTitle = String(out.title || '').trim()
  if (!rawTitle) throw new Error('LLM output missing title')
  const title = truncateWords(rawTitle.replace(/[`*#_[\]]/g, '').replace(/\s+/g, ' '), 70)
  const rawSummary = String(out.summary || '').trim()
  if (!rawSummary) throw new Error('LLM output missing summary')
  if (NOACTION_RE.test(rawSummary)) {
    throw new Error('LLM summary contains no-action boilerplate')
  }
  const summary = truncateWords(rawSummary, 1200)
  const significance = ['minor', 'notable', 'major'].includes(out.significance) ? out.significance : fallbackSig
  return { title, summary, significance }
}

export function isTransientError (err) {
  const msg = String(err?.message || err || '')
  // Any 5xx from the gateway family, not just the canonical 502/503/504: the
  // endpoint sits behind a cloudflared tunnel, and 530 (tunnel error) plus
  // 521/522/523/524/525/526/527 were all being recorded as *permanent* hour-long
  // failures for what is a second-long blip. Anchored on "HTTP 5xx" so an error
  // text that merely contains those digits cannot misclassify; 4xx (400, 429)
  // stays a real failure and keeps the long cooldown.
  return /fetch failed|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|terminated|HTTP 5\d\d|timeout/i.test(msg)
}

export async function enrichWithLlm (entries, getPatch, dataDir, env = process.env, options = {}) {
  if (!llmConfigured(env)) return 0
  const cachePath = `${dataDir}/ai-summaries.json`
  const cache = await readJson(cachePath, {})
  // `0` means "no cap", which is how a full backfill runs; the daemon's
  // per-cycle budget stays a small number so a fresh commit never queues behind
  // history. An unset or empty value keeps the historical default of 60.
  const rawLimit = env.CHANGELOG_LLM_LIMIT ? Number(env.CHANGELOG_LLM_LIMIT) : 60
  const limit = rawLimit > 0 ? rawLimit : Infinity
  const concurrency = Number(env.CHANGELOG_LLM_CONCURRENCY || 5)
  const errorCooldownMs = Number(env.CHANGELOG_LLM_ERROR_COOLDOWN_MS || 3600000)
  // A gateway blip (502/timeout) must not park a commit for an hour, but it
  // must park it *somehow*: an uncached transient failure re-entered the queue
  // every cycle and burned a call on it — c59bde7f retried at 3-minute
  // intervals for three cycles before succeeding.
  const transientRetryMs = Number(env.CHANGELOG_LLM_TRANSIENT_RETRY_MS || 300000)
  // SHAs this cycle's sync just added. Newest commits are the whole point of a
  // live changelog, so they queue ahead of the historical backlog.
  const priority = options.priorityShas instanceof Set ? options.priorityShas : new Set(options.priorityShas || [])
  let apiCalls = 0
  let cacheModified = false

  // User-visible work first: this cycle's fresh commits, then models, releases,
  // commands — then newest, then churn last. Recency-only ordering buried a model
  // swap behind dozens of minors.
  const prio = (e) => (priority.has(e.sha) ? -1 : e.modelChanges ? 0 : e.version ? 1 : e.cmdChanges ? 2 : e.noise ? 4 : 3)
  // Every kind is queueable now. The sync-only filter this replaced is what capped
  // coverage at 913 of 9,527 entries: the 6,732 community commits have real
  // parent-to-commit diffs in the clone and were never sent anywhere. Churn rows
  // still stay out unless CHANGELOG_LLM_CHURN=1 -- their clean patch is empty by
  // construction (the lockfile *is* the change), so llmPatchFor returns nothing
  // and the queue skips them; the flag sends the raw lockfile diff instead.
  const churnQueue = env.CHANGELOG_LLM_CHURN === '1'
  const queueable = entries.filter(e => !e.noise || churnQueue)
  queueable.sort((a, b) => prio(a) - prio(b) || (a.date < b.date ? 1 : -1))

  // Fetch patches in parallel (git-bound, independent) before queueing.
  // Entries without a prompt version predate versioning: re-summarize once.
  const isCurrent = (e) => e.ai?.model && (e.ai?.v ?? 1) >= PROMPT_V
  // Bound the git work to what this run can spend. Diffing every unsummarized
  // entry to pick `limit` of them made cycle time grow with the backlog, which
  // delayed exactly the fresh entries the loop exists to publish. An uncapped run
  // still bounds the window, so one pass cannot spend an hour on `git diff`.
  const window = Number.isFinite(limit) ? Math.max(limit * 4, limit + 5) : 2000
  const candidates = []
  for (const e of queueable) {
    if (isCurrent(e)) continue
    candidates.push(e)
    if (candidates.length >= window) break
  }
  const patches = await pool(candidates.map(e => async () => {
    try { return await getPatch(e) } catch { return '' }
  }), 8)

  const queue = []
  for (let qi = 0; qi < candidates.length; qi++) {
    const e = candidates[qi]
    const patch = patches[qi]
    if (!patch) continue
    const key = cacheKey(e.sha, patch)
    const cached = cache[key]
    if (cached?.error) {
      // Failed entries cool down before retrying: a 60s watch loop must not
      // re-hit a failing endpoint on every cycle.
      if (!options.retryErrors) continue
      const failedAt = Date.parse(cached.at || '') || 0
      if (Date.now() - failedAt < (cached.transient ? transientRetryMs : errorCooldownMs)) continue
    }
    if (cached && !cached.error) {
      e.ai = { model: cache[key].model, v: cache[key].v, title: cache[key].title, summary: cache[key].summary, significance: cache[key].significance, at: cache[key].at }
      continue // Cache hit does not consume the API budget
    }
    queue.push({ entry: e, patch, key })
    if (queue.length >= limit) break
  }

  if (!queue.length) return 0

  let activeIndex = 0
  // Consecutive gateway failures trip the breaker: the tunnel is down,
  // stop burning calls this run. Tracked globally (not per worker) so 8
  // parallel workers cannot each log their own "offline" line.
  let gatewayFails = 0

  async function worker () {
    while (activeIndex < queue.length) {
      if (gatewayFails >= 3) break
      const idx = activeIndex++
      const { entry: e, patch, key } = queue[idx]
      try {
        const out = await callLlm(buildPrompt(e, patch), env)
        const clean = validateLlmOut(out, e.significance || 'minor')
        gatewayFails = 0
        cache[key] = {
          model: env.LLM_MODEL || 'gpt-4o-mini',
          v: PROMPT_V,
          title: clean.title,
          summary: clean.summary,
          significance: clean.significance,
          at: new Date().toISOString()
        }
        e.ai = { ...cache[key] }
        apiCalls++
        cacheModified = true
        log(`LLM summarized ${e.sha.slice(0, 8)} (${apiCalls}/${queue.length})`)
      } catch (err) {
        log(`LLM failed for ${e.sha.slice(0, 8)}: ${shortError(err)}`)
        const transient = isTransientError(err)
        if (transient) {
          // Record it, or this commit re-enters next cycle's queue and burns
          // another call on the same failure. One-shot callers (retryErrors
          // unset: the workflow's analyze pass) must not park it, since nobody
          // will come back for them — the daemon retries those.
          if (options.retryErrors) {
            cache[key] = { error: shortError(err).slice(0, 200), transient: true, at: new Date().toISOString() }
            cacheModified = true
          }
          gatewayFails++
          if (gatewayFails >= 3) {
            log('LLM endpoint appears offline (3 consecutive gateway errors): skipping rest of queue this run')
            break
          }
          continue
        }
        cache[key] = { error: shortError(err).slice(0, 200), at: new Date().toISOString() }
        cacheModified = true
      }
    }
  }

  const poolSize = Math.min(concurrency, queue.length)
  await Promise.all(Array.from({ length: poolSize }, () => worker()))

  if (cacheModified) {
    // Union with what landed on disk while these calls were in flight: the
    // cache is keyed by content, so another writer's keys are additive and
    // must not be dropped by this run's snapshot.
    await writeJson(cachePath, mergeAiCache(await readJson(cachePath, {}), cache))
  }
  return apiCalls
}

// ---------------------------------------------------------------------------
// ELI5: a plain-English line beneath each technical summary.
//
// A second pass on purpose, not extra fields in buildPrompt:
//   - its input is the summary, not the diff, so it costs no git work and a much
//     shorter prompt;
//   - adding it to the summary prompt means bumping PROMPT_V, which throws away
//     912 summaries the project already paid for;
//   - the wording of an ELI5 ask will want tuning, and rewording it must never
//     rewrite technical history. So it has its own version, its own keys in the
//     same cache file, and its own budget knobs.
// It re-runs by itself whenever the summary it describes changes, because the
// cache key hashes that summary and eli5Done() compares against it.
// v2: the prompt now carries the developers' own comments and forbids widening a
// named audience to "users". Every v1 line was written by a prompt that could only
// see the title and the summary, so all of them are re-explained once, through the
// same resumable budget (CHANGELOG_ELI5_LIMIT) rather than in one expensive pass.
export const ELI5_V = 2

// eli5Source() lives in util.mjs because the changelog merge has to recompute it
// to check a merged ELI5 against the summary that survived. Re-exported here as
// part of this module's contract: its hash is the cache key suffix and the
// entry's eli5.src, so a re-summarized entry drops a stale plain-English line.
export { eli5Source }

export function eli5Key (sha, source) {
  return `${sha}:eli5:v${ELI5_V}:${shortHash(source)}`
}

// Explainable = has a current technical summary. Churn rows have nothing to
// explain, and community rows are titled straight from their commit message and
// never went through the model.
export function eli5Eligible (e) {
  return !e.noise && !!e.ai?.title && !!e.ai?.summary && (e.ai?.v ?? 1) >= PROMPT_V
}

export function eli5Done (e) {
  return !!(e.eli5 && e.eli5.v >= ELI5_V && e.eli5.src === shortHash(eli5Source(e)))
}

export function buildEli5Prompt (e, notes = []) {
  const noteBlock = notes.length
    ? `\nComments the developers wrote beside this code. Read them: they say who this is for and what it does today, which the constant names do not.\n${notes.map(n => `- ${n}`).join('\n')}\n`
    : ''
  return `Explain one software change to a reader who is not a programmer and will not look at the code.

Date: ${e.day || ''}
Area: ${e.category || ''}
Title: ${e.ai.title}
Technical summary: ${e.ai.summary}
${noteBlock}
Write 1-3 sentences of plain English: what happened, and what it means for someone who just uses the product.

Rules:
- No jargon, acronyms, file names, function names, code or version numbers. Say what the thing does instead of what it is called ("the assistant can now use a new model", not "a provider adapter was wired up").
- Use only what the summary and the comments say. Never invent a cause, a number, or a promise.
- Keep the audience the text gives, and keep it narrow. If the change is for one kind of customer, one plan, one region, or only after some step, name that group. Never widen it to "users", "everyone" or "customers" because that reads more naturally: a program for verified YC companies is not available to users.
- If nothing happens for anyone yet (a constant, a flag, scaffolding ahead of a launch), say that plainly. Do not describe a future behavior as if it is live today.
- Plain words, active voice. No "This change", "We are excited", or marketing tone.
- If the change is small or internal, say so shortly. Do not inflate it.
- Never address the reader as a developer.

Reply with JSON only: {"eli5": "..."}`
}

// Non-answers worth parking: a whole reply that is "N/A", or one that opens with
// a refusal. Checked at the start of the sentence so a real explanation that
// happens to contain "cannot" is not thrown away.
const ELI5_JUNK = /^(n\/?a|none|not applicable|no comment|unknown)[.!]?$/i
const ELI5_REFUSAL = /^(i\s+ca(?:n'?t|nnot|'m unable)|we\s+ca(?:n'?t|nnot)|unable to|sorry|as an ai|i'?m (just|only|an)|no information)\b/i

export function normalizeEli5 (raw) {
  // callLlm hands the validator the parsed object; a bare-string reply is also
  // accepted because small models sometimes ignore the JSON envelope.
  const value = raw && typeof raw === 'object' ? (raw.eli5 ?? raw.text ?? '') : raw
  let s = String(value ?? '').trim()
  // Models like to restate the label they were given.
  s = s.replace(/^(ELI5|In plain English|Plain english)\s*[:–-]\s*/i, '').trim()
  s = s.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim()
  // The floor exists to catch non-answers, not to reject a terse but valid
  // sentence: "It is faster now." is 16 characters and exactly what this field
  // is for. A 25-character floor parked real answers as errors for an hour.
  if (s.length < 12 || ELI5_JUNK.test(s) || ELI5_REFUSAL.test(s)) {
    throw new Error(`eli5 not an answer: ${JSON.stringify(s).slice(0, 60)}`)
  }
  if (!/[.!?]$/.test(s)) s += '.'
  return truncateWords(s, 420)
}

export async function enrichEli5 (entries, dataDir, env = process.env, options = {}) {
  if (!llmConfigured(env) || env.CHANGELOG_ELI5 === '0') return 0
  const cachePath = `${dataDir}/ai-summaries.json`
  const cache = await readJson(cachePath, {})
  // Separate knobs so the initial fill can be run down faster than the summary
  // budget, without touching the pass that costs real diff tokens.
  const rawEli5Limit = env.CHANGELOG_ELI5_LIMIT || env.CHANGELOG_LLM_LIMIT
  const limit = rawEli5Limit && Number(rawEli5Limit) <= 0 ? Infinity : Number(rawEli5Limit || 20)
  const concurrency = Number(env.CHANGELOG_ELI5_CONCURRENCY || env.CHANGELOG_LLM_CONCURRENCY || 5)
  const errorCooldownMs = Number(env.CHANGELOG_LLM_ERROR_COOLDOWN_MS || 3600000)
  const transientRetryMs = Number(env.CHANGELOG_LLM_TRANSIENT_RETRY_MS || 300000)
  const priority = options.priorityShas instanceof Set ? options.priorityShas : new Set(options.priorityShas || [])
  // Same patch reader the summary pass uses, so the plain-English line can read the
  // comments the analysis pass may not have turned into facts.
  const getPatch = typeof options.getPatch === 'function' ? options.getPatch : null
  let apiCalls = 0
  let cacheModified = false

  const prio = (e) => (priority.has(e.sha) ? -1 : e.modelChanges ? 0 : e.version ? 1 : e.cmdChanges ? 2 : 3)
  const pending = entries.filter(eli5Eligible).filter(e => !eli5Done(e))
  pending.sort((a, b) => prio(a) - prio(b) || (a.date < b.date ? 1 : -1))
  // Same bound as the summary pass: choosing this run's dozen entries must not
  // mean hashing the whole backlog.
  const candidates = pending.slice(0, Number.isFinite(limit) ? Math.max(limit * 4, limit + 5) : 2000)

  const queue = []
  for (const e of candidates) {
    const src = eli5Source(e)
    const key = eli5Key(e.sha, src)
    const cached = cache[key]
    if (cached?.error) {
      if (!options.retryErrors) continue
      const failedAt = Date.parse(cached.at || '') || 0
      if (Date.now() - failedAt < (cached.transient ? transientRetryMs : errorCooldownMs)) continue
    }
    if (cached && !cached.error) {
      // A cache hit costs nothing but still has to land on the entry, or the
      // site renders no ELI5 line for it.
      e.eli5 = { text: cached.text, model: cached.model, v: cached.v, src: shortHash(src), at: cached.at }
      continue
    }
    queue.push({ entry: e, src, key })
    if (queue.length >= limit) break
  }

  if (!queue.length) return 0

  let activeIndex = 0
  let gatewayFails = 0

  async function worker () {
    while (activeIndex < queue.length) {
      if (gatewayFails >= 3) break
      const idx = activeIndex++
      const { entry: e, src, key } = queue[idx]
      try {
        const notes = await eli5Notes(e, getPatch)
        const out = await callLlm(buildEli5Prompt(e, notes), env, 1, normalizeEli5)
        gatewayFails = 0
        cache[key] = {
          model: env.LLM_MODEL || 'gpt-4o-mini',
          v: ELI5_V,
          text: out,
          at: new Date().toISOString()
        }
        e.eli5 = { text: out, model: cache[key].model, v: ELI5_V, src: shortHash(src), at: cache[key].at }
        apiCalls++
        cacheModified = true
        log(`ELI5 wrote ${e.sha.slice(0, 8)} (${apiCalls}/${queue.length})`)
      } catch (err) {
        log(`ELI5 failed for ${e.sha.slice(0, 8)}: ${shortError(err)}`)
        const transient = isTransientError(err)
        if (transient) {
          if (options.retryErrors) {
            cache[key] = { error: shortError(err).slice(0, 200), transient: true, at: new Date().toISOString() }
            cacheModified = true
          }
          gatewayFails++
          if (gatewayFails >= 3) {
            log('LLM endpoint appears offline (3 consecutive gateway errors): skipping the ELI5 queue this run')
            break
          }
          continue
        }
        // Bad or empty model output: parked for the long cooldown, since
        // retrying the same prompt on the next cycle would fail the same way.
        cache[key] = { error: shortError(err).slice(0, 200), at: new Date().toISOString() }
        cacheModified = true
      }
    }
  }

  const poolSize = Math.min(concurrency, queue.length)
  await Promise.all(Array.from({ length: poolSize }, () => worker()))

  if (cacheModified) {
    await writeJson(cachePath, mergeAiCache(await readJson(cachePath, {}), cache))
  }
  return apiCalls
}
export async function eli5Notes (e, getPatch) {
  if (e.facts?.length) return e.facts.slice(0, 5)
  if (!getPatch) return []
  // Rows analyzed before the comment extractor counted words rather than letter
  // runs have no facts at all, and the sentence that names who a program is for is
  // sitting in their diff. Re-read the stored patch rather than ship an ELI5 that
  // has to guess the audience.
  try {
    const patch = await getPatch(e)
    return patch ? extractCommentFacts(patch).slice(0, 5) : []
  } catch {
    return []
  }
}
