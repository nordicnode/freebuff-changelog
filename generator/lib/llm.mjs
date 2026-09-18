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
//   LLM_TIMEOUT_MS            per-request timeout including body reads (default 60000)
//   CHANGELOG_LLM_LIMIT        max commits summarized per run (default 60; 0 = no cap)
//   CHANGELOG_LLM_CONCURRENCY  parallel API calls (default 5)
//   CHANGELOG_ELI5_LIMIT       plain-English pass budget (defaults to the above)
//   CHANGELOG_ELI5_DIFF=0      explain from the summary only, skip the diff
//   CHANGELOG_ELI5_DIFF_BYTES  diff budget sent to the plain-English pass (6000)
//   CHANGELOG_LLM_CHURN=1      also summarize lockfile/icon-only rows, from their
//                              raw diff (~1,900 extra calls)
//   CHANGELOG_LLM_ERROR_COOLDOWN_MS  retry failed entries after this (default 3600000)
//   CHANGELOG_LLM_TRANSIENT_RETRY_MS  ...but gateway blips retry sooner (default 300000)
//   options.priorityShas       SHAs to summarize ahead of the backlog
import { readJson, writeJson, log, pool, shortHash, eli5Source } from './util.mjs'
import { mergeAiCache } from './mergedata.mjs'
import { extractCommentFacts, isBumpEntry, versionTrackOf, VERSION_TRACKS } from './analyze.mjs'

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
// Defaults allow up to 250 KB (uncapped for modern LLM context windows).
export function budgetPatch (patch, maxBytes = 250000, perFile = 60000) {
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
    'Title: plain text, max 70 chars, no backticks, no markdown, no trailing period. Lead with the concrete change (model name, command with leading slash, version, subsystem). Translate code identifiers into plain words (split snake_case/camelCase/CONSTANT_CASE, drop glued version suffixes); never emit a raw glued identifier as a title word.',
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
  const maxDiff = Number(process.env.CHANGELOG_LLM_MAX_DIFF_BYTES) || 250000
  lines.push('', 'Diff (source hunks; lockfiles and pure test hunks omitted, except in a lockfile-only commit):', '```diff', budgetPatch(patch, maxDiff, Math.max(60000, Math.round(maxDiff / 4))), '```')
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

// Some OpenAI-compatible gateways answer /chat/completions with SSE chunk
// frames (one JSON object per `data:` line) even when stream was not asked
// for. Reassemble those into the message text; plain JSON bodies pass through.
export function extractResponseText (rawText) {
  const raw = String(rawText)
  const frames = raw.split('\n').filter(l => /^\s*data:\s*\{/.test(l))
  if (frames.length) {
    let text = ''
    for (const line of frames) {
      const m = /^\s*data:\s*(\{.*\})\s*$/.exec(line)
      if (!m) continue
      try {
        const chunk = JSON.parse(m[1])
        const delta = chunk.choices?.[0]?.delta?.content ?? chunk.data?.choices?.[0]?.delta?.content
        if (typeof delta === 'string') text += delta
      } catch { /* skip malformed chunk lines */ }
    }
    if (text) return text
    // No deltas: a gateway may still have sent whole messages per frame.
    for (const line of frames) {
      const m = /^\s*data:\s*(\{.*\})\s*$/.exec(line)
      if (!m) continue
      try {
        const content = messageContent(JSON.parse(m[1]))
        if (content) return content
      } catch { /* keep looking */ }
    }
  }
  let parsed
  try {
    parsed = parseLlmJson(raw)
  } catch {
    throw new Error('LLM returned no JSON')
  }
  const content = messageContent(parsed)
  if (content) return content
  throw new Error('LLM returned no JSON')
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
  const configuredTimeout = Number(env.LLM_TIMEOUT_MS)
  // Bound each attempt, including response-body/SSE consumption. Invalid values
  // retain the historical timeout instead of aborting immediately or overflowing.
  const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout > 0 && configuredTimeout <= 2147483647
    ? configuredTimeout : 60000
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
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (res.status === 429 && attempt <= 3) {
    // Honor Retry-After; fall back to exponential backoff.
    const waitMs = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt
    log(`LLM rate-limited (429): waiting ${(waitMs / 1000).toFixed(0)}s before retry ${attempt}/3`)
    await new Promise(r => setTimeout(r, Math.min(waitMs, 30000)))
    return callLlm(prompt, env, attempt + 1, validate)
  }
  // 5xx gateways (tunnel 522s included): one delayed retry, then a short error.
  if (res.status >= 500 && res.status <= 599 && attempt === 1) {
    await new Promise(r => setTimeout(r, 5000))
    return callLlm(prompt, env, attempt + 1, validate)
  }
    if (!res.ok) throw new Error(shortError(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`))
    const rawText = await res.text()
    const text = extractResponseText(rawText)
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
    // Raw code identifiers read as noise in a human title (advertiserreasonredaction202609v3).
    // Real English words this long are vanishingly rare; the repair pass rewords the few.
    if (title.split(/[^A-Za-z0-9]+/).some(w => w.length >= 18)) throw new Error('LLM title contains raw identifier')
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
// Release-window context for version-bump rows.
//
// A bump row's own diff is one version string, so from its patch alone the
// only honest ELI5 is "packaging housekeeping" -- even when the window since
// the previous bump shipped real features (e.g. freebuff-cli 0.0.177's own
// diff is a 1-line manifest edit, but the 20 commits since 0.0.176 include
// sponsored-card guidance, telemetry contracts and pricing-badge work).
//
// The fix is to feed the bump's ELI5 the window it releases: the
// already-vetted titles + first sentences of the non-noise predecessors back
// to the previous bump of the same track. Summaries, not diffs: the window
// was already summarized once, and re-sending full diffs would re-litigate
// that work at ~100x the tokens.
//
// Track identity matters because the 1.0.x (cli/release) and 0.0.x
// (freebuff/cli/release) lines interleave: a 0.0.177 window must stop at
// 0.0.176, not at the 1.0.688 bump in between. Old rows predate versionTrack,
// so the boundary also infers the line from the touched manifest path and the
// version string shape (see trackOfBump); an unknowable line means "same line
// as whoever asks", never "stop here" -- a missing stop only widens the
// draft, a wrong stop silently drops half the release.

// Caps: large on purpose. The 200k-token window fits even the biggest 1.0.x
// gaps (61+ commits) once compressed to title+summary lines; items cap the
// prompt, chars cap it harder. No extra LLM calls: context is in-memory.
export const RELEASE_CTX_MAX_ITEMS = 100
export const RELEASE_CTX_MAX_CHARS = 30000
export const RELEASE_CTX_SUMMARY_CHARS = 300

// Version of the roll-up ASK itself (wording of the prompt rule above), not of
// the window: folded into contextualized eli5 keys only, so rewording the
// instruction re-explains the ~715 bump rows without re-spending a cent on the
// thousands of non-bump lines. v3: roll-ups may run to 8 sentences under the
// widened cap instead of being sheared at the old 800-char cutter.
export const RELEASE_ROLLUP_V = 3

// Which release line a bump row belongs to. Prefers the recorded track, then
// the touched manifest path (file lists on old rows), then the version string
// shape (1.x = codebuff-cli, 0.x = freebuff-cli). Null when nothing says.
export function trackOfBump (e) {
  const direct = versionTrackOf(e)
  if (direct) return direct
  const files = [...(e?.files?.added || []), ...(e?.files?.modified || []), ...(e?.files?.removed || [])]
  for (const [pkgPath, track] of Object.entries(VERSION_TRACKS)) {
    if (files.includes(pkgPath)) return track
  }
  const v = e?.version || e?.freebuffVersion || ''
  if (/^1\./.test(v)) return 'codebuff-cli'
  if (/^0\./.test(v)) return 'freebuff-cli'
  return null
}

function releaseItemText (e, maxSummary = RELEASE_CTX_SUMMARY_CHARS) {
  const title = e?.ai?.title || e?.title || ''
  const raw = e?.ai?.summary || e?.summary || ''
  const summary = firstSentence(raw)
  const sig = e?.ai?.significance || e?.significance || ''
  const head = `${(e?.date || '').slice(0, 10)} ${title}`.trim()
  const tail = summary && summary !== title ? `: ${truncateWords(summary, maxSummary)}` : ''
  const tag = sig && sig !== 'noise' ? ` [${sig}]` : ''
  return `${head}${tail}${tag}`.trim()
}

// The window a bump row releases: non-noise, non-bump predecessors back to
// (excluding) the previous bump of the same track. Entries arrive
// oldest-first (changelog.json order); position lookups come from a caller-
// supplied index so this stays O(window) inside the enrichment loop.
//
// Alongside the item list, the walk accumulates the window's structured
// catalog events (model add/remove, slash-command add/remove) and folds them
// into a NET effect: the last event per name wins, so a model swapped out
// again later the same window shows as removed even though an early item
// announced its arrival. Per-commit summaries cannot see reversals -- each
// was true the day it landed -- but the final state is what installing the
// version gives the reader, so the net lines are authoritative in the prompt.
export function collectReleaseContext (entries, bump, opts = {}) {
  const out = { items: [], prevVersion: null, truncated: false, net: { modelsIn: [], modelsOut: [], commandsIn: [], commandsOut: [] } }
  if (!Array.isArray(entries) || !bump) return out
  const maxItems = opts.maxItems ?? RELEASE_CTX_MAX_ITEMS
  const maxChars = opts.maxChars ?? RELEASE_CTX_MAX_CHARS
  const idx = opts.index ?? new Map(entries.map((x, i) => [x.sha, i]))
  const pos = idx.get(bump.sha)
  if (pos == null || pos <= 0) return out
  const line = trackOfBump(bump)
  const picked = []
  const events = []
  let used = 0
  for (let i = pos - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e || e.sha === bump.sha) continue
    if (isBumpEntry(e)) {
      // A bump of the same line (or an unknowable line) closes the window. A
      // bump of the *other* line is interleaved traffic, not our release: the
      // window sails past it but never includes it.
      if (!line) break
      const other = trackOfBump(e)
      if (!other || other === line) {
        out.prevVersion = e.version || e.freebuffVersion || null
        break
      }
      continue
    }
    if (e.noise) continue
    const text = releaseItemText(e)
    if (!text) continue
    // Churn rows that slipped past noise (belt and suspenders): versionless,
    // meaningless, lockfile-only leftovers add tokens, never signal.
    if (!e.ai?.title && !e.ai?.summary && (e.files?.meaningful ?? 1) <= 0) continue
    // Catalog events feed the net effect from every window entry, capped or
    // not: the item list may truncate on huge gaps, the final state must not.
    // A name in BOTH lists of one commit is a description-only edit (the
    // analyzer's own net rule) and contributes nothing.
    if (e.modelChanges) {
      const adds = e.modelChanges.added || [], rems = e.modelChanges.removed || []
      for (const m of adds) if (!rems.includes(m)) events.push({ kind: 'model', name: m, dir: 1 })
      for (const m of rems) if (!adds.includes(m)) events.push({ kind: 'model', name: m, dir: -1 })
    }
    if (e.cmdChanges) {
      const adds = e.cmdChanges.added || [], rems = e.cmdChanges.removed || []
      for (const c of adds) if (!rems.includes(c)) events.push({ kind: 'cmd', name: c, dir: 1 })
      for (const c of rems) if (!adds.includes(c)) events.push({ kind: 'cmd', name: c, dir: -1 })
    }
    if (picked.length >= maxItems || used + text.length + 1 > maxChars) {
      out.truncated = true
      break
    }
    picked.push({ sha: e.sha, text })
    used += text.length + 1
  }
  // Chronological reads better in the prompt ("since X, the team shipped...").
  out.items = picked.reverse()
  // Fold the catalog events into the net effect. The walk collected them
  // newest-first, so reversing restores true chronology; the newest event per
  // name wins, which keeps an early add that a later commit removed OUT of
  // the release and keeps a model swapped-in twice counted by its final state.
  const chrono = events.slice().reverse()
  const finalDir = new Map()
  for (const ev of chrono) finalDir.set(`${ev.kind}:${ev.name}`, ev.dir)
  for (const ev of chrono) {
    if (finalDir.get(`${ev.kind}:${ev.name}`) !== ev.dir) continue
    const list = ev.kind === 'model'
      ? (ev.dir > 0 ? out.net.modelsIn : out.net.modelsOut)
      : (ev.dir > 0 ? out.net.commandsIn : out.net.commandsOut)
    if (!list.includes(ev.name)) list.push(ev.name)
  }
  return out
}

export function formatReleaseContext (ctx, bump) {
  if (!ctx) return ''
  const v = bump?.version || bump?.freebuffVersion || ''
  const since = ctx.prevVersion ? ` since ${ctx.prevVersion}` : ''
  const head = `Updates included in this release${v ? ` (${v}${since})` : since}:`
  const lines = (ctx.items || []).map(it => `- ${it.text}`)
  if (ctx.truncated) lines.push(`- ...[earlier changes truncated; newest ${(ctx.items || []).length} shown]...`)
  const net = ctx.net || {}
  const netLines = []
  if (net.modelsIn.length || net.modelsOut.length) {
    netLines.push(`- Free model picker, final state: ${net.modelsIn.length ? `added ${net.modelsIn.join(', ')}` : 'nothing added'}${net.modelsOut.length ? `; removed ${net.modelsOut.join(', ')}` : ''}.`)
  }
  if (net.commandsIn.length || net.commandsOut.length) {
    netLines.push(`- Slash commands, final state: ${net.commandsIn.length ? `added ${net.commandsIn.join(', ')}` : 'nothing added'}${net.commandsOut.length ? `; removed ${net.commandsOut.join(', ')}` : ''}.`)
  }
  if (netLines.length) lines.push('Net effect by the time of this release (the final state; overrides any item above it contradicts):', ...netLines)
  // An empty window (no items, no net effect) stays out of the prompt and out
  // of the cache key: the honest line for it is housekeeping, not an empty list.
  if (!lines.length) return ''
  return [head, ...lines].join('\n')
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
// v3: the pass now sees what the summarizer saw -- the stored diff, the file list,
// the catalog rows, same-day siblings and up to 8 comments -- because a line written
// from the title and the summary alone repeats the summary and cannot correct it.
// The whole backlog re-explains once through the same resumable budget
// (CHANGELOG_ELI5_LIMIT); a diff costs ~1k tokens on top of a ~400 token ask.
// v4: an access change the evidence records is a change, even when the commit only
// publishes the list that says so. "This update does not change who is eligible
// today" shipped above a comment recording that SG and IL had left full access the
// day before -- true of the commit, false of the story. The rule now says to carry
// the recorded change into the line, without inventing an effective date.
// Render-time story notes also expose explicit access evidence from related entries.
export const ELI5_V = 4

// eli5Source() lives in util.mjs because the changelog merge has to recompute it
// to check a merged ELI5 against the summary that survived. Re-exported here as
// part of this module's contract: its hash is the cache key suffix and the
// entry's eli5.src, so a re-summarized entry drops a stale plain-English line.
export { eli5Source }

export function eli5Key (sha, source, releaseCtx = '', rollupV = 0) {
  // Bump rows explain their release window, not just their own diff, so the
  // window hash joins the key: predecessors gaining summaries refreshes the
  // roll-up, while non-bump rows keep byte-identical keys (no cache churn).
  // rollupV rides on the window segment so a reworded roll-up ask re-explains
  // bump rows only -- and a key with no window can never grow one.
  const extra = releaseCtx ? `:${shortHash(releaseCtx)}${rollupV ? `-r${rollupV}` : ''}` : ''
  return `${sha}:eli5:v${ELI5_V}:${shortHash(source)}${extra}`
}

// Explainable = has a current technical summary. Churn rows have nothing to
// explain, and community rows are titled straight from their commit message and
// never went through the model.
export function eli5Eligible (e) {
  return !e.noise && !!e.ai?.title && !!e.ai?.summary && (e.ai?.v ?? 1) >= PROMPT_V
}

export function eli5Done (e, releaseCtx = '', rollupV = 0) {
  // e.eli5.ctx is the window hash the line was written from. enrichEli5 always
  // passes the current window for bumps, so a roll-up whose window filled in
  // since (predecessors summarized late, or a rescan moved the boundary)
  // re-queues on its own. Single-arg callers (status counters) keep the old
  // v+src semantics exactly -- otherwise every contextualized bump would read
  // as permanently "remaining".
  if (!(e.eli5 && e.eli5.v >= ELI5_V && e.eli5.src === shortHash(eli5Source(e)))) return false
  if (!releaseCtx) return true
  if (!e.eli5.ctx) return false
  if (e.eli5.ctx !== shortHash(releaseCtx)) return false
  // rollupV gates the ASK, not the window: a row explained under an older
  // roll-up instruction re-queues once the versioned pass wants it back.
  // Callers that pass no version keep hash-only semantics.
  if (rollupV && e.eli5.rollup !== rollupV) return false
  return true
}

export function buildEli5Prompt (e, notes = [], ctx = {}) {
  const { patch = '', siblings = [], diffBytes = 6000, releaseCtx = '' } = ctx
  const evidence = []
  if (e.summary && e.summary !== e.ai.summary) evidence.push(`What the analyzer measured: ${e.summary}`)
  if (e.stats) {
    // `meaningful`, not `total`: total counts the lockfile riding along in the
    // snapshot, and the analyzer's own note right above it says otherwise.
    const n = e.files?.meaningful ?? e.files?.total
    evidence.push(`Size: ${e.stats.additions ?? '?'} lines added, ${e.stats.deletions ?? '?'} removed${n ? ` across ${n} file${n === 1 ? '' : 's'}` : ''}`)
  }
  const touched = [...(e.files?.added || []), ...(e.files?.modified || [])].slice(0, 12)
  if (touched.length) evidence.push(`Where it landed: ${touched.join(', ')}`)
  if (e.files?.churned?.length) evidence.push(`In the snapshot but not part of this change: ${e.files.churned.slice(0, 4).join(', ')}`)
  if (e.modelChanges) {
    const added = e.modelChanges.added || [], removed = e.modelChanges.removed || []
    if (added.length || removed.length) evidence.push(`Model picker: in (${added.join(', ') || 'nothing'}), out (${removed.join(', ') || 'nothing'})`)
    const tables = e.modelChanges.tables || {}
    const rows = []
    for (const m of [...added, ...removed]) {
      const row = tables[m]?.after || tables[m]?.before
      if (row) rows.push(`${m}: ${row.join(' | ')}`)
    }
    if (rows.length) evidence.push(`What the catalog says about them: ${rows.join(' || ')}`)
  }
  if (e.cmdChanges?.added?.length || e.cmdChanges?.removed?.length) {
    evidence.push(`Slash commands: in (${e.cmdChanges.added.join(', ') || 'nothing'}), out (${e.cmdChanges.removed.join(', ') || 'nothing'})`)
  }
  if (e.version) evidence.push(`Shipped in version ${e.version}`)
  if (e.freebuffVersion) evidence.push(`Shipped in freebuff app version ${e.freebuffVersion}`)
  if (releaseCtx) evidence.push(releaseCtx)
  if (siblings.length) evidence.push(`Other changes the same snapshot: ${siblings.slice(0, 6).join(' ; ')}`)
  const noteBlock = notes.length
    ? `\nComments the developers wrote beside this code. Read them: they say who this is for and what it does today, which the constant names do not.\n${notes.map(n => `- ${n}`).join('\n')}\n`
    : ''
  const diffBlock = patch
    ? `\nThe change itself. Lockfiles and test-only hunks are already stripped; the full diff is on GitHub.\n\`\`\`diff\n${budgetPatch(patch, diffBytes, Math.max(800, Math.round(diffBytes / 4)))}\n\`\`\`\n`
    : ''
  return `Explain one software change to a reader who is not a programmer and will not look at the code.

Date: ${e.day || ''}
Area: ${e.category || (e.areas || []).join(', ')}
Weight the tooling gave it: ${e.significance || 'minor'}
Title: ${e.ai.title}
Technical summary: ${e.ai.summary}
${evidence.length ? `\nEvidence. Use it; do not repeat it back verbatim.\n${evidence.map(x => `- ${x}`).join('\n')}\n` : ''}
${noteBlock}${diffBlock}
  Write 2-4 sentences of plain English: what happened, who it affects, and what you would notice if you looked. Say the concrete thing, not the category of thing. Lead with what the reader experiences, then the mechanism.

Rules:
- No jargon, acronyms, file names, function names, code or version numbers. Say what the thing does instead of what it is called ("the assistant can now use a new model", not "a provider adapter was wired up").
- The diff and the file list are evidence, not vocabulary. Read them for the part the summary skipped: the threshold, the condition, the plan or region it applies to, the thing that stops working. Then translate that into plain words.
- If the summary and the diff disagree about what happened, follow the diff.
- Say whether it is live today. A constant, a flag, a field or a type that nothing reads yet is not a feature: say it is in place and does nothing yet.
- An access change recorded in the evidence is a change, even when this commit only publishes it. If a comment, a fact or the diff says a region, a plan or a group lost or gained access, left or joined a list, or keeps something it bought, say that, with the date the evidence gives. "Who is eligible today did not change" is a false comfort when the evidence records that it changed yesterday. The nothing-reads-yet rule is for constants nobody consumes, not for access that already moved.
- Use only what the summary, the evidence and the comments say. Never invent a cause, a number, or a promise.
- Keep the audience the text gives, and keep it narrow. If the change is for one kind of customer, one plan, one region, or only after some step, name that group. Never widen it to "users", "everyone" or "customers" because that reads more naturally: a program for verified YC companies is not available to users.
- Plain words, active voice. No "This change", "We are excited", marketing tone, or generic tautologies ("various bug fixes and improvements").
- Jump straight into what happened. NEVER use conversational preambles, filler intros, or framing phrases like "In simple terms", "Basically", "To put it simply", "In plain English", "This commit", "This update", or "This pull request". Start directly with the concrete action or subject.
- This row may be a version-label commit whose own diff is only packaging. When the evidence lists "Updates included in this release", THAT list is what this row is about: the "Technical summary" above describes only the label change itself and must not drive the line. Summarize what updating to this version gives the reader, drawn from that list, strongest user-visible item first. If the list ends with a "Net effect" line, that is the final state the reader ends up with: announce only what survives it -- something an item says was added but the net line says was later removed is NOT in this release. Only when the list is absent or holds no user-visible change, say honestly that this is a routine behind-the-scenes update that keeps installs current.
- If the change is an internal refactor, test suite update, dependency bump, or maintenance change with no direct user-facing behavior, explain it honestly and plainly as behind-the-scenes housekeeping or stability maintenance. Do NOT invent or fabricate user-facing features, performance claims, or speed improvements.
- If the change is small or internal, say so shortly. Do not inflate it.
- Never address the reader as a developer.
- Address the reader as "you", or name the group ("users", "subscribers"); never write "that person", "the viewer" or "that individual".
- ${releaseCtx ? 'A release roll-up may run longer: stop after up to 8 sentences.' : 'Stop after 2-4 sentences.'} Include an effective date only when the evidence supplies it and it clarifies the change; never recite day counts or archive calendars.

Reply with JSON only: {"eli5": "..."}`
}

// Non-answers worth parking: a whole reply that is "N/A", or one that opens with
// a refusal. Checked at the start of the sentence so a real explanation that
// happens to contain "cannot" is not thrown away.
const ELI5_JUNK = /^(n\/?a|none|not applicable|no comment|unknown)[.!]?$/i
const ELI5_REFUSAL = /^(i\s+ca(?:n'?t|nnot|'m unable)|we\s+ca(?:n'?t|nnot)|unable to|sorry|as an ai|i'?m (just|only|an)|no information)\b/i

// ELI5 length caps. The old single 800-char cap predates roll-ups: a release
// window legitimately enumerates several shipped changes, so it piled against
// the ceiling and the cutter sheared it mid-sentence. Normal rows keep the
// original bound; roll-ups get a wider one -- and every cut lands on a sentence
// end, never mid-word.
export const ELI5_MAX_CHARS = 800
export const ELI5_ROLLUP_MAX_CHARS = 2400

// Cut to the last complete sentence that fits the budget. Scanning backwards
// means an abbreviation earlier in the text ("3 a.m.") can never win the cut:
// the nearest boundary to the cap is found first. A single sentence longer
// than the whole budget is the only case that hard-cuts.
function cutToSentence (s, maxChars) {
  if (s.length <= maxChars) return s
  for (let i = Math.min(maxChars, s.length - 1); i > 0; i--) {
    if ('.!?'.includes(s[i]) && (i === s.length - 1 || /\s/.test(s[i + 1]))) return s.slice(0, i + 1).trim()
  }
  return `${s.slice(0, maxChars).trimEnd()}…`
}

export function normalizeEli5 (raw, maxChars = ELI5_MAX_CHARS) {
  // callLlm hands the validator the parsed object; a bare-string reply is also
  // accepted because small models sometimes ignore the JSON envelope.
  const value = raw && typeof raw === 'object' ? (raw.eli5 ?? raw.text ?? '') : raw
  let s = String(value ?? '').trim()
  // Models like to restate the label they were given.
  s = s.replace(/^(ELI5|In plain English|Plain english)\s*[:–-]\s*/i, '').trim()
      s = s.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim()
    // Backstop for phrasing the prompt now forbids: point it at the reader.
    s = s.replace(/\bthat person\b/gi, 'you').replace(/\bthe viewer\b/gi, 'you').replace(/\bthat individual\b/gi, 'you')
    // Runaway generations recite the site archive (May 13, 2025 (22)...). Cut there.
    const bleed = s.search(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s*\(\d+\)/)
    if (bleed !== -1) { s = s.slice(0, bleed).trim(); if (!/[.!?]$/.test(s)) s += '.' }
  // The floor exists to catch non-answers, not to reject a terse but valid
  // sentence: "It is faster now." is 16 characters and exactly what this field
  // is for. A 25-character floor parked real answers as errors for an hour.
  if (s.length < 12 || ELI5_JUNK.test(s) || ELI5_REFUSAL.test(s)) {
    throw new Error(`eli5 not an answer: ${JSON.stringify(s).slice(0, 60)}`)
  }
    if (!/[.!?]$/.test(s)) s += '.'
    return cutToSentence(s, maxChars)
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
  // The patch reader the summary pass uses. The plain-English line reads the same
  // stored diff: it is where the threshold, the condition and the audience live,
  // and the pass already paid for the git work to mine comments out of it.
  const getPatch = typeof options.getPatch === 'function' ? options.getPatch : null
  const wantDiff = env.CHANGELOG_ELI5_DIFF !== '0'
  const diffBytes = Number(env.CHANGELOG_ELI5_DIFF_BYTES || 6000)
  // Same-day titles, so a line can place its change instead of explaining one
  // commit in a vacuum. Built once per run from entries already in memory.
  const byDay = new Map()
  for (const e of entries) {
    if (e.noise || !e.day) continue
    const t = e.ai?.title || e.title
    if (!t) continue
    const list = byDay.get(e.day) || []
    if (list.length < 12) { list.push(t); byDay.set(e.day, list) }
  }
  let apiCalls = 0
  let cacheModified = false

  // Ordered by how much a plain-English line can actually say. A model swap or a
  // new command has a reader-facing story; a comment beside the code names its
  // audience; a bare version bump has neither, and the honest line about it is "a
  // number went up" -- so 650 of those must not drink the budget first.
  // A bare version label (either track) with no catalog/command payload and a
  // tiny diff: its own patch says "a number went up" and nothing else.
  const bumpOnly = (e) => isBumpEntry(e) && !e.modelChanges && !e.cmdChanges &&
    (e.stats?.additions ?? 99) <= 10 && (e.files?.meaningful ?? 99) <= 2
  // Positions for the release-window walk (entries are oldest-first). Built
  // once per run so per-bump context stays O(window), not O(history).
  const posIndex = new Map(entries.map((x, i) => [x.sha, i]))
  // Memoized windows: the same bump row is hashed by pending-filter, queue
  // build and worker without re-walking.
  const ctxCache = new Map()
  const releaseOf = (e) => {
    if (!bumpOnly(e)) return null
    let hit = ctxCache.get(e.sha)
    if (!hit) {
      const ctx = collectReleaseContext(entries, e, { index: posIndex })
      hit = { ctx, text: formatReleaseContext(ctx, e) }
      ctxCache.set(e.sha, hit)
    }
    return hit.text ? hit : null
  }
  const prio = (e) => (priority.has(e.sha) ? -1
    : e.modelChanges ? 0
    : releaseOf(e) ? 1
    : e.cmdChanges ? 1
    : e.facts?.length ? 2
    : bumpOnly(e) ? 5
    : e.significance === 'major' || e.significance === 'notable' ? 3
    : 4)
  // eli5Done is context-aware for bumps: a roll-up whose window filled in
  // since (predecessors summarized late) re-queues on its own.
  const pending = entries.filter(eli5Eligible).filter(e => {
    const hit = bumpOnly(e) ? releaseOf(e) : null
    return !eli5Done(e, hit?.text || '', hit ? RELEASE_ROLLUP_V : 0)
  })
  pending.sort((a, b) => prio(a) - prio(b) || (a.date < b.date ? 1 : -1))
  // Same bound as the summary pass: choosing this run's dozen entries must not
  // mean hashing the whole backlog.
  const candidates = pending.slice(0, Number.isFinite(limit) ? Math.max(limit * 4, limit + 5) : 2000)

  const queue = []
  for (const e of candidates) {
    const src = eli5Source(e)
    const hit = bumpOnly(e) ? releaseOf(e) : null
    const relText = hit?.text || ''
    const key = eli5Key(e.sha, src, relText, relText ? RELEASE_ROLLUP_V : 0)
    const cached = cache[key]
    if (cached?.error) {
      if (!options.retryErrors) continue
      const failedAt = Date.parse(cached.at || '') || 0
      if (Date.now() - failedAt < (cached.transient ? transientRetryMs : errorCooldownMs)) continue
    }
    if (cached && !cached.error) {
      // A cache hit costs nothing but still has to land on the entry, or the
      // site renders no ELI5 line for it.
      e.eli5 = { text: cached.text, model: cached.model, v: cached.v, src: shortHash(src), ...(relText ? { ctx: shortHash(relText), rollup: RELEASE_ROLLUP_V } : {}), at: cached.at }
      continue
    }
    queue.push({ entry: e, src, key, relText })
    if (queue.length >= limit) break
  }

  if (!queue.length) return 0

  let activeIndex = 0
  let gatewayFails = 0

  async function worker () {
    while (activeIndex < queue.length) {
      if (gatewayFails >= 3) break
      const idx = activeIndex++
      const { entry: e, src, key, relText = '' } = queue[idx]
      try {
          const patch = await eli5Patch(e, wantDiff || !e.facts?.length ? getPatch : null)
          const out = await callLlm(buildEli5Prompt(e, eli5Notes(e, patch), {
            patch: wantDiff ? patch : '',
            siblings: (byDay.get(e.day) || []).filter(t => t !== e.ai.title).slice(0, 6),
            diffBytes,
            releaseCtx: relText
          }), env, 1, (out) => normalizeEli5(out, relText ? ELI5_ROLLUP_MAX_CHARS : ELI5_MAX_CHARS))
        gatewayFails = 0
        cache[key] = {
          model: env.LLM_MODEL || 'gpt-4o-mini',
          v: ELI5_V,
          text: out,
          ...(relText ? { ctx: shortHash(relText), rollup: RELEASE_ROLLUP_V } : {}),
          at: new Date().toISOString()
        }
        e.eli5 = { text: out, model: cache[key].model, v: ELI5_V, src: shortHash(src), ...(relText ? { ctx: shortHash(relText), rollup: RELEASE_ROLLUP_V } : {}), at: cache[key].at }
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
// Comments beside the code, from the recorded facts and the patch, best first.
// Merged rather than either-or: a row can carry facts the extractor kept and sit
// next to a comment it dropped, and the audience is usually in the dropped one.
export function eli5Notes (e, patch) {
  const fromPatch = patch ? extractCommentFacts(patch) : []
  return [...new Set([...(e.facts || []), ...fromPatch])].slice(0, 8)
}

// The stored clean diff, or ''. A missing worktree or an unreadable row must never
// fail the pass: the summary alone still explains the change.
export async function eli5Patch (e, getPatch) {
  if (!getPatch) return ''
  try {
    return await getPatch(e) || ''
  } catch {
    return ''
  }
}
// The assistant text inside one OpenAI-shaped reply. Gateways differ on where
// they put it: canonical `choices[0].message.content`, or the same object one
// level down inside a `{ data: … }` envelope.
function messageContent (obj) {
  const direct = obj?.choices?.[0]?.message?.content
  if (typeof direct === 'string' && direct) return direct
  const wrapped = obj?.data
  if (wrapped && typeof wrapped === 'object') {
    const inner = wrapped.choices?.[0]?.message?.content
    if (typeof inner === 'string' && inner) return inner
  }
  return ''
}
