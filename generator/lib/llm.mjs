// generator/lib/llm.mjs — optional AI rewrite layer.
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

export function llmConfigured () {
  return process.env.CHANGELOG_LLM === '1' && !!process.env.LLM_API_KEY
}

function patchHash (patch) {
  return createHash('sha1').update(patch).digest('hex').slice(0, 12)
}

function buildPrompt (entry, patch) {
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
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''
  const jsonStart = text.indexOf('{')
  if (jsonStart === -1) throw new Error('LLM returned no JSON')
  return JSON.parse(text.slice(jsonStart))
}

export async function enrichWithLlm (entries, getPatch, dataDir, env = process.env) {
  if (!llmConfigured()) return 0
  const cachePath = `${dataDir}/ai-summaries.json`
  const cache = await readJson(cachePath, {})
  const limit = Number(env.CHANGELOG_LLM_LIMIT || 60)
  let done = 0
  for (const e of entries) {
    if (done >= limit) break
    if (e.kind !== 'sync') continue
    if (e.ai?.model) continue
    const patch = await getPatch(e)
    if (!patch) continue
    const key = `${e.sha}:${patchHash(patch)}`
    if (cache[key]?.error) continue
    if (cache[key]) {
      e.ai = { model: cache[key].model, title: cache[key].title, summary: cache[key].summary, significance: cache[key].significance, at: cache[key].at }
      done++
      continue
    }
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
      done++
      log(`LLM summarized ${e.sha.slice(0, 8)}`)
    } catch (err) {
      cache[key] = { error: String(err.message).slice(0, 200) }
      log(`LLM failed for ${e.sha.slice(0, 8)}: ${err.message}`)
    }
    await writeJson(cachePath, cache)
  }
  await writeJson(cachePath, cache)
  return done
}
