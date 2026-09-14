// generator/lib/llm.mjs - optional AI rewrite layer.
//
// Deterministic analysis already produces accurate entries; this layer makes
// them *readable*. It is strictly enrichment: per-commit results are cached in
// data/ai-summaries.json keyed by commit sha + patch hash, so each commit is
// summarized at most once, forever. If no provider is configured, everything
// still works with deterministic summaries.
//
// Config (env):
//   CHANGELOG_LLM=1            enable
//   LLM_API_KEY                bearer key (or GitHub Models PAT: ghp_...)
//   LLM_API_BASE               default https://api.github.com (GitHub Models,
//                              free tier; any OpenAI-compatible base works)
//   LLM_MODEL                  default github:gpt-4o-mini
//   CHANGELOG_LLM_LIMIT        max commits summarized per run (default 60)
import { createHash } from 'node:crypto'
import { readJson, writeJson, log } from './util.mjs'

export function llmConfigured (env = process.env) {
  return env.CHANGELOG_LLM === '1' && !!env.LLM_API_KEY
}

function patchHash (patch) {
  return createHash('sha1').update(patch).digest('hex').slice(0, 12)
}

export function buildPrompt (entry, patch) {
  return [
    'You write changelog entries for Freebuff, a free AI coding agent, based on the exact diff a sync bot pushed to the public repo.',
    'Rules: use ONLY facts from the diff and the analysis notes below. Never invent file names, features, or versions.',
    'Output a JSON object: {"title": "<max 70 chars, what changed for USERS if visible, else for contributors>", "summary": "<1-3 sentences of plain markdown>", "significance": "minor|notable|major"}.',
    'major = new feature, model added/removed, security, breaking. notable = user-visible behavior/UI change, new file, API change. minor = internal, refactor, types, comments, deps.',
    '',
    `Date: ${entry.date}`,
    `Areas: ${entry.areas.join(', ')}`,
    `Analysis notes: ${entry.summary}`,
    entry.modelChanges ? `Model catalog: +${entry.modelChanges.added.join(', ')} -${entry.modelChanges.removed.join(', ')}` : '',
    '',
    'Diff (bun.lock and pure test hunks omitted):',
    '```diff',
    patch.slice(0, 12000),
    '```'
  ].filter(Boolean).join('\n')
}

export function parseLlmJson (text) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('LLM returned no JSON')
  }
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1))
}

async function callLlm (prompt, env) {
  const base = env.LLM_API_BASE || 'https://api.openai.com/v1'
  const model = env.LLM_MODEL || 'gpt-4o-mini'
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(60000)
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const rawText = await res.text()
  const data = parseLlmJson(rawText)
  const text = data.choices?.[0]?.message?.content ?? ''
  return parseLlmJson(text)
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

  // Prioritize newest entries first so latest releases & days receive summaries
  const syncEntries = entries.filter(e => e.kind === 'sync').reverse()

  const queue = []
  for (const e of syncEntries) {
    if (e.ai?.model) continue
    const patch = await getPatch(e)
    if (!patch) continue
    const key = `${e.sha}:${patchHash(patch)}`
    const cached = cache[key]
    if (cached?.error) {
      // Failed entries cool down before retrying: a 60s watch loop must not
      // re-hit a failing endpoint on every cycle.
      if (!options.retryErrors) continue
      const failedAt = Date.parse(cached.at || '') || 0
      if (Date.now() - failedAt < errorCooldownMs) continue
    }
    if (cached && !cached.error) {
      e.ai = { model: cache[key].model, title: cache[key].title, summary: cache[key].summary, significance: cache[key].significance, at: cache[key].at }
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
        cache[key] = {
          model: env.LLM_MODEL || 'gpt-4o-mini',
          title: String(out.title || '').slice(0, 90),
          summary: String(out.summary || '').slice(0, 800),
          significance: ['minor', 'notable', 'major'].includes(out.significance) ? out.significance : 'minor',
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
