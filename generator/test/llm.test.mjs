// generator/test/llm.test.mjs - tests for the LLM enrichment module
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLlmJson, buildPrompt, enrichWithLlm, llmConfigured, validateLlmOut, truncateWords, budgetPatch, cacheKey, PROMPT_V } from '../lib/llm.mjs'

test('parseLlmJson: parses standard JSON object', () => {
  const json = '{"title": "New feature", "summary": "Added cool stuff", "significance": "major"}'
  const res = parseLlmJson(json)
  assert.equal(res.title, 'New feature')
  assert.equal(res.significance, 'major')
})

test('parseLlmJson: safely parses JSON wrapped in markdown code fences', () => {
  const fence = 'Here is the changelog entry:\n```json\n{\n  "title": "Model update",\n  "summary": "Updated model",\n  "significance": "notable"\n}\n```\nHope that helps!'
  const res = parseLlmJson(fence)
  assert.equal(res.title, 'Model update')
  assert.equal(res.significance, 'notable')
})

test('parseLlmJson: safely parses OpenAI response envelope with trailing SSE data: [DONE]', () => {
  const envelope = '{"id":"chatcmpl-123","choices":[{"message":{"content":"{\\"title\\":\\"AI Feature\\",\\"summary\\":\\"Summary text\\",\\"significance\\":\\"minor\\"}"}}]}data: [DONE]\n\n'
  const parsed = parseLlmJson(envelope)
  assert.equal(parsed.id, 'chatcmpl-123')
  const content = parseLlmJson(parsed.choices[0].message.content)
  assert.equal(content.title, 'AI Feature')
  assert.equal(content.significance, 'minor')
})

test('parseLlmJson: throws when no JSON object is found', () => {
  assert.throws(() => parseLlmJson('no json here'), /LLM returned no JSON/)
  assert.throws(() => parseLlmJson('} inverted {'), /LLM returned no JSON/)
})

test('llmConfigured: checks CHANGELOG_LLM and LLM_API_KEY from env', () => {
  assert.equal(llmConfigured({ CHANGELOG_LLM: '1', LLM_API_KEY: 'test-key' }), true)
  assert.equal(llmConfigured({ CHANGELOG_LLM: '0', LLM_API_KEY: 'test-key' }), false)
  assert.equal(llmConfigured({ CHANGELOG_LLM: '1', LLM_API_KEY: '' }), false)
  assert.equal(llmConfigured({}), false)
})

test('buildPrompt: includes diff, date, model changes, files, stats', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z',
    areas: ['CLI', 'Model Catalog'],
    category: 'Model Catalog',
    significance: 'major',
    stats: { additions: 5, deletions: 5 },
    files: { added: [], modified: ['README.md'] },
    summary: 'Model catalog: Muse Spark 1.3 added.',
    modelChanges: { added: ['Muse Spark 1.3'], removed: [] }
  }
  const prompt = buildPrompt(entry, 'diff --git a/x b/x\n+new line')
  assert.match(prompt, /Muse Spark 1\.3/)
  assert.match(prompt, /CLI, Model Catalog/)
  assert.match(prompt, /diff --git a\/x b\/x/)
  assert.match(prompt, /plain text, max 70 chars, no backticks/)
  assert.match(prompt, /Files: README\.md/)
  assert.match(prompt, /Stats: \+5 \/ -5/)
})

test('error cooldown: recent failures are not retried', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-test-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const sha = 'a'.repeat(40)
  const patch = 'diff --git a/x b/x\n+new line\n'
  const key = cacheKey(sha, patch)
  await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: { error: 'LLM HTTP 429', at: new Date().toISOString() } }))
  const entries = [{ kind: 'sync', sha, date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'CLI change.' }]
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'test-key', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
  let fetchCalls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { fetchCalls++; return origFetch(...args) }
  try {
    const n = await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.equal(n, 0)
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('error cooldown: old failures retry after cooldown', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-test-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const sha = 'b'.repeat(40)
  const patch = 'diff --git a/y b/y\n+other line\n'
  const key = cacheKey(sha, patch)
  await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: { error: 'LLM HTTP 429', at: '2020-01-01T00:00:00.000Z' } }))
  const entries = [{ kind: 'sync', sha, date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'CLI change.' }]
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'test-key', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
  let fetchCalls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { fetchCalls++; return origFetch(...args) }
  try {
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.ok(fetchCalls >= 1)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('cacheKey: prompt version embedded so prompt edits invalidate', () => {
  const key = cacheKey('a'.repeat(40), 'patch')
  assert.match(key, new RegExp(`:v${PROMPT_V}:`))
  assert.ok(PROMPT_V >= 1)
})

test('validateLlmOut: strips markdown from title, falls back significance', () => {
  const out = validateLlmOut({ title: '`Fix` the **thing** with trailing period.', summary: 'Did stuff.', significance: 'bogus' }, 'notable')
  assert.ok(!out.title.includes('`'))
  assert.ok(!out.title.includes('**'))
  assert.equal(out.significance, 'notable')
  assert.ok(out.summary.length > 0)
})

test('validateLlmOut: rejects missing title or summary', () => {
  assert.throws(() => validateLlmOut({ title: '', summary: 'x' }), /missing title/)
  assert.throws(() => validateLlmOut({ title: 'x', summary: '' }), /missing summary/)
  assert.throws(() => validateLlmOut(null), /not an object/)
})

test('truncateWords: never slices mid-word', () => {
  assert.equal(truncateWords('alpha beta gamma delta', 12), 'alpha beta')
  assert.equal(truncateWords('short', 100), 'short')
})

test('budgetPatch: per-file budget preserves heads, marks truncation', () => {
  const f1 = 'diff --git a/1 b/1\n' + '+x\n'.repeat(2000)
  const f2 = 'diff --git a/2 b/2\n+y\n'
  const out = budgetPatch(f1 + f2, 5000, 3000)
  assert.match(out, /diff --git a\/1/)
  assert.match(out, /diff --git a\/2/)
  assert.match(out, /file truncated/)
  assert.ok(out.length < f1.length + f2.length)
})

test('budgetPatch: single-file patch passes through under budget', () => {
  const p = 'diff --git a/x b/x\n+line\n'
  assert.equal(budgetPatch(p), p)
})

// Golden eval: prompt must ground the model in verifiable signals.
// A model rename buried in the diff is the classic hallucination risk:
// the prompt must carry the catalog facts so the summary cannot invent them.
test('golden: model-swap prompt carries catalog facts, no invented names', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z',
    areas: ['Shared/Core'],
    category: 'Model Catalog',
    significance: 'major',
    stats: { additions: 12, deletions: 12 },
    files: { added: [], modified: ['README.md', 'README.zh-CN.md'] },
    summary: 'Model catalog: Muse Spark 1.3 replaced Muse Spark 1.2.',
    modelChanges: { added: ['Muse Spark 1.3'], removed: ['Muse Spark 1.2'] }
  }
  const prompt = buildPrompt(entry, 'diff --git a/README.md b/README.md\n-| **Muse Spark 1.2** | Full |\n+| **Muse Spark 1.3** | Full |')
  assert.match(prompt, /Model catalog: \+Muse Spark 1\.3 -Muse Spark 1\.2/)
  assert.match(prompt, /use ONLY facts from the diff/)
  // No model names beyond what the entry and diff provide
  assert.doesNotMatch(prompt, /GPT-5|Gemini|DeepSeek|GLM|MiniMax|Solar|MiMo/)
})

test('golden: command prompt carries slash-command facts', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z',
    areas: ['CLI'],
    category: 'Commands',
    significance: 'notable',
    stats: { additions: 30, deletions: 2 },
    files: { added: [], modified: ['cli/src/data/slash-commands.ts'] },
    summary: 'New slash command /byok.',
    cmdChanges: { added: ['/byok'], removed: [] }
  }
  const prompt = buildPrompt(entry, 'diff --git a/cli/src/data/slash-commands.ts\n+    id: \'byok\',')
  assert.match(prompt, /Slash commands: \+\/byok/)
  assert.match(prompt, /cli\/src\/data\/slash-commands\.ts/)
})
