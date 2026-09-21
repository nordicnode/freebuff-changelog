// generator/test/llm.test.mjs - tests for the LLM enrichment module
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLlmJson, sanitizeJsonText, buildPrompt, enrichWithLlm, enrichEli5, llmConfigured, validateLlmOut, truncateWords, budgetPatch, cacheKey, firstSentence, isTransientError, isGatewayError, pruneExpiredErrors, shortError, PROMPT_V, ELI5_V, eli5Eligible, eli5Done, eli5Source, eli5Key, normalizeEli5, buildEli5Prompt, eli5Notes, eli5Patch, loadPrIndex, findPrMeta, groupEntriesByDay, sequenceForEntry, FREEBUFF_ARCHITECTURE_MAP, FREEBUFF_DOMAIN_LEXICON, ELI5_ROLLUP_MAX_CHARS } from '../lib/llm.mjs'
import { shortHash } from '../lib/util.mjs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('shortError: collapses HTML error pages to status line', () => {
  assert.equal(shortError(new Error('LLM HTTP 522: <!DOCTYPE html>\n<html>...')), 'LLM HTTP 522')
  assert.equal(shortError(new Error('fetch failed')), 'fetch failed')
})

test('isTransientError: 5xx gateway family, network faults transient', () => {
  // 525/526/527/530 matter: the endpoint is behind a cloudflared tunnel, and
  // 530 is what a tunnel blip actually returns.
  for (const code of [500, 502, 503, 504, 507, 508, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
    assert.ok(isTransientError(new Error(`LLM HTTP ${code}: <html>`)), `HTTP ${code} transient`)
  }
  assert.ok(isTransientError(new Error('fetch failed')))
  assert.ok(isTransientError(new Error('socket hang up')))
  assert.ok(isTransientError(new Error('ECONNRESET')))
  assert.ok(isTransientError(new Error('The operation was aborted due to timeout')))
  assert.ok(!isTransientError(new Error('LLM HTTP 400: bad request')))
  assert.ok(!isTransientError(new Error('LLM HTTP 429: too many')))
  // Anchored: a payload that merely contains gateway-looking digits is not one.
  assert.ok(!isTransientError(new Error('LLM HTTP 400: {"upstream":"502 seen at proxy"}')))
})

test('isTransientError: JSON parse and malformed output errors are transient', () => {
  assert.ok(isTransientError(new Error('Bad escaped character in JSON at position 236 (line 1 column 237)')))
  assert.ok(isTransientError(new Error('Unexpected token \'C\', ..." "title": CLI 1.0.62"... is not valid JSON')))
  assert.ok(isTransientError(new Error('LLM returned no JSON')))
  assert.ok(isTransientError(new SyntaxError('Unexpected end of JSON input')))
  // Validation schema errors are permanent (not transient)
  assert.ok(!isTransientError(new Error('LLM title contains raw identifier')))
  assert.ok(!isTransientError(new Error('LLM summary contains no-action boilerplate')))
  assert.ok(!isTransientError(new Error('ELI5 rejected: output contains roll-up boilerplate')))
})

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

test('parseLlmJson: resiliently repairs invalid escape sequences, bad unicode, and control characters', () => {
  // Invalid escape \x20 (the exact error from entry ac85e181)
  const badEscape = '{"eli5": "Code \\x20 sample and regex \\d+ and path \\user\\bin"}'
  const res1 = parseLlmJson(badEscape)
  assert.ok(res1.eli5.includes('Code'))
  assert.ok(res1.eli5.includes('\\x20'))
  assert.ok(res1.eli5.includes('\\d+'))

  // Unescaped literal newlines and tabs inside string literal
  const unescapedCtrl = '{\n  "title": "Title",\n  "summary": "Line 1\nLine 2\twith tab"\n}'
  const res2 = parseLlmJson(unescapedCtrl)
  assert.equal(res2.title, 'Title')
  assert.equal(res2.summary, 'Line 1\nLine 2\twith tab')

  // Trailing commas in objects and arrays
  const trailingComma = '{"title": "Valid", "items": [1, 2, ], }'
  const res3 = parseLlmJson(trailingComma)
  assert.equal(res3.title, 'Valid')
  assert.deepEqual(res3.items, [1, 2])
})

test('pruneExpiredErrors: prunes errors past cooldown, preserves active and valid entries', () => {
  const now = Date.parse('2026-09-18T16:00:00.000Z')
  const cache = {
    // Expired transient error (6 min old, limit is 5 min)
    'k1': { error: '503', transient: true, at: new Date(now - 6 * 60000).toISOString() },
    // Active transient error (2 min old, limit is 5 min)
    'k2': { error: '503', transient: true, at: new Date(now - 2 * 60000).toISOString() },
    // Expired permanent error (70 min old, limit is 60 min)
    'k3': { error: 'bad output', at: new Date(now - 70 * 60000).toISOString() },
    // Active permanent error (30 min old, limit is 60 min)
    'k4': { error: 'bad output', at: new Date(now - 30 * 60000).toISOString() },
    // Valid summary entry (should never be pruned)
    'k5': { title: 'Summary', summary: 'Text', at: new Date(now - 120 * 60000).toISOString() }
  }

  const pruned = pruneExpiredErrors(cache, { now })
  assert.equal(pruned, 2)
  assert.equal(cache.k1, undefined, 'k1 expired transient pruned')
  assert.ok(cache.k2, 'k2 active transient retained')
  assert.equal(cache.k3, undefined, 'k3 expired permanent pruned')
  assert.ok(cache.k4, 'k4 active permanent retained')
  assert.ok(cache.k5, 'k5 valid entry retained')
})

test('extractResponseText: reassembles SSE delta chunks into message text', async () => {
  const { extractResponseText } = await import('../lib/llm.mjs')
  const sse = 'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"{\\"title\\": \\"AI"},"finish_reason":null}]}\n'
    + 'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" Feature\\", \\"summary\\": \\"x\\", \\"significance\\": \\"minor\\"}"},"finish_reason":null}]}\n'
    + 'data: [DONE]\n\n'
  assert.equal(parseLlmJson(extractResponseText(sse)).title, 'AI Feature')
  const plain = '{"id":"chatcmpl-123","choices":[{"message":{"content":"{\\"title\\":\\"AI Feature\\",\\"summary\\":\\"x\\",\\"significance\\":\\"minor\\"}"}}]}'
  assert.equal(parseLlmJson(extractResponseText(plain)).title, 'AI Feature')
})

test('extractResponseText: unwraps a { data: { choices } } envelope', async () => {
  const { extractResponseText } = await import('../lib/llm.mjs')
  // The cl/cline-free gateway answers 200 with the completion nested one level
  // down and `data: [DONE]` appended, so a top-level `choices` read finds nothing.
  const inner = '{"title":"Ads fetch log fields","summary":"x","significance":"minor"}'
  const enveloped = '{"data":{"choices":[{"finish_reason":"stop","index":0,"message":'
    + JSON.stringify({ content: inner }) + '}],"model":"deepseek/deepseek-v4.1-flash"},"success":true}\ndata: [DONE]\n'
  assert.equal(parseLlmJson(extractResponseText(enveloped)).title, 'Ads fetch log fields')
  // Same envelope, no `data:` line at all.
  const bare = '{"data":{"choices":[{"message":' + JSON.stringify({ content: inner }) + '}]},"success":true}'
  assert.equal(parseLlmJson(extractResponseText(bare)).title, 'Ads fetch log fields')
  // Enveloped SSE deltas reassemble too.
  const envSse = 'data: {"data":{"choices":[{"delta":{"content":"{\\"title\\": \\"Nested"}}]}}\n'
    + 'data: {"data":{"choices":[{"delta":{"content":" deltas\\"}"}}]}}\n'
  assert.equal(parseLlmJson(extractResponseText(envSse)).title, 'Nested deltas')
  assert.throws(() => extractResponseText('{"data":{"choices":[]}}'), /no JSON/)
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
  assert.match(prompt, /TECHNICAL user/)
  assert.match(prompt, /technical prose, backticks allowed/)
  assert.match(prompt, /Never write "Nothing to do"/)
  assert.match(prompt, /GOOD \(technical, precise/)
  assert.match(prompt, /Modified files: README\.md/)
  assert.match(prompt, /Stats: \+5 \/ -5/)
})

test('buildPrompt: passes facts and commands into context', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z',
    areas: ['CLI'],
    category: 'Commands',
    significance: 'notable',
    stats: { additions: 3, deletions: 1 },
    files: { added: [], modified: ['cli/src/data/slash-commands.ts'] },
    summary: 'New slash command /byok.',
    cmdChanges: { added: ['/byok'], removed: [] },
    facts: ['The byok command lets users bring their own key.']
  }
  const prompt = buildPrompt(entry, 'diff')
  assert.match(prompt, /Key facts.*bring their own key/)
  assert.match(prompt, /Slash commands: \+\/byok/)
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
test('firstSentence: extracts leading sentence', () => {
  assert.equal(firstSentence('Muse Spark is back. Nothing to do.'), 'Muse Spark is back.')
  assert.equal(firstSentence('What changed? Details follow!'), 'What changed?')
  assert.equal(firstSentence('No punctuation here'), 'No punctuation here')
})

test('validateLlmOut: rejects no-action boilerplate', () => {
  const boiler = 'Muse Spark 1.2 replaces 1.3 in the picker. Nothing to do: saved choices carry over.'
  assert.throws(() => validateLlmOut({ title: 'Model swap', summary: boiler }, 'major'), /boilerplate/)
  const boiler2 = 'CLI flag added. No action needed.'
  assert.throws(() => validateLlmOut({ title: 'Flag', summary: boiler2 }, 'notable'), /boilerplate/)
})

test('validateLlmOut: accepts technical summary with identifiers', () => {
  const good = 'Muse Spark 1.2 replaces 1.3 in the free model picker after 1.3 began returning upstream 404 model_not_found errors. Saved 1.2 preferences migrate on load; existing live sessions keep running. Covers Web, CLI, and Desktop via FREEBUFF_MODELS plus README tables.'
  const out = validateLlmOut({ title: 'Muse Spark 1.2 replaces 1.3', summary: good }, 'major')
  assert.equal(out.significance, 'major')
  assert.ok(out.summary.length > 200)
})

test('golden: model-swap prompt carries catalog facts, no invented names', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z',
    areas: ['Shared/Core'],
    category: 'Model Catalog',
    significance: 'major',
    stats: { additions: 12, deletions: 12 },
    files: { added: [], modified: ['README.md', 'README.zh-CN.md'] },
    summary: 'Model catalog: Muse Spark 1.3 replaced Muse Spark 1.2.',
    modelChanges: {
      added: ['Muse Spark 1.3'],
      removed: ['Muse Spark 1.2'],
      tables: {
        'Muse Spark 1.3': { before: null, after: ['Muse Spark 1.3', 'Full access', 'Fast all-round pick'] },
        'Muse Spark 1.2': { before: ['Muse Spark 1.2', 'Limited access', 'Legacy row'], after: null }
      }
    }
  }
  const prompt = buildPrompt(entry, 'diff --git a/README.md b/README.md\n-| **Muse Spark 1.2** | Full |\n+| **Muse Spark 1.3** | Full |')
  assert.match(prompt, /Model catalog: \+Muse Spark 1\.3 -Muse Spark 1\.2/)
  assert.match(prompt, /use ONLY facts from the diff/)
  assert.match(prompt, /Model rows.*Fast all-round pick/)
  assert.match(prompt, /Model rows.*Legacy row/)
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

test('transient failure: parked for a short retry window instead of re-hitting every cycle', async (t) => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-transient-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })

  const sha = 'c'.repeat(40)
  const patch = 'diff --git a/z b/z\n+line\n'
  const key = cacheKey(sha, patch)
  const entries = [{ kind: 'sync', sha, date: '2026-09-14T10:00:00Z', areas: ['CLI'], summary: 'CLI change.' }]
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = async (...a) => { calls++; return orig(...a) }
  try {
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.ok(calls >= 1, 'a fresh entry is attempted once')
    const cached = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.ok(cached[key].error, 'the failure is recorded')
    assert.equal(cached[key].transient, true, 'a gateway blip is marked transient, not fatal')

    // Next cycle, inside the retry window: must not spend a call on it again.
    const before = calls
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.equal(calls, before, 'no repeat attempt while parked')

    // Backdate past the transient window: it is retried, not parked for an hour.
    cached[key].at = new Date(Date.now() - 6 * 60000).toISOString()
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify(cached))
    const again = calls
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.ok(calls > again, 'retried once the short window passes')
  } finally {
    globalThis.fetch = orig
  }
})

test('transient failure: a one-shot run (no retryErrors) does not park the entry', async (t) => {
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-oneshot-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const sha = 'd'.repeat(40)
  const patch = 'diff --git a/w b/w\n+line\n'
  const entries = [{ kind: 'sync', sha, date: '2026-09-14T10:00:00Z', areas: ['CLI'], summary: 'CLI change.' }]
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
  await enrichWithLlm(entries, async () => patch, dir, env, {})
  const cached = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8').catch(() => '{}'))
  assert.equal(Object.keys(cached).length, 0, 'the daemon must stay free to retry what the workflow could not')
})

test('priorityShas: new commits jump the backlog and patch work stays bounded', async (t) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-prio-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })

  const freshSha = 'f'.repeat(40)
  const backlog = Array.from({ length: 40 }, (_, i) => ({
    kind: 'sync', sha: `${i.toString(16).padStart(2, '0')}`.padEnd(40, '0'),
    date: `2026-09-${String(1 + (i % 27)).padStart(2, '0')}T10:00:00Z`,
    areas: ['CLI'], summary: 'Old change.'
  }))
  const fresh = { kind: 'sync', sha: freshSha, date: '2026-09-14T15:00:00Z', areas: ['CLI'], summary: 'Just landed.' }
  const entries = [...backlog, fresh]
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '2' }
  const patched = []
  const orig = globalThis.fetch
  globalThis.fetch = async (...a) => { await Promise.resolve(); return orig(...a) }
  try {
    await enrichWithLlm(entries, async (e) => { patched.push(e.sha); return 'diff --git a/x b/x\n+new\n' }, dir, env, {
      retryErrors: true, priorityShas: new Set([freshSha])
    })
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(patched[0], freshSha, 'the new commit is diffed and queued first')
  assert.ok(patched.length <= Math.max(2 * 4, 2 + 5), `patch work bounded to the run window, got ${patched.length} of ${entries.length}`)
  assert.ok(patched.length < entries.length, 'the whole backlog is not diffed to fill 2 slots')
})

// Coverage, not just freshness: the sync-only filter is what left 913 of 9,527
// entries without a summary. Community commits have real parent-to-commit diffs
// in the clone, so they belong in the queue; churn rows do not, because their
// clean patch is empty by construction.
test('the summary queue covers every kind of entry, churn excepted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-kinds-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const community = { kind: 'community', sha: 'c'.repeat(40), date: '2024-07-09T10:00:00Z', areas: ['CLI'], summary: 'Community commit.' }
  const sync = { kind: 'sync', sha: 'a'.repeat(40), date: '2026-09-14T10:00:00Z', areas: ['CLI'], summary: 'Sync commit.' }
  const churn = { kind: 'sync', sha: 'b'.repeat(40), noise: true, date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'lockfile' }
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
  const patched = []
  const orig = globalThis.fetch
  globalThis.fetch = async (...a) => { await Promise.resolve(); return orig(...a) }
  try {
    await enrichWithLlm([churn, community, sync], async (e) => { patched.push(e.sha); return 'diff --git a/x b/x\n+new\n' }, dir, env, { retryErrors: true })
  } finally { globalThis.fetch = orig }
  assert.ok(patched.includes(community.sha), 'a community commit is diffed and queued')
  assert.ok(patched.includes(sync.sha), 'sync snapshots still queue')
  assert.ok(!patched.includes(churn.sha), 'churn stays out of the queue without CHANGELOG_LLM_CHURN=1')
})

test('CHANGELOG_LLM_CHURN=1 admits churn rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-churn-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const churn = { kind: 'sync', sha: 'b'.repeat(40), noise: true, date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'lockfile' }
  const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5', CHANGELOG_LLM_CHURN: '1' }
  const patched = []
  const orig = globalThis.fetch
  globalThis.fetch = async (...a) => { await Promise.resolve(); return orig(...a) }
  try {
    await enrichWithLlm([churn], async (e) => { patched.push(e.sha); return 'diff --git a/bun.lock b/bun.lock\n+1\n' }, dir, env, { retryErrors: true })
  } finally { globalThis.fetch = orig }
  assert.deepEqual(patched, [churn.sha], 'the flag sends lockfile rows with their raw diff')
})

// A full backfill runs uncapped, but "uncapped" may not mean "diff every entry
// in the repository to pick this pass's dozen": the window stays bounded.
test('CHANGELOG_LLM_LIMIT=0 drops the call cap but keeps the git window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-nocap-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const rows = Array.from({ length: 40 }, (_, i) => ({
    kind: i % 2 ? 'community' : 'sync', sha: `${i.toString(16).padStart(2, '0')}`.padEnd(40, '0'),
    date: `2026-09-${String(1 + (i % 27)).padStart(2, '0')}T10:00:00Z`, areas: ['CLI'], summary: 'Change.'
  }))
  const orig = globalThis.fetch
  const run = async (limit) => {
    const patched = []
    globalThis.fetch = async (...a) => { await Promise.resolve(); return orig(...a) }
    try {
      await enrichWithLlm(rows, async (e) => { patched.push(e.sha); return 'diff --git a/x b/x\n+new\n' }, dir, { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: limit }, { retryErrors: true })
    } finally { globalThis.fetch = orig }
    return patched.length
  }
  assert.ok(await run('5') < 40, 'a capped pass does not touch the whole backlog')
  assert.equal(await run('0'), 40, 'limit 0 queues everything the window allows')
})

// ---------------------------------------------------------------------------
// ELI5: the plain-English pass. It follows the summary -- the cache key hashes it,
// so it re-runs exactly when that summary changes -- and it reads the same stored
// diff the summarizer saw, because a line written from the summary alone can only
// repeat the summary.

const eli5Entry = (over = {}) => ({
  kind: 'sync',
  sha: 'e'.repeat(40),
  date: '2026-09-13T10:00:00Z',
  day: '2026-09-13',
  category: 'CLI',
  areas: ['CLI'],
  significance: 'minor',
  summary: 'CLI change.',
  ai: { model: 'gpt', v: PROMPT_V, title: 'A new model is supported', summary: 'The snapshot now offers an additional model to the assistant.' },
  ...over
})

test('eli5Eligible: only entries with a current technical summary', () => {
  assert.equal(eli5Eligible(eli5Entry()), true)
  assert.equal(eli5Eligible(eli5Entry({ noise: true, churn: 'lockfile' })), false, 'churn has nothing to explain')
  assert.equal(eli5Eligible(eli5Entry({ ai: undefined })), false, 'community rows never went through the model')
  assert.equal(eli5Eligible(eli5Entry({ ai: { v: PROMPT_V - 1, title: 't', summary: 's' } })), false,
    'an entry that is about to be re-summarized waits for the newer summary')
})

test('eli5Done: pinned to the exact summary the line was written from', () => {
  const e = eli5Entry()
  assert.equal(eli5Done(e), false)
  e.eli5 = { text: 'A new model is available.', v: ELI5_V, src: shortHash(eli5Source(e)) }
  assert.equal(eli5Done(e), true)
  e.ai.summary = 'Something entirely different.'
  assert.equal(eli5Done(e), false, 'a re-summarized entry must lose its stale ELI5')
})

test('buildEli5Prompt: hands the model the evidence and the comments, and bars what it must not do', () => {
  const e = eli5Entry({
    significance: 'notable',
    stats: { additions: 104, deletions: 14 },
    files: { total: 3, meaningful: 1, added: [], modified: ['common/src/ads/pilot.ts'], churned: ['bun.lock'] },
    version: '0.0.175'
  })
  const note = 'Verified YC companies earn one $1,000 credit only after $1,000 is collected.'
  const patch = `diff --git a/common/src/ads/pilot.ts b/common/src/ads/pilot.ts\n+/** ${note} */\n+export const PILOT = 1\n`
  const p = buildEli5Prompt(e, [note], { patch, siblings: ['CLI session restart rotates chat id'], diffBytes: 6000 })
  assert.ok(p.includes(note), 'the sentence from beside the code reaches the prompt')
  assert.match(p, /diff --git a\/common/, 'the diff itself reaches the prompt')
  assert.match(p, /104 lines added, 14 removed across 1 file/, 'the size the analyzer measured, counting only the files the change touches')
  assert.match(p, /Where it landed: common\/src\/ads\/pilot\.ts/)
  assert.match(p, /not part of this change: bun\.lock/, 'lockfile churn is labelled as not the change')
  assert.match(p, /Shipped in version 0\.0\.175/)
  assert.match(p, /CLI session restart rotates chat id/, 'the same snapshot gives it company')
  assert.match(p, /Keep the audience the text gives/)
  assert.match(p, /Never widen it to "users"/)
  assert.match(p, /evidence, not vocabulary/, 'it may read the diff but must not name files')
  assert.match(p, /follow the diff/, 'the diff outranks the summary where they disagree')
  assert.ok(!buildEli5Prompt(e).includes('Comments the developers wrote'), 'no notes, no empty block')
  assert.ok(!buildEli5Prompt(e).includes('```diff'), 'no patch, no empty diff fence')
})

test('eli5Notes: merges the recorded facts with the comments in the patch', () => {
  const note = 'Verified YC companies earn one $1,000 credit only after $1,000 is collected.'
  const e = eli5Entry({ facts: ['Recorded fact.'] })
  assert.deepEqual(eli5Notes(e, `+ /** ${note} */`), ['Recorded fact.', note], 'both, recorded first')
  assert.deepEqual(eli5Notes(e, ''), ['Recorded fact.'])
  assert.deepEqual(eli5Notes(eli5Entry({ facts: [] }), ''), [], 'nothing to say beyond the summary')
  assert.deepEqual(eli5Notes(eli5Entry({ facts: [note] }), `+ /** ${note} */`), [note], 'a comment already recorded as a fact is not said twice')
})

test('eli5Patch: an unreadable diff never fails the pass', async () => {
  assert.equal(await eli5Patch(eli5Entry(), null), '', 'without a patch reader it explains from the summary alone')
  assert.equal(await eli5Patch(eli5Entry(), async () => { throw new Error('no worktree') }), '')
  assert.equal(await eli5Patch(eli5Entry(), async () => 'patch text'), 'patch text')
})

test('enrichEli5: a 5xx retry keeps the eli5 validator (not the summary schema)', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-eli5-retry-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  // Fire retry timers immediately: the behavior under test is the validator
  // handoff, not the backoff delay.
  t.mock.method(globalThis, 'setTimeout', (fn, ...args) => { fn(...args); return 0 })
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'bad gateway' }
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ eli5: 'Access moved for that region last week.' }) } }] })
    }
  }
  try {
    const e = eli5Entry()
    assert.equal(await enrichEli5([e], dir, { CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1', LLM_MODEL: 'm' }), 1)
    assert.equal(calls, 2, 'the request was retried once')
    assert.match(e.eli5.text, /Access moved/, 'the retried response was validated as eli5, not rejected as missing a title')
  } finally {
    globalThis.fetch = orig
  }
})

test('release context: bump window stops at the same-track predecessor', async () => {
  const { collectReleaseContext, trackOfBump } = await import('../lib/llm.mjs')
  const feat = (sha, day, title) => ({
    sha, date: `${day}T12:00:00Z`, day, noise: false, significance: 'notable',
    stats: { additions: 50, deletions: 10 },
    files: { total: 2, meaningful: 1, added: [], modified: ['cli/src/x.ts'] },
    title, ai: { model: 'm', v: PROMPT_V, title, summary: `${title} shipped.` }
  })
  const bump176 = eli5Entry({
    sha: '1'.repeat(40), date: '2026-09-17T19:08:31Z', day: '2026-09-17',
    files: { total: 2, meaningful: 1, modified: ['freebuff/cli/release/package.json'] },
    stats: { additions: 3, deletions: 1 },
    ai: { model: 'm', v: PROMPT_V, title: 'Freebuff CLI 0.0.176', summary: 'Manifest bumped to 0.0.176.' }
  })
  const cli688 = eli5Entry({
    sha: '2'.repeat(40), date: '2026-09-17T20:00:00Z', day: '2026-09-17', version: '1.0.688',
    files: { total: 2, meaningful: 1, modified: ['cli/release/package.json'] },
    stats: { additions: 47, deletions: 55 },
    ai: { model: 'm', v: PROMPT_V, title: 'CLI 1.0.688', summary: 'Manifest bumped to 1.0.688.' }
  })
  const bump177 = eli5Entry({
    sha: '3'.repeat(40), date: '2026-09-17T23:17:09Z', day: '2026-09-17',
    files: { total: 2, meaningful: 1, modified: ['freebuff/cli/release/package.json'] },
    stats: { additions: 2, deletions: 4 },
    ai: { model: 'm', v: PROMPT_V, title: 'freebuff CLI 0.0.177', summary: 'Manifest bumped to 0.0.177.' }
  })
  const entries = [
    bump176,
    feat('a'.repeat(40), '2026-09-17', 'Sponsored proposal card guidance'),
    cli688,
    feat('b'.repeat(40), '2026-09-17', 'Model selector list prices'),
    bump177
  ]
  assert.equal(trackOfBump(bump177), 'freebuff-cli')
  assert.equal(trackOfBump(cli688), 'codebuff-cli')
  const ctx = collectReleaseContext(entries, bump177)
  // Sails past the interleaved 1.0.688 bump, stops at 0.0.176, keeps both feats.
  assert.deepEqual(ctx.items.map(i => i.sha), ['a'.repeat(40), 'b'.repeat(40)])
  assert.equal(ctx.prevVersion, null, 'legacy bumps carry no version string to name')
  const ctxCli = collectReleaseContext(entries, cli688)
  assert.deepEqual(ctxCli.items.map(i => i.sha), ['a'.repeat(40)])
})

test('bumpOnly: lockfile churn in stats.additions does not disqualify a release bump', async () => {
  const { bumpOnly, aiDone, RELEASE_ROLLUP_V, PROMPT_V } = await import('../lib/llm.mjs')
  const { shortHash } = await import('../lib/util.mjs')
  const bumpWithLockfile = eli5Entry({
    sha: '1'.repeat(40),
    freebuffVersion: '0.0.178',
    versionTrack: 'freebuff-cli',
    stats: { additions: 54, deletions: 48 },
    files: { total: 2, meaningful: 1, churned: ['bun.lock'], modified: ['freebuff/cli/release/package.json'] }
  })
  assert.equal(bumpOnly(bumpWithLockfile), true, 'bump with lockfile additions is recognized as bumpOnly')

  const bumpWithCodeChanges = eli5Entry({
    sha: '2'.repeat(40),
    freebuffVersion: '0.0.178',
    versionTrack: 'freebuff-cli',
    stats: { additions: 54, deletions: 48 },
    files: { total: 2, meaningful: 2, modified: ['freebuff/cli/release/package.json', 'cli/src/feature.ts'] }
  })
  assert.equal(bumpOnly(bumpWithCodeChanges), false, 'bump with feature code changes and large additions is not bumpOnly')

  const aiNotDone = {
    ai: { model: 'm', v: PROMPT_V, title: 'Bump', summary: 'Bump summary' }
  }
  assert.equal(aiDone(aiNotDone, 'release context text', RELEASE_ROLLUP_V), false, 'ai without rollup metadata re-queues')
  const aiDoneObj = {
    ai: { model: 'm', v: PROMPT_V, title: 'Bump', summary: 'Bump summary', ctx: shortHash('release context text'), rollup: RELEASE_ROLLUP_V }
  }
  assert.equal(aiDone(aiDoneObj, 'release context text', RELEASE_ROLLUP_V), true, 'ai with matching rollup stays done')
})

test('release context: skips noise, caps items and chars, prefers ai text', async () => {
  const { collectReleaseContext } = await import('../lib/llm.mjs')
  const mk = (sha, over = {}) => eli5Entry({
    sha, date: '2026-09-17T10:00:00Z', day: '2026-09-17', significance: 'minor',
    stats: { additions: 5, deletions: 5 },
    files: { total: 1, meaningful: 1, modified: ['cli/src/y.ts'] },
    ai: { model: 'm', v: PROMPT_V, title: `Change ${sha.slice(0, 4)}`, summary: `Change ${sha.slice(0, 4)} landed.` },
    ...over
  })
  const bump = eli5Entry({
    sha: 'f'.repeat(40), version: '1.0.689', date: '2026-09-17T23:00:00Z', day: '2026-09-17',
    stats: { additions: 1, deletions: 1 }, files: { total: 2, meaningful: 1, modified: ['cli/release/package.json'] },
    ai: { model: 'm', v: PROMPT_V, title: 'CLI 1.0.689', summary: 'Manifest bumped.' }
  })
  const noisy = mk('e'.repeat(40), { noise: true })
  const entries = [mk('c'.repeat(40)), noisy, mk('d'.repeat(40)), bump]
  const full = collectReleaseContext(entries, bump)
  assert.ok(!full.items.some(i => i.sha === 'e'.repeat(40)), 'noise excluded')
  assert.equal(full.items.length, 2)
  const capped = collectReleaseContext(entries, bump, { maxItems: 1 })
  assert.equal(capped.items.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.items[0].sha, 'd'.repeat(40), 'newest kept when capped')
  const tiny = collectReleaseContext(entries, bump, { maxChars: 10 })
  assert.equal(tiny.items.length, 0)
  assert.equal(tiny.truncated, true)
})

test('release context: net effect folds catalog events so reversals lose', async () => {
  const { collectReleaseContext, formatReleaseContext, RELEASE_ROLLUP_V } = await import('../lib/llm.mjs')
  const mk = (sha, over = {}) => eli5Entry({
    sha, date: '2026-09-17T10:00:00Z', day: '2026-09-17', significance: 'minor',
    stats: { additions: 5, deletions: 5 },
    files: { total: 1, meaningful: 1, modified: ['cli/src/y.ts'] },
    ai: { model: 'm', v: PROMPT_V, title: `Change ${sha.slice(0, 4)}`, summary: `Change ${sha.slice(0, 4)} landed.` },
    ...over
  })
  const bump = eli5Entry({
    sha: 'f'.repeat(40), version: '1.0.689', date: '2026-09-17T23:00:00Z', day: '2026-09-17',
    stats: { additions: 1, deletions: 1 }, files: { total: 2, meaningful: 1, modified: ['cli/release/package.json'] },
    ai: { model: 'm', v: PROMPT_V, title: 'CLI 1.0.689', summary: 'Manifest bumped.' }
  })
  const addSpark13 = mk('c'.repeat(40), {
    modelChanges: { added: ['Muse Spark 1.3'], removed: [] }
  })
  const swapToSpark12 = mk('d'.repeat(40), {
    modelChanges: { added: ['Muse Spark 1.2'], removed: ['Muse Spark 1.3'] }
  })
  const ctx = collectReleaseContext([addSpark13, swapToSpark12, bump], bump)
  // The 1.3 add lost to the later 1.2 swap: net is 1.2 in, 1.3 out.
  assert.deepEqual(ctx.net.modelsIn, ['Muse Spark 1.2'])
  assert.deepEqual(ctx.net.modelsOut, ['Muse Spark 1.3'])
  // Both item texts still sit in the prompt (context, not truth), but the net
  // lines are present and authoritative, and the ask version rides the key.
  const rel = formatReleaseContext(ctx, bump)
  assert.match(rel, /Muse Spark 1\.3/)
  assert.match(rel, /Free model picker at this release: includes Muse Spark 1\.2; not part of it: Muse Spark 1\.3/)
  assert.match(rel, /overrides any item above it that contradicts/)
  const p = buildEli5Prompt(bump, [], { releaseCtx: rel })
  assert.match(p, /announce only what survives it/)
  assert.match(p, /A release roll-up may run longer/)
  assert.ok(RELEASE_ROLLUP_V >= 3, 'changed roll-up ask implies a version bump')
  // A window with no catalog events formats exactly as before the net lines.
  const plain = collectReleaseContext([mk('c'.repeat(40)), bump], bump)
  assert.equal(plain.net.modelsIn.length + plain.net.modelsOut.length, 0)
  assert.doesNotMatch(formatReleaseContext(plain, bump), /Net effect/)
  // Same-window add+remove cancels to nothing (mirrors the analyzer's net rule).
  const churned = collectReleaseContext([mk('e'.repeat(40), { modelChanges: { added: ['X'], removed: ['X'] } }), bump], bump)
  assert.deepEqual(churned.net.modelsIn, [])
  assert.deepEqual(churned.net.modelsOut, [])
})

test('release context: empty window yields no prompt section and stable keys', async () => {
  const { collectReleaseContext, buildEli5Prompt, eli5Key, eli5Done } = await import('../lib/llm.mjs')
  const bump = eli5Entry({
    sha: '9'.repeat(40), version: '1.0.690', date: '2026-09-17T23:00:00Z', day: '2026-09-17',
    stats: { additions: 1, deletions: 1 }, files: { total: 2, meaningful: 1, modified: ['cli/release/package.json'] },
    ai: { model: 'm', v: PROMPT_V, title: 'CLI 1.0.690', summary: 'Manifest bumped.' }
  })
  const prev = eli5Entry({
    sha: '8'.repeat(40), version: '1.0.689', date: '2026-09-16T23:00:00Z', day: '2026-09-16',
    stats: { additions: 1, deletions: 1 }, files: { total: 2, meaningful: 1, modified: ['cli/release/package.json'] },
    ai: { model: 'm', v: PROMPT_V, title: 'CLI 1.0.689', summary: 'Manifest bumped.' }
  })
  const ctx = collectReleaseContext([prev, bump], bump)
  assert.equal(ctx.items.length, 0)
  assert.equal(ctx.prevVersion, '1.0.689')
  const p = buildEli5Prompt(bump, [], { releaseCtx: '' })
  assert.doesNotMatch(p, /Updates included in this release \([\d.]+/)
  assert.match(p, /Shipped in version 1\.0\.690/)
  assert.equal(eli5Key(bump.sha, 's'), `${bump.sha}:eli5:v${ELI5_V}:${shortHash('s')}`, 'non-context keys unchanged')
  assert.equal(eli5Key(bump.sha, 's', ''), `${bump.sha}:eli5:v${ELI5_V}:${shortHash('s')}`, 'empty window never grows a version segment')
  const p2 = buildEli5Prompt(bump, [], { releaseCtx: 'Updates included in this release (1.0.690 since 1.0.689):\n- one shipped thing' })
  assert.match(p2, /Technical summary.*must not drive the line/s, 'roll-up rule subordinates the label-commit summary to the window')
  assert.equal(
    eli5Key(bump.sha, 's', 'window text', 2),
    `${bump.sha}:eli5:v${ELI5_V}:${shortHash('s')}:${shortHash('window text')}-r2`,
    'contextualized key carries the roll-up ask version'
  )
  assert.equal(
    eli5Key(bump.sha, 's', 'window text', 3),
    `${bump.sha}:eli5:v${ELI5_V}:${shortHash('s')}:${shortHash('window text')}-r3`,
    'bumping RELEASE_ROLLUP_V changes only contextualized keys'
  )
  const done = { ...bump, eli5: { text: 'Housekeeping.', v: ELI5_V, src: shortHash(eli5Source(bump)) } }
  assert.equal(eli5Done(done), true, 'single-arg callers keep old semantics')
  const rollupEntry = { ...bump, eli5: { text: 'x', v: ELI5_V, src: shortHash(eli5Source(bump)), ctx: shortHash('window text') } }
  assert.equal(eli5Done(rollupEntry, 'window text', 2), false, 'a line written under an older roll-up ask re-queues')
  rollupEntry.eli5.rollup = 2
  assert.equal(eli5Done(rollupEntry, 'window text', 2), true, 'matching rollup version stays done')
  assert.equal(eli5Done(rollupEntry, 'window text'), true, 'version-less callers keep hash-only semantics')
})

test('enrichEli5: bump rows carry the release window and refresh when it fills in', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-eli5-relctx-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const env = {
    CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
    LLM_MODEL: 'test-model', CHANGELOG_ELI5_LIMIT: '5'
  }
  const prompts = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    prompts.push(init.body)
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ eli5: 'Updating pulls in sponsored card guidance and list prices.' }) } }] })
    }
  }
  try {
    const featAi = (title) => ({ model: 'm', v: PROMPT_V, title, summary: `${title} shipped.` })
    const feat = eli5Entry({
      sha: 'a'.repeat(40), date: '2026-09-17T21:14:00Z', day: '2026-09-17', significance: 'notable',
      stats: { additions: 134, deletions: 20 }, files: { total: 3, meaningful: 2, modified: ['cli/src/a.ts'] },
      ai: featAi('Sponsored proposal card guidance')
    })
    const bump = eli5Entry({
      sha: 'b'.repeat(40), date: '2026-09-17T23:17:09Z', day: '2026-09-17',
      stats: { additions: 2, deletions: 4 },
      files: { total: 2, meaningful: 1, modified: ['freebuff/cli/release/package.json'] },
      ai: { model: 'm', v: PROMPT_V, title: 'freebuff CLI 0.0.177', summary: 'Manifest bumped to 0.0.177.' }
    })
    const entries = [feat, bump]
    assert.equal(await enrichEli5(entries, dir, env, { retryErrors: true, getPatch: async () => '' }), 2)
    const titleOf = (b) => /Title: ([^\\]*)/.exec(b)?.[1]
    const bumpPrompt = prompts.find(b => titleOf(b) === 'freebuff CLI 0.0.177')
    assert.ok(bumpPrompt, 'the bump row was asked')
    assert.match(bumpPrompt, /Updates included in this release/)
    assert.match(bumpPrompt, /Sponsored proposal card guidance/)
    const featPrompt = prompts.find(b => titleOf(b) === 'Sponsored proposal card guidance')
    assert.ok(featPrompt, 'the feature row was asked too')
    assert.doesNotMatch(featPrompt, /^- Updates included in this release/m)
    assert.ok(bump.eli5.ctx, 'roll-up records its window hash')
    // Second run: window unchanged -> cache hit, no call.
    prompts.length = 0
    const again = [
      { ...feat },
      { ...bump, eli5: { ...bump.eli5 } }
    ]
    assert.equal(await enrichEli5(again, dir, env, { retryErrors: true, getPatch: async () => '' }), 0)
    assert.equal(prompts.length, 0)
    // Predecessor summarized late -> window hash moves -> bump re-queues
    // (the feat row re-queues too, for its own new summary: expect 2).
    const late = { ...feat, ai: { ...feat.ai, summary: 'Sponsored proposal card guidance shipped with setup steps.' } }
    const stale = [{ ...late }, { ...bump, eli5: { ...bump.eli5 } }]
    prompts.length = 0
    assert.equal(await enrichEli5(stale, dir, env, { retryErrors: true, getPatch: async () => '' }), 2)
    assert.ok(prompts.some(b => titleOf(b) === 'freebuff CLI 0.0.177'), 'stale roll-up re-asked')
  } finally {
    globalThis.fetch = orig
  }
})

test('enrichEli5: spends the budget where a story exists, not on version bumps', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-eli5-order-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const env = {
    CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
    LLM_MODEL: 'm', CHANGELOG_ELI5_LIMIT: '2'
  }
  const ai = (title) => ({ model: 'm', v: PROMPT_V, title, summary: 'A version string changed.' })
  // 650 rows in the real backlog look like this: tagged major by the release
  // heuristic, and the only thing they do is raise a number.
  const bump = (i) => eli5Entry({
    sha: String(i).repeat(40), version: `0.0.${i}`, significance: 'major',
    stats: { additions: 2, deletions: 2 }, files: { total: 2, meaningful: 2 }, ai: ai(`Version bump to 1.0.${i}`)
  })
  const entries = [
    bump(1), bump(2), bump(3),
    eli5Entry({ sha: 'a'.repeat(40), facts: ['Verified YC companies earn one credit.'], ai: ai('Credit program rules') }),
    eli5Entry({ sha: 'b'.repeat(40), cmdChanges: { added: ['plan'], removed: [] }, ai: ai('New plan command') })
  ]
  const asked = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    // The body is JSON, so real newlines arrive escaped: stop at the backslash.
    asked.push(/Title: ([^\\]*)/.exec(init.body)[1])
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ eli5: 'The assistant gained a new capability.' }) } }] })
    }
  }
  try {
    assert.equal(await enrichEli5(entries, dir, env, { retryErrors: true }), 2)
  } finally {
    globalThis.fetch = orig
  }
  assert.deepEqual(asked.slice().sort(), ['Credit program rules', 'New plan command'],
    'a new command and a documented audience outrank a release whose only change is its number')
  assert.ok(!asked.some(x => /Version bump/.test(x)), 'no bump consumed a call')
})

test('normalizeEli5: unwraps the reply, strips the echoed label, keeps it honest', () => {
  assert.equal(normalizeEli5({ eli5: 'The assistant can use a new model now.' }), 'The assistant can use a new model now.')
  assert.equal(normalizeEli5('ELI5:  A   new model works. '), 'A new model works.')
  assert.equal(normalizeEli5({ eli5: 'A new model works' }), 'A new model works.')
  // A terse but valid sentence must survive; a non-answer must not be parked as
  // a "success" that then renders an empty-looking line forever.
  assert.equal(normalizeEli5({ eli5: 'It is faster now' }), 'It is faster now.')
  assert.throws(() => normalizeEli5({ eli5: 'too brief' }), /not an answer/)
  assert.throws(() => normalizeEli5({ eli5: 'N/A' }), /not an answer/)
  assert.throws(() => normalizeEli5({ eli5: 'I cannot answer that.' }), /not an answer/)
  // ...but a real sentence that merely contains "cannot" is not a refusal.
  assert.equal(normalizeEli5({ eli5: 'The assistant cannot use the broken model anymore' }),
    'The assistant cannot use the broken model anymore.')
  assert.throws(() => normalizeEli5({}), /not an answer/)
  const cut = normalizeEli5({ eli5: 'word ' + 'many '.repeat(220) + 'tail' })
  assert.ok(cut.length <= 801, `capped, got ${cut.length}`)
  assert.ok(/word/.test(cut) && !/man$/.test(cut), 'cut on a word boundary')
})

test('validateLlmOut: rejects raw glued identifiers in the title', () => {
  assert.throws(() => validateLlmOut({ title: 'advertiserreasonredaction202609v3 adds semantic refusal codes', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  assert.throws(() => validateLlmOut({ title: 'Add searchmanifoldmarkets tool for queries', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  assert.throws(() => validateLlmOut({ title: 'Add useSuggestionEngine hook for completions', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  assert.throws(() => validateLlmOut({ title: 'Handle stop_response event from server', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  const out = validateLlmOut({ title: 'Ad Reason Redaction v3 adds semantic refusal codes', summary: 'Did stuff.' }, 'minor')
  assert.equal(out.title, 'Ad Reason Redaction v3 adds semantic refusal codes')
})

test('validateLlmOut: ignores actionRequired from LLM output', () => {
  const withAction = validateLlmOut({
    title: 'Breaking API migration',
    summary: 'The old endpoint has been deprecated.',
    actionRequired: 'Update your config key to use the new endpoint name.',
    significance: 'major'
  }, 'major')
  assert.equal(withAction.actionRequired, undefined)

  const withoutAction = validateLlmOut({
    title: 'Safe update',
    summary: 'Internal performance improvements.',
    significance: 'minor'
  }, 'minor')
  assert.equal(withoutAction.actionRequired, undefined)
})

test('normalizeEli5: points robotic pronouns at the reader and cuts archive bleed', () => {
  assert.equal(normalizeEli5({ eli5: 'Workers put rules in place, so that person would notice nothing different today.' }),
    'Workers put rules in place, so you would notice nothing different today.')
  assert.equal(normalizeEli5({ eli5: 'Nothing changes for the viewer today.' }), 'Nothing changes for you today.')
  const bled = normalizeEli5({ eli5: 'You will see no changes today because this only collects details. May 13, 2025 (22)May 12, 2025 (15)' })
  assert.ok(!/2025/.test(bled), 'archive calendar cut')
  assert.ok(bled.endsWith('.'), 'cut end repunctuated')
})

test('normalizeEli5: strips prompt echo openings and filler intros', () => {
  assert.equal(
    normalizeEli5({ eli5: 'If you looked at the screen, models now load faster.' }),
    'Models now load faster.'
  )
  assert.equal(
    normalizeEli5({ eli5: 'What you would notice is the model picker shows more options.' }),
    'The model picker shows more options.'
  )
  assert.equal(
    normalizeEli5({ eli5: 'Behind the scenes, internal fixtures were cleaned up.' }),
    'Internal fixtures were cleaned up.'
  )
  assert.equal(
    normalizeEli5({ eli5: 'In simple terms: the app no longer freezes during sync.' }),
    'The app no longer freezes during sync.'
  )
})

test('buildEli5Prompt: 3-pillar framework, guardian rules, addresses you', () => {
  const p = buildEli5Prompt(eli5Entry({ commitNature: 'test-only' }), [], {})
  assert.match(p, /three pillars/i)
  assert.match(p, /Core Change/i)
  assert.match(p, /Everyday Impact/i)
  assert.match(p, /Test & Documentation Guardian/i)
  assert.match(p, /Commit nature: test-only/i)
  assert.match(p, /never write "that person"/)
  assert.match(p, /NEVER use conversational preambles/)
  assert.match(p, /An access change recorded in the evidence is a change/)
  assert.match(p, /without|Never invent/)
  assert.match(p, /Include an effective date only when the evidence supplies it/)
})

test('buildPrompt: tells the model to translate identifiers and includes guardian rules', () => {
  const p = buildPrompt({
    date: '2026-09-16T00:00:00Z',
    areas: ['Tests'],
    commitNature: 'test-only',
    significance: 'minor'
  }, 'diff')
  assert.match(p, /glued identifier/)
  assert.match(p, /Commit nature: test-only/i)
  assert.match(p, /Test & Documentation Guardian/i)
  assert.match(p, /Freebuff Subsystem Disambiguation/i)
  assert.match(p, /Strict Non-Extrapolation/i)
  assert.doesNotMatch(p, /actionRequired/)
})

test('enrichEli5: writes the line, caches it by the summary, asks once', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-eli5-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const env = {
    CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
    LLM_MODEL: 'test-model', CHANGELOG_LLM_LIMIT: '5'
  }
  let calls = 0
  let expectDiff = true
  const withPatch = async () => 'diff --git a/cli/src/model.ts b/cli/src/model.ts\n+export const MUSE = "1.3"\n'
    const orig = globalThis.fetch
    globalThis.fetch = async (url, init) => {
    calls++
    assert.match(url, /chat\/completions$/)
    assert.match(init.body, /not a programmer/, 'the prompt asks for a non-technical reader')
    assert.match(init.body, /Weight the tooling gave it/, 'and the structured evidence with it')
    if (expectDiff) assert.match(init.body, /diff --git/, 'the plain-English pass reads the change, not only its summary')
    else assert.doesNotMatch(init.body, /diff --git/, 'CHANGELOG_ELI5_DIFF=0 sends no patch')
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ eli5: 'A model the assistant can use is now available.' }) } }]
      })
    }
  }
  try {
    const e = eli5Entry()
    assert.equal(await enrichEli5([e], dir, env, { retryErrors: true, getPatch: withPatch }), 1)
    assert.match(e.eli5.text, /now available/)
    assert.equal(e.eli5.v, ELI5_V)
    assert.equal(e.eli5.src, shortHash(eli5Source(e)), 'the entry records what it explains')
    const cached = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    const keys = Object.keys(cached)
    assert.equal(keys.length, 1)
    assert.match(keys[0], new RegExp(`^${e.sha}:eli5:v${ELI5_V}:`), 'keyed in the same cache, separate namespace')

    // Second pass over the same summary: served from cache, no API call, and the
    // line still lands on the entry (a cache hit that rendered nothing would be
    // indistinguishable from a failure in production).
    const fresh = eli5Entry()
    assert.equal(await enrichEli5([fresh], dir, env, { retryErrors: true, getPatch: withPatch }), 0)
    assert.equal(calls, 1, 'cache hit must not spend a call')
    assert.match(fresh.eli5.text, /now available/)

    // Rewording the prompt version invalidates it, and the kill switch disables it.
    assert.equal(eli5Key(e.sha, 'x'), `${e.sha}:eli5:v${ELI5_V}:${shortHash('x')}`)
    assert.equal(await enrichEli5([eli5Entry()], dir, { ...env, CHANGELOG_ELI5: '0' }, {}), 0)
    assert.equal(calls, 1, 'CHANGELOG_ELI5=0 must not spend a call either')

    // The diff is a knob, not a constant: a cheap run explains from the summary.
    expectDiff = false
      assert.equal(await enrichEli5([eli5Entry({ sha: 'a'.repeat(40) })], dir,
        { ...env, CHANGELOG_ELI5_DIFF: '0' }, { retryErrors: true, getPatch: withPatch }), 1)
    assert.equal(calls, 2, 'the cheap run still spends its call')
  } finally {
    globalThis.fetch = orig
  }
})

test('versions bumped for audit hardening (grounding v3, fuse digest, roll-up prune)', () => {
  assert.equal(PROMPT_V, 11, 'PROMPT_V bumped to 11')
  assert.equal(ELI5_V, 7, 'ELI5_V bumped to 7')
})

test('buildPrompt: injects architecture map, PR motivation, sequence context, and requires evidence', () => {
  const entry = {
    sha: 'abcdef1234567890abcdef1234567890abcdef12',
    date: '2026-09-17T12:00:00Z',
    category: 'Agent Runtime',
    areas: ['Agent Runtime'],
    significance: 'notable',
    summary: 'Streaming agent runner implemented.',
    messageBody: 'Resolves memory leak during recursive subagent execution.'
  }
  const sequence = {
    earlier: [{ sha: '1111111111', title: 'Earlier work', summary: 'Preceding step', category: 'CLI' }],
    later: [{ sha: '2222222222', title: 'Later work', summary: 'Succeeding step', category: 'Agent Runtime' }]
  }
  const prMeta = { number: 1372, title: 'Support agent plugins' }
  const prompt = buildPrompt(entry, 'diff --git a/x b/x\n+export const agent = 1\n', { sequence, prMeta })

  assert.match(prompt, /Freebuff Monorepo Architecture Context:/)
  assert.match(prompt, /packages\/agent-runtime/)
  assert.match(prompt, /Author intent & PR motivation/)
  assert.match(prompt, /PR #1372: Support agent plugins/)
  assert.match(prompt, /Resolves memory leak during recursive subagent execution/)
  assert.match(prompt, /Same-day commit sequence/)
  assert.match(prompt, /Earlier: \[11111111\] Earlier work/)
  assert.match(prompt, /Current: \[abcdef12\] \(This commit\)/)
  assert.match(prompt, /Later:   \[22222222\] Later work/)
  assert.match(prompt, /"evidence": "<1-2 sentences citing exact file, function, flag, or diff hunk>"/)
})

test('buildEli5Prompt: injects architecture map, PR motivation, sequence context, and 60KB diff budget', () => {
  const entry = {
    sha: 'abcdef1234567890abcdef1234567890abcdef12',
    day: '2026-09-17',
    category: 'CLI',
    areas: ['CLI'],
    significance: 'notable',
    title: 'New /byok slash command',
    summary: 'Brings own API key support to terminal.',
    messageBody: 'Fixes #1374 for users with enterprise keys.'
  }
  const sequence = {
    earlier: [{ sha: '1111111111', title: 'Earlier CLI work' }],
    later: [{ sha: '2222222222', title: 'Later CLI work' }]
  }
  const prMeta = { number: 1374, title: 'Add BYOK support' }
  const prompt = buildEli5Prompt(entry, [], {
    patch: 'diff --git a/cli/src/byok.ts b/cli/src/byok.ts\n+const byok = true\n',
    diffBytes: 60000,
    sequence,
    prMeta
  })

  assert.match(prompt, /Freebuff Monorepo Architecture Context:/)
  assert.match(prompt, /cli\//)
  assert.match(prompt, /Developer intent \(PR #1374\): Add BYOK support/)
  assert.match(prompt, /Fixes #1374 for users with enterprise keys/)
  assert.match(prompt, /Same-day commit sequence: Earlier: Earlier CLI work -> Current: New \/byok slash command -> Later: Later CLI work/)
  assert.match(prompt, /diff --git a\/cli\/src\/byok\.ts/)
})

test('validateLlmOut: extracts and validates evidence field', () => {
  const out = validateLlmOut({
    evidence: 'Modified handleStream in packages/agent-runtime/src/stream.ts hunk @@ -10,5 +10,12 @@',
    title: 'Stream response chunking',
    summary: 'Added streaming chunk buffers to reduce latency on slow connections. Preserves backpressure.',
    significance: 'notable'
  })
  assert.equal(out.title, 'Stream response chunking')
  assert.match(out.evidence, /handleStream in packages\/agent-runtime/)
  assert.equal(out.significance, 'notable')
})

test('loadPrIndex & findPrMeta: matches PR by number, commit sha, or commit message', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-pr-test-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const fakePrs = {
    prs: [
      {
        number: 1377,
        title: 'fix(cli): guard systeminformation.cpu()',
        author: 'heavymio',
        commitsList: [{ sha: '31878f417cd8d61477ce700bef161524bdec5736' }]
      },
      {
        number: 1372,
        title: 'Support agent plugins',
        author: 'hsm207',
        commitsList: [{ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]
      }
    ]
  }
  await writeFile(join(dir, 'open-prs.json'), JSON.stringify(fakePrs))
  // Open PRs carry no file list from the GitHub endpoint; loadPrIndex must
  // backfill `paths` from the stored preview diff, or matchPrByPaths is
  // structurally dead for every PR that is still open.
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'pr-diffs'), { recursive: true })
  await writeFile(join(dir, 'pr-diffs', '1377.diff'),
    'diff --git a/cli/src/system.ts b/cli/src/system.ts\n--- a/cli/src/system.ts\n+++ b/cli/src/system.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/cli/src/cpu.ts b/cli/src/cpu.ts\n--- a/cli/src/cpu.ts\n+++ b/cli/src/cpu.ts\n@@ -1 +1 @@\n-x\n+y\n')

  const index = await loadPrIndex(dir)
  assert.ok(index.prsByNum.has(1377))
  assert.ok(index.prsBySha.has('31878f417c'))
  assert.deepEqual(index.prsByNum.get(1377).paths, ['cli/src/system.ts', 'cli/src/cpu.ts'], 'paths backfilled from the stored preview')
  assert.deepEqual(index.prsByNum.get(1372).paths, [], 'no stored preview means no paths, not a crash')

  // Match by e.pr
  const byPr = findPrMeta({ pr: 1377 }, index)
  assert.equal(byPr?.number, 1377)
  assert.equal(byPr?.author, 'heavymio')

  // Match by e.sha
  const bySha = findPrMeta({ sha: '31878f417cd8d61477ce700bef161524bdec5736' }, index)
  assert.equal(bySha?.number, 1377)

  // Match by #1372 in title
  const byTitle = findPrMeta({ title: 'feat: agent plugins (#1372)' }, index)
  assert.equal(byTitle?.number, 1372)

  // Non-matching
  const noMatch = findPrMeta({ title: 'unrelated commit' }, index)
  assert.equal(noMatch, null)
})

test('groupEntriesByDay & sequenceForEntry: computes preceding and succeeding commits on same day', () => {
  const entries = [
    { sha: '1111111111', day: '2026-09-17', date: '2026-09-17T09:00:00Z', title: 'Commit 1', category: 'CLI' },
    { sha: '2222222222', day: '2026-09-17', date: '2026-09-17T11:00:00Z', title: 'Commit 2', category: 'CLI' },
    { sha: '3333333333', day: '2026-09-17', date: '2026-09-17T13:00:00Z', title: 'Commit 3', category: 'Agent Runtime' },
    { sha: '4444444444', day: '2026-09-17', date: '2026-09-17T15:00:00Z', title: 'Commit 4', category: 'Shared/Core' },
    { sha: '5555555555', day: '2026-09-18', date: '2026-09-18T09:00:00Z', title: 'Next Day Commit', category: 'CLI' }
  ]

  const byDay = groupEntriesByDay(entries)
  assert.equal(byDay.get('2026-09-17')?.length, 4)
  assert.equal(byDay.get('2026-09-18')?.length, 1)

  const seq = sequenceForEntry(byDay, entries[2], 2) // Target Commit 3
  assert.equal(seq?.earlier?.length, 2)
  assert.equal(seq?.earlier[0].title, 'Commit 1')
  assert.equal(seq?.earlier[1].title, 'Commit 2')
  assert.equal(seq?.later?.length, 1)
  assert.equal(seq?.later[0].title, 'Commit 4')

  // First commit has no earlier
  const seqFirst = sequenceForEntry(byDay, entries[0], 2)
  assert.equal(seqFirst?.earlier?.length, 0)
  assert.equal(seqFirst?.later?.length, 2)
})

test('sequenceForEntry: default window of 25 captures larger same-day batches', () => {
  const day = '2026-09-17'
  const entries = []
  for (let i = 1; i <= 35; i++) {
    entries.push({
      sha: `sha${String(i).padStart(6, '0')}`,
      day,
      date: `2026-09-17T00:00:${String(i).padStart(2, '0')}Z`,
      title: `Commit #${i}`,
      category: 'CLI'
    })
  }
  const byDay = groupEntriesByDay(entries)
  // Check commit #28 (index 27): has 27 earlier entries, default window should take 25
  const seq = sequenceForEntry(byDay, entries[27])
  assert.equal(seq?.earlier?.length, 25)
  assert.equal(seq?.later?.length, 7)
  assert.equal(seq?.earlier[0].title, 'Commit #3')
  assert.equal(seq?.earlier[24].title, 'Commit #27')
})

test('findPrMeta: preserves PR description body', () => {
  const prIndex = {
    prsByNum: new Map([
      [1234, { number: 1234, title: 'Add budget limits', author: 'alice', body: 'Implements advertiser campaign budget caps.', labels: ['core'] }]
    ]),
    prsBySha: new Map()
  }
  const entry = { pr: 1234, sha: 'abc1234' }
  const meta = findPrMeta(entry, prIndex)
  assert.equal(meta?.number, 1234)
  assert.equal(meta?.title, 'Add budget limits')
  assert.equal(meta?.body, 'Implements advertiser campaign budget caps.')
})

test('buildPrompt & buildEli5Prompt: formats fileHeaders and PR body into context', () => {
  const entry = {
    sha: '71b2827c5f1d55176b4a03edc8b254f7bbca0c9d',
    date: '2026-09-18T00:00:00Z',
    category: 'Common',
    summary: 'Update default daily placement cap',
    files: { modified: ['common/src/ads/campaigns.ts'] }
  }
  const patch = '+export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 10000;'
  const fileHeaders = [
    {
      path: 'common/src/ads/campaigns.ts',
      header: '/**\n * Ad placement campaigns and self-serve advertiser spending limits.\n */'
    }
  ]
  const prMeta = {
    number: 1380,
    title: 'Raise default ad campaign budget',
    body: 'Advertisers requested a higher starting budget ceiling for text placement campaigns.'
  }

  // Check buildPrompt
  const prompt = buildPrompt(entry, patch, { fileHeaders, prMeta })
  assert.ok(prompt.includes('Module & File Purpose (ground-truth documentation from touched files):'))
  assert.ok(prompt.includes('File `common/src/ads/campaigns.ts`:'))
  assert.ok(prompt.includes('Ad placement campaigns and self-serve advertiser spending limits.'))
  assert.ok(prompt.includes('PR #1380: Raise default ad campaign budget'))
  assert.ok(prompt.includes('PR Description: Advertisers requested a higher starting budget ceiling'))

  // Check buildEli5Prompt
  const eli5Prompt = buildEli5Prompt(entry, [], { fileHeaders, prMeta, patch })
  assert.ok(eli5Prompt.includes('Module purpose from touched files:'))
  assert.ok(eli5Prompt.includes('File common/src/ads/campaigns.ts:'))
  assert.ok(eli5Prompt.includes('Ad placement campaigns and self-serve advertiser spending limits.'))
  assert.ok(eli5Prompt.includes('Developer intent (PR #1380): Raise default ad campaign budget'))
  assert.ok(eli5Prompt.includes('PR details: Advertisers requested a higher starting budget ceiling'))
})

test('buildPrompt & buildEli5Prompt: formats fileHistory, fullFiles, exportOutlines, and subsystemDocs into context', () => {
  const entry = {
    sha: '82c3938d6f2e66287c5b14fee9c365f8ccba1d0e',
    date: '2026-09-18T00:00:00Z',
    category: 'Common',
    summary: 'Add sponsored placement ranking algorithm',
    files: { modified: ['common/src/ads/ranking.ts', 'common/src/ads/types.ts'] }
  }
  const patch = '+export function rankAds() { return []; }'
  const fileHistory = [
    {
      sha: '11111111',
      date: '2026-09-17',
      overlap: ['common/src/ads/ranking.ts'],
      title: 'Initial ad ranking stub',
      summary: 'Added baseline ranking interface'
    }
  ]
  const fullFiles = [
    {
      path: 'common/src/ads/types.ts',
      lines: 45,
      content: 'export interface AdPlacement {\n  id: string;\n  score: number;\n}'
    }
  ]
  const exportOutlines = [
    {
      path: 'common/src/ads/ranking.ts',
      totalLines: 320,
      outline: 'export function rankAds(candidates: AdPlacement[]): AdPlacement[];'
    }
  ]
  const subsystemDocs = [
    {
      path: 'common/src/ads/README.md',
      content: '# Ads Subsystem\nManages sponsored ad placements and budgets.'
    }
  ]

  // Verify buildPrompt
  const prompt = buildPrompt(entry, patch, {
    fileHistory,
    fullFiles,
    exportOutlines,
    subsystemDocs
  })

  assert.ok(prompt.includes('Recent commit lineage for touched files (last up to 10 changes to these files):'))
  assert.ok(prompt.includes('[11111111] (2026-09-17) touched common/src/ads/ranking.ts: Initial ad ranking stub'))
  assert.ok(prompt.includes('Added baseline ranking interface'))

  assert.ok(prompt.includes('Complete Source of Modified Files (for complete module context):'))
  assert.ok(prompt.includes('File `common/src/ads/types.ts` (45 lines):'))
  assert.ok(prompt.includes('export interface AdPlacement'))

  assert.ok(prompt.includes('Exported Interface & Symbol Outline (public contract for larger touched files):'))
  assert.ok(prompt.includes('File `common/src/ads/ranking.ts` (320 lines):'))
  assert.ok(prompt.includes('export function rankAds(candidates: AdPlacement[]): AdPlacement[];'))

  assert.ok(prompt.includes('Subsystem Architecture Documentation (from nearby package guides):'))
  assert.ok(prompt.includes('From `common/src/ads/README.md`:'))
  assert.ok(prompt.includes('# Ads Subsystem'))

  // Verify buildEli5Prompt
  const eli5Prompt = buildEli5Prompt(entry, [], {
    fileHistory,
    subsystemDocs,
    patch
  })

  assert.ok(eli5Prompt.includes('Recent changes to these files: 2026-09-17 [11111111]: Initial ad ranking stub'))
  assert.ok(eli5Prompt.includes('Subsystem guide: common/src/ads/README.md: # Ads Subsystem'))
})

test('normalizeEli5: rejects no-action packaging boilerplate on roll-up rows', () => {
  const boilerplate1 = 'The developer tool was quietly updated to a new packaged version, which simply bundles together a collection of improvements that were already rolled out to users throughout the day - nothing breaks, nothing changes how you call it, and no action is required on your part.'
  assert.throws(() => normalizeEli5(boilerplate1, ELI5_ROLLUP_MAX_CHARS), /no-action packaging boilerplate/)

  const boilerplate2 = 'If you use this tool to build or modify code, this is an internal packaging marker rather than a feature change - your workflow, project setup, and outputs will not be any different after updating.'
  assert.throws(() => normalizeEli5(boilerplate2, ELI5_ROLLUP_MAX_CHARS), /no-action packaging boilerplate/)

  const good = 'This release adds Fable 5.1 to the free trial tier, verifies release archives with sha256 checksums, and displays off-peak Freebucks pricing in the terminal model picker.'
  assert.equal(normalizeEli5(good, ELI5_ROLLUP_MAX_CHARS), good)
})

test('buildEli5Prompt: roll-up mode commands description of what was added and forbids meta packaging boilerplate', () => {
  const bump = {
    sha: 'f61c4efa8a0d8fabb774756afdd610b7b7726010',
    day: '2026-09-18',
    version: '0.0.178',
    category: 'CLI',
    ai: { title: 'Freebuff CLI release 0.0.178' }
  }
  const relCtx = 'Updates included in this release (0.0.178 since 0.0.177):\n- 2026-09-18 Fable 5.1 replaces Fable 5 in Freebuff free trials\n- 2026-09-18 Release launcher enforces archive sha256 verification'
  const prompt = buildEli5Prompt(bump, [], { releaseCtx: relCtx })

  assert.ok(prompt.includes('RELEASE ROLL-UP summarizing the capabilities, models, security protections, and improvements'))
  assert.ok(prompt.includes('Updates included in this release (0.0.178 since 0.0.177):'))
  assert.ok(prompt.includes('DO NOT write meta-boilerplate saying "this is just a packaging update"'))
  assert.ok(prompt.includes('Write 3-6 sentences of plain English that tell the user WHAT WAS ADDED, CHANGED, AND IMPROVED in this release.'))
})





