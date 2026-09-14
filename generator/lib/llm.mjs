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
//   CHANGELOG_LLM_LIMIT        max commits summarized per run (default 60)
//   CHANGELOG_LLM_CONCURRENCY  parallel API calls (default 5)
//   CHANGELOG_LLM_ERROR_COOLDOWN_MS  retry failed entries after this (default 3600000)
import { createHash } from 'node:crypto'
import { readJson, writeJson, log, pool } from './util.mjs'

export function llmConfigured (env = process.env) {
  return env.CHANGELOG_LLM === '1' && !!env.LLM_API_KEY
}

// Bump when buildPrompt changes so stale entries re-summarize exactly once.
export const PROMPT_V = 3

// First-sentence gate: sentence 1 is what non-technical users read.
// Code tokens there mean the summary failed its audience.
const S1_JARGON_RE = /`|[\w-]+\.(ts|tsx|js|json|md)|src\/|constants?|packages?|registry|catalog|snapshot|hunk|diff|CLI packages?/i

export function firstSentence (s) {
  const m = String(s || '').trim().match(/^[^.?!]+[.?!]/)
  return (m ? m[0] : String(s || '').trim()).trim()
}

function patchHash (patch) {
  return createHash('sha1').update(patch).digest('hex').slice(0, 12)
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
    'You write changelog entries for Freebuff, a free AI coding agent. Your reader is a NON-TECHNICAL user: they pick a model, type, and expect answers.',
    'Rules: use ONLY facts from the diff and the analysis notes below. Never invent file names, features, or versions.',
    'Title: plain text, max 70 chars, no backticks, no markdown, no trailing period. Lead with the user-visible change.',
    'Summary shape (2-4 sentences, plain prose, no backticks in sentence 1):',
    '1. WHAT a non-technical user notices, in everyday words (e.g. "Muse Spark 1.2 is back in the free list, replacing 1.3"). No file paths, no package names, no code terms.',
    '2. WHY it happened, grounded in the notes/diff (e.g. "1.3 was removed after it started returning errors"). If the reason is not visible, say what the change does instead — never invent motives.',
    '3. WHAT TO DO, if anything (e.g. "Nothing to do: your saved choice carries over"). If no action is needed, say so or omit this.',
    '4. DETAIL for curious readers: name the areas touched in plain words (e.g. "the free model list on Web, desktop app, and command line"), plus one concrete fact (model trait, command name with leading slash, version number). Never paste raw diff lines.',
    `Output a JSON object: {"title": "<plain title>", "summary": "<2-4 sentence summary>", "significance": "${entry.significance || 'minor'}"}.`,
    `Significance (deterministic default "${entry.significance || 'minor'}"): keep it unless the diff clearly contradicts it.`,
    'major = new feature, model added/removed, security, breaking. notable = user-visible behavior/UI change, new file, API change. minor = internal, refactor, types, comments, deps.',
    '',
    'BAD (jargon, no why, no action): "The free model catalog now offers Muse Spark 1.2 instead of Muse Spark 1.3. This change updates the model selection constants and documentation across the core and CLI packages."',
    'GOOD (plain, why, action, detail): "Muse Spark 1.2 is back in the free list, replacing 1.3, after 1.3 started returning not-found errors. Nothing to do: saved choices carry over automatically. The swap covers Web, the desktop app, and the command line; 1.2 is the fast all-round pick."',
    '',
    `Date: ${entry.date}`,
    `Category: ${entry.category || (entry.areas || []).join(', ')}`,
    `Areas: ${(entry.areas || []).join(', ')}`,
    `Stats: +${entry.stats?.additions ?? '?'} / -${entry.stats?.deletions ?? '?'}`,
    `Analysis notes: ${entry.summary}`
  ]
  if (entry.modelChanges) lines.push(`Model catalog: +${entry.modelChanges.added.join(', ')} -${entry.modelChanges.removed.join(', ')}`)
  if (entry.cmdChanges) lines.push(`Slash commands: +${(entry.cmdChanges.added || []).join(', ')} -${(entry.cmdChanges.removed || []).join(', ')}`)
  if (entry.version) lines.push(`Version bump: ${entry.version}`)
  const files = [...(entry.files?.added || []), ...(entry.files?.modified || []).slice(0, 8)]
  if (files.length) lines.push(`Files: ${files.join(', ')}`)
  const facts = (entry.facts || []).slice(0, 5)
  if (facts.length) lines.push(`Key facts (ground the WHY and DETAIL sentences in these): ${facts.map(f => `- ${f}`).join(' ')}`)
  const surfaces = (entry.areas || []).filter(a => ['CLI', 'Agents', 'Docs', 'Packaging'].includes(a))
  if (surfaces.length) lines.push(`User surfaces: ${surfaces.join(', ')} (translate to plain words: CLI = "command line", Packaging = "desktop app / install", Agents = "built-in helpers", Docs = "help pages")`)
  lines.push('', 'Diff (bun.lock and pure test hunks omitted):', '```diff', budgetPatch(patch), '```')
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

async function callLlm (prompt, env, attempt = 1) {
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
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const rawText = await res.text()
  const data = parseLlmJson(rawText)
  const text = data.choices?.[0]?.message?.content ?? ''
  try {
    return validateLlmOut(parseLlmJson(text))
  } catch (err) {
    if (attempt > 2) throw err
    // One repair pass: ask for valid JSON only, no new analysis.
    log(`LLM output invalid (${err.message}): requesting repair ${attempt}/2`)
    const fixed = await callLlm(`${prompt}\n\nPrevious output was invalid JSON: ${String(text).slice(0, 500)}\nReply with ONLY the corrected JSON object.`, env, attempt + 1)
    return validateLlmOut(fixed)
  }
}

// Schema gate: titles render via esc() so markdown would show literally;
// strip it here. Sentence 1 must read plain for non-technical users:
// code tokens there reject the output for one repair pass. Significance
// falls back to the deterministic default.
export function validateLlmOut (out, fallbackSig = 'minor') {
  if (!out || typeof out !== 'object') throw new Error('LLM output not an object')
  const rawTitle = String(out.title || '').trim()
  if (!rawTitle) throw new Error('LLM output missing title')
  const title = truncateWords(rawTitle.replace(/[`*#_[\]]/g, '').replace(/\s+/g, ' '), 70)
  const rawSummary = String(out.summary || '').trim()
  if (!rawSummary) throw new Error('LLM output missing summary')
  if (S1_JARGON_RE.test(firstSentence(rawSummary))) {
    throw new Error(`LLM summary sentence 1 not plain: "${firstSentence(rawSummary).slice(0, 80)}"`)
  }
  const summary = truncateWords(rawSummary, 1200)
  const significance = ['minor', 'notable', 'major'].includes(out.significance) ? out.significance : fallbackSig
  return { title, summary, significance }
}

function isTransientError (err) {
  const msg = String(err?.message || err || '')
  return /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|502|503|504|timeout/i.test(msg)
}

export async function enrichWithLlm (entries, getPatch, dataDir, env = process.env, options = {}) {
  if (!llmConfigured(env)) return 0
  const cachePath = `${dataDir}/ai-summaries.json`
  const cache = await readJson(cachePath, {})
  const limit = Number(env.CHANGELOG_LLM_LIMIT || 60)
  const concurrency = Number(env.CHANGELOG_LLM_CONCURRENCY || 5)
  const errorCooldownMs = Number(env.CHANGELOG_LLM_ERROR_COOLDOWN_MS || 3600000)
  let apiCalls = 0
  let cacheModified = false

  // User-visible work first: models, releases, commands — then newest.
  // Recency-only ordering buried a model swap behind dozens of minors.
  const prio = (e) => (e.modelChanges ? 0 : e.version ? 1 : e.cmdChanges ? 2 : 3)
  const syncEntries = entries.filter(e => e.kind === 'sync')
  syncEntries.sort((a, b) => prio(a) - prio(b) || (a.date < b.date ? 1 : -1))

  // Fetch patches in parallel (git-bound, independent) before queueing.
  // Entries without a prompt version predate versioning: re-summarize once.
  const isCurrent = (e) => e.ai?.model && (e.ai?.v ?? 1) >= PROMPT_V
  const patches = await pool(syncEntries.map(e => async () => {
    if (isCurrent(e)) return ''
    try { return await getPatch(e) } catch { return '' }
  }), 8)

  const queue = []
  for (let qi = 0; qi < syncEntries.length; qi++) {
    const e = syncEntries[qi]
    if (isCurrent(e)) continue
    const patch = patches[qi]
    if (!patch) continue
    const key = cacheKey(e.sha, patch)
    const cached = cache[key]
    if (cached?.error) {
      // Failed entries cool down before retrying: a 60s watch loop must not
      // re-hit a failing endpoint on every cycle.
      if (!options.retryErrors) continue
      const failedAt = Date.parse(cached.at || '') || 0
      if (Date.now() - failedAt < errorCooldownMs) continue
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
  let isOffline = false

  async function worker () {
    while (activeIndex < queue.length && !isOffline) {
      const idx = activeIndex++
      const { entry: e, patch, key } = queue[idx]
      try {
        const out = await callLlm(buildPrompt(e, patch), env)
        const clean = validateLlmOut(out, e.significance || 'minor')
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
        log(`LLM failed for ${e.sha.slice(0, 8)}: ${err.message}`)
        if (isTransientError(err)) {
          isOffline = true
          log(`LLM endpoint appears offline (${err.message}): skipping further attempts this run`)
          break
        }
        cache[key] = { error: String(err.message).slice(0, 200), at: new Date().toISOString() }
        cacheModified = true
      }
    }
  }

  const poolSize = Math.min(concurrency, queue.length)
  await Promise.all(Array.from({ length: poolSize }, () => worker()))

  if (cacheModified) {
    await writeJson(cachePath, cache)
  }
  return apiCalls
}
