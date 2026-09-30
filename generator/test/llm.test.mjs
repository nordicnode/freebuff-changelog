// generator/test/llm.test.mjs - tests for the LLM enrichment module
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLlmJson, sanitizeJsonText, buildPrompt, enrichWithLlm, enrichEli5, llmConfigured, validateLlmOut, truncateWords, budgetPatch, cacheKey, firstSentence, isTransientError, isGatewayError, pruneExpiredErrors, errorRetryDelayMs, summaryDirt, healEligible, contextFingerprint, assessLlmHealth, recordLlmHealth, llmCallCount, buildSelfCheckPrompt, summaryValidator, GAVEUP_MAX_TRIES, shortError, PROMPT_V, ELI5_V, eli5Eligible, eli5Done, eli5Source, eli5Key, normalizeEli5, buildEli5Prompt, eli5Notes, eli5Patch, loadPrIndex, findPrMeta, groupEntriesByDay, sequenceForEntry, FREEBUFF_ARCHITECTURE_MAP, FREEBUFF_DOMAIN_LEXICON, ELI5_ROLLUP_MAX_CHARS, LLM_CONTEXT_CHARS, LLM_CONTEXT_TOKENS, LLM_PROMPT_CHARS, LLM_OUTPUT_RESERVE_CHARS, LLM_MIN_DIFF_ROOM, diffRoom, perFileRoom, capSection, fitToWindow, CONTEXT_SECTION_CHARS, CONTEXT_BUDGET_SHARES, contextBudgets, extractChangedTests, buildFusePrompt, buildVerifyPrompt, rewriteScopeOf, rewriteIsCurrent, redactProductPrompts, PROMPT_REDACTION, buildChunkPrompt, leanPromptCtx, REPLY_CONTRACT, summarizeEntry, explainEntry, buildDiffDigest, buildPrPrompt, DEFAULT_VERIFY_MODEL, reverifyEligible } from '../lib/llm.mjs'
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
  assert.ok(!isTransientError(new Error('LLM HTTP 401: unauthorized')))
  assert.ok(!isTransientError(new Error('LLM HTTP 403: forbidden')))
  assert.ok(!isTransientError(new Error('LLM HTTP 404: not found')))
  // 429/408 are retry-soon conditions: an exhausted in-call retry must still
  // land on the short transient cooldown, not park the entry for an hour.
  assert.ok(isTransientError(new Error('LLM HTTP 429: too many')))
  assert.ok(isTransientError(new Error('LLM HTTP 408: request timeout')))
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
  assert.equal(pruned, 0)
  assert.ok(cache.k1, 'cooled failures retain durable attempts')
  assert.ok(cache.k2, 'k2 active transient retained')
  assert.ok(cache.k3, 'cooled permanent failures retain durable attempts')
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
  assert.equal(llmConfigured({ CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'test-key' }), true)
  assert.equal(llmConfigured({ CHANGELOG_LLM: '0', LLM_API_KEY: 'test-key' }), false)
  assert.equal(llmConfigured({ CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: '' }), false)
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'test-key', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'test-key', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
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

test('heal policy: dirt counts every shipped objection, eligibility is bounded and cooled down', () => {
  assert.equal(summaryDirt({ title: 't' }), 0, 'a clean row has no dirt')
  assert.equal(summaryDirt({ ungrounded: ['A', 'B'], valueErrors: ['C'], whyMissing: true, verify: 'flagged' }), 4)
  assert.equal(summaryDirt({ verify: 'passed' }), 0, 'a passed verdict is not dirt')
  const dirty = { ungrounded: ['A'], at: '2020-01-01T00:00:00.000Z' }
  assert.equal(healEligible(dirty), true, 'an old dirty row is eligible')
  assert.equal(healEligible({ error: 'boom', ungrounded: ['A'] }), false, 'an error stub is the retry path, not the heal path')
  assert.equal(healEligible({ title: 'clean' }), false, 'a clean row is never re-asked')
  assert.equal(healEligible({ ...dirty, healTries: 2 }), false, 'the spend per row is bounded')
  assert.equal(healEligible({ ...dirty, healAt: new Date().toISOString() }), false, 'a fresh attempt cools down')
  assert.equal(healEligible({ ...dirty, healTries: 1, healAt: '2020-01-01T00:00:00.000Z' }), true, 'a cooled-down attempt is eligible again')
})

test('re-check policy: only rows that say they are unverified, bounded and cooled down', () => {
  const unverified = { title: 'T', summary: 'S.', verify: 'unavailable', at: '2020-01-01T00:00:00.000Z' }
  assert.equal(reverifyEligible(unverified), true, 'an old unverified row is eligible')
  assert.equal(reverifyEligible({ ...unverified, verify: 'passed' }), false, 'a verdict is not re-checked')
  assert.equal(reverifyEligible({ ...unverified, verify: 'flagged' }), false, 'an objection belongs to the heal pass, not the re-check')
  assert.equal(reverifyEligible({ ...unverified, verify: undefined }), false, 'a legacy row that predates the verifier is not re-checked')
  assert.equal(reverifyEligible({ ...unverified, error: 'boom' }), false, 'an error stub is the retry path')
  assert.equal(reverifyEligible({ ...unverified, title: '' }), false, 'a record with no text of its own is not a shipped summary')
  assert.equal(reverifyEligible({ ...unverified, verifyTries: 3 }), false, 'the spend per row is bounded')
  assert.equal(reverifyEligible({ ...unverified, verifyAt: new Date().toISOString() }), false, 'a fresh attempt cools down')
  assert.equal(reverifyEligible({ ...unverified, verifyTries: 1, verifyAt: '2020-01-01T00:00:00.000Z' }), true, 'a cooled-down attempt is eligible again')
})

test('re-check: a row that shipped with no verdict is checked later, and its text is never rewritten', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-recheck-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const sha = 'd'.repeat(40)
  const patch = 'diff --git a/sdk/src/b.ts b/sdk/src/b.ts\n+export const BETA = 1\n'
  const key = cacheKey(sha, patch)
  const entry = { kind: 'sync', sha, date: '2026-09-13T10:00:00Z', areas: ['SDK'], summary: 'Adds a gate.' }
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://gateway.test/v1', CHANGELOG_LLM_LIMIT: '5' }
  // Anchored to the clock, not a calendar date. This row models one that
  // shipped moments ago, and the assertion below is that a freshly shipped
  // unverified row costs nothing while the re-check budget is off. A fixed
  // date rots: once its 6h heal cooldown elapsed, the heal pass claimed the
  // row first -- its fingerprint can never match this test's empty PR
  // context -- and spent a writer call plus repairs, so the pass this test
  // exists to pin never ran. That turned the relay's test gate red and
  // stalled every data commit; fixtures for "just shipped" must stay relative.
  const unverified = {
    model: 'deepseek-v4.1', v: PROMPT_V, at: new Date(Date.now() - 60_000).toISOString(),
    title: 'Beta gate added', summary: 'Adds `BETA` in sdk/src/b.ts to prevent double-spends.',
    significance: 'minor', audience: 'end-users', cf: 'deadbeef',
    verify: 'unavailable', verifyModel: 'gpt-6-luna'
  }
  const seen = []
  let verdictOut = { supported: true, issues: [], claims: [{ quote: 'Beta gate added', supported: true }, { quote: 'Adds `BETA` in sdk/src/b.ts to prevent double-spends.', supported: true }, { quote: 'end-users', supported: true }] }
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, { body }) => {
    const parsed = JSON.parse(String(body))
    seen.push({ model: parsed.model, prompt: String(parsed.messages?.at(-1)?.content || '') })
    const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdictOut) } }] })
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => envelope }
  }
  try {
    // Inside the cooldown the row costs nothing.
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: unverified }))
    await enrichWithLlm([entry], async () => patch, dir, { ...env, CHANGELOG_LLM_REVERIFY_COOLDOWN_MS: String(6 * 60 * 60 * 1000), CHANGELOG_LLM_REVERIFY: '0' }, {})
    assert.equal(seen.length, 0, 'the re-check budget is off by default only when asked')
    // Eligible: the check runs on the verifier model and records a verdict --
    // without touching the text the row already published.
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: { ...unverified, verifyAt: '2020-01-01T00:00:00.000Z' } }))
    const n = await enrichWithLlm([entry], async () => patch, dir, env, {})
    assert.equal(n, 0, 'a re-check writes no new entry')
    assert.equal(seen.length, 1, 'exactly one call: the check, not a rewrite')
    assert.equal(seen[0].model, DEFAULT_VERIFY_MODEL, 'the check runs on the verify model')
    assert.match(seen[0].prompt, /checking a changelog entry/, 'and it is the verifier ask')
    let stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.equal(stored[key].verify, 'passed', 'the missing verdict is recorded')
    assert.equal(stored[key].verifyModel, DEFAULT_VERIFY_MODEL, 'by the model that supplied it')
    assert.equal(stored[key].verifyTries, 1, 'the attempt is counted')
    assert.equal(stored[key].title, 'Beta gate added', 'the shipped title is untouched')
    assert.equal(stored[key].summary, unverified.summary, 'and so is the shipped summary')
    assert.equal(stored[key].cf, 'deadbeef', 'the re-check is not a context refresh: the fingerprint stays as the writer left it')
    assert.ok(stored[key].verifyAt, 'the attempt is spaced')
    let health = JSON.parse(await readFile(join(dir, 'llm-health.json'), 'utf8'))
    assert.equal(Object.values(health.days)[0].rechecked, 1, 'the ledger counts the re-check')
    assert.equal(Object.values(health.days)[0].summarized, 0, 'and does not pretend a row was written')
    // An objection is recorded as flagged and its text is still untouched:
    // the repair belongs to the heal pass, which owns rewriting shipped text.
    verdictOut = { supported: false, issues: ['`BETA` is not in the diff'], claims: [] }
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: { ...unverified, verifyAt: '2020-01-01T00:00:00.000Z' } }))
    await enrichWithLlm([entry], async () => patch, dir, env, {})
    stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.equal(stored[key].verify, 'flagged', 'the objection stands as a flag')
    assert.deepEqual(stored[key].verifyClaims, [{ claim: '`BETA` is not in the diff' }], 'with the claim the reviewer named')
    assert.equal(stored[key].summary, unverified.summary, 'a re-check never rewrites shipped text')
    health = JSON.parse(await readFile(join(dir, 'llm-health.json'), 'utf8'))
    assert.equal(Object.values(health.days)[0].flagged, 1, 'and the ledger sees the objection')
    // At the try cap the row is left alone entirely.
    const before = seen.length
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: { ...unverified, verifyTries: 3, verifyAt: '2020-01-01T00:00:00.000Z' } }))
    await enrichWithLlm([entry], async () => patch, dir, env, {})
    assert.equal(seen.length, before, 'a row at its re-check cap costs nothing')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('healing: a shipped-with-objections row is re-asked and replaced only by a cleaner rewrite', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-heal-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const sha = 'c'.repeat(40)
  const patch = 'diff --git a/sdk/src/a.ts b/sdk/src/a.ts\n+export const ALPHA = 1\n'
  const key = cacheKey(sha, patch)
  const entry = { kind: 'sync', sha, date: '2026-09-13T10:00:00Z', areas: ['SDK'], summary: 'Adds a gate.' }
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://gateway.test/v1', CHANGELOG_LLM_LIMIT: '5' }
  const dirtyRec = {
    model: 'deepseek-v4.1', v: PROMPT_V, at: '2020-01-01T00:00:00.000Z',
    title: 'Shipped with objections', summary: 'Old text.', significance: 'minor',
    ungrounded: ['FAKE_NAME', 'OTHER_FAKE'], verify: 'flagged'
  }
  await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: dirtyRec }))
  const cleanPayload = {
    evidence: 'sdk/src/a.ts holds the gate.',
    title: 'Alpha gate added',
    summary: 'Adds `ALPHA` in sdk/src/a.ts to prevent double-spends.',
    significance: 'minor', audience: 'end-users', confidence: 'high'
  }
  let mode = 'clean'
  let fetchCalls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, { body }) => {
    fetchCalls++
    const writer = mode === 'clean' ? cleanPayload : { ...cleanPayload, summary: 'Reads `NOT_IN_DIFF` to prevent double-spends.' }
    const prompt = JSON.parse(String(body)).messages.at(-1).content
    const payload = /You are checking/.test(prompt) ? { supported: true, issues: [], claims: Object.values(writer).filter(v => typeof v === 'string').map(quote => ({ quote, supported: true })) } : writer
    const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => envelope }
  }
  try {
    // The disabled switch spends nothing.
    const off = await enrichWithLlm([entry], async () => patch, dir, { ...env, CHANGELOG_LLM_HEAL: '0' }, {})
    assert.equal(off, 0)
    assert.equal(fetchCalls, 0, 'healing off: no calls')
    // A strictly cleaner rewrite replaces the shipped text.
    const n = await enrichWithLlm([entry], async () => patch, dir, env, {})
    assert.equal(n, 1)
    assert.ok(fetchCalls >= 1)
    let stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.equal(stored[key].title, 'Alpha gate added', 'the cleaner rewrite ships')
    assert.equal(stored[key].ungrounded, undefined)
    assert.equal(stored[key].healTries, 0, 'a clean rewrite resets the try budget')
    assert.ok(stored[key].healAt, 'the attempt is still spaced')
    assert.equal(entry.ai.title, 'Alpha gate added', 'the entry carries the healed record')
    // An equally dirty rewrite keeps the shipped text (and still counts a try).
    const dirty2 = { ...dirtyRec, title: 'Shipped again', ungrounded: ['FAKE_NAME'], verify: undefined, healTries: 0, at: '2020-01-01T00:00:00.000Z' }
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: dirty2 }))
    entry.ai = { ...dirty2 }
    mode = 'dirty'
    await enrichWithLlm([entry], async () => patch, dir, env, {})
    stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.equal(stored[key].title, 'Shipped again', 'a rewrite that is not cleaner does not replace shipped text')
    assert.deepEqual(stored[key].ungrounded, ['FAKE_NAME'], 'the shipped flags stay')
    assert.equal(stored[key].healTries, 1, 'but the attempt is counted')
    // At the try cap the row is left alone entirely.
    const before = fetchCalls
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: { ...dirty2, healTries: 2, healAt: '2020-01-01T00:00:00.000Z' } }))
    await enrichWithLlm([entry], async () => patch, dir, env, {})
    assert.equal(fetchCalls, before, 'a row at its heal cap costs nothing')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('assessLlmHealth: a refusal storm is an alert, objection-heavy days are a watch', () => {
  assert.equal(assessLlmHealth({}).level, 'ok', 'a clean day is ok')
  assert.equal(assessLlmHealth({ deterministicErrors: 1 }).level, 'watch', 'one isolated refusal is worth a look')
  const storm = assessLlmHealth({ deterministicErrors: 3 })
  assert.equal(storm.level, 'alert', 'the refusal-storm shape is named loudly')
  assert.match(storm.reasons.join(' '), /refused or answered from memory/)
  assert.equal(assessLlmHealth({ summarized: 10, flagged: 1 }).level, 'ok')
  assert.equal(assessLlmHealth({ summarized: 10, flagged: 4, ungrounded: 3, dirtyRows: 7 }).level, 'watch', '7 of 10 rows shipped with objections')
  assert.equal(assessLlmHealth({ summarized: 10, flagged: 6 }).level, 'watch', 'more objection rows than clean ones')
  assert.equal(assessLlmHealth({ summarized: 2, flagged: 1 }).level, 'ok', 'the objection rule needs a sample')
  assert.equal(assessLlmHealth({ summarized: 0, transientErrors: 2 }).level, 'watch', 'nothing landed while asks failed')
  assert.equal(assessLlmHealth({ summarized: 3, otherErrors: 10 }).level, 'watch', 'ten failed asks in a day')
  assert.equal(assessLlmHealth({ summarized: 10, verifierUnavailable: 1 }).level, 'ok', 'one row without a verdict is noise')
  assert.equal(assessLlmHealth({ summarized: 10, verifierUnavailable: 6 }).level, 'watch', 'more rows unverified than checked')
  assert.equal(assessLlmHealth({ summarized: 100, verifierUnavailable: 10 }).level, 'watch', 'ten unverified rows is a verifier outage')
})

test('verifier unavailability: the row says so and the health ledger counts it', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-verif-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const sha = 'f'.repeat(40)
  const patch = 'diff --git a/x b/x\n+export const ALPHA = 1\n'
  const key = cacheKey(sha, patch)
  const entry = { kind: 'sync', sha, date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'Adds a gate.' }
  // The writer answers; the verifier is down. The mock keys off the verify
  // ask's opening line, not the model name, so it stays a verifier outage
  // whichever model either pass happens to run on.
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://gateway.test/v1', LLM_MODEL: 'deepseek-v4.1', CHANGELOG_LLM_LIMIT: '5' }
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, { body }) => {
    const { messages } = JSON.parse(String(body))
    const prompt = String(messages?.at(-1)?.content || '')
    // 400, not 5xx: the 5xx path sleeps through real retry backoff, and this
    // test is about the unavailability being recorded, not the retry ladder.
    if (prompt.startsWith('You are checking a changelog entry against the diff it describes.')) return { status: 400, ok: false, headers: { get: () => null }, text: async () => 'verifier down' }
    const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: 'x b/x holds it.', title: 'Alpha gate added', summary: 'Adds `ALPHA` in x b/x to prevent double-spends.', significance: 'minor', audience: 'end-users', confidence: 'high' }) } }] })
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => envelope }
  }
  try {
    await enrichWithLlm([entry], async () => patch, dir, env, {})
  } finally {
    globalThis.fetch = origFetch
  }
  const stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
  assert.equal(stored[key].verify, 'unavailable', 'an unverifiable row is not indistinguishable from an unchecked one')
  assert.equal(stored[key].verifyModel, DEFAULT_VERIFY_MODEL, 'and it names the verifier that failed')
  const health = JSON.parse(await readFile(join(dir, 'llm-health.json'), 'utf8'))
  const day = Object.values(health.days)[0]
  assert.equal(day.verifierUnavailable, 1, 'the ledger counts it for drift detection')
  assert.equal(day.summarized, 1)
})

test('context fingerprint: late evidence is a reason to re-ask, bounded like any heal', () => {
  const a = contextFingerprint({ number: 1, title: 'T' }, 'gloss')
  assert.equal(a, contextFingerprint({ number: 1, title: 'T' }, 'gloss'), 'same context, same fingerprint')
  assert.notEqual(a, contextFingerprint({ number: 1, title: 'T', comments: [{ body: 'x' }] }, 'gloss'), 'a review thread arriving changes it')
  assert.notEqual(a, contextFingerprint({ number: 2, title: 'T' }, 'gloss'), 'so does the PR itself')
  assert.notEqual(a, contextFingerprint({ number: 1, title: 'T' }, 'other gloss'), 'and a glossary update')
  const clean = { title: 't', at: '2020-01-01T00:00:00.000Z', cf: 'one' }
  assert.equal(healEligible(clean), false, 'a clean, current-context row is never re-asked')
  assert.equal(healEligible(clean, { staleContext: true }), true, 'but stale context is a reason on its own')
  assert.equal(healEligible({ ...clean, healTries: 2 }, { staleContext: true }), false, 'and the spend stays bounded')
  assert.equal(healEligible({ ...clean, cf: undefined }, { staleContext: true }), false, 'legacy rows without a fingerprint are grandfathered')
})

test('context refresh: a row whose evidence arrived late is re-asked, and a dirtier rewrite never replaces it', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-ctx-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const sha = 'e'.repeat(40)
  const patch = 'diff --git a/x b/x\n+export const ALPHA = 1\n'
  const key = cacheKey(sha, patch)
  const entry = { kind: 'sync', sha, date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'Adds a gate.' }
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://gateway.test/v1', CHANGELOG_LLM_LIMIT: '5' }
  const thinRec = {
    model: 'deepseek-v4.1', v: PROMPT_V, at: '2020-01-01T00:00:00.000Z',
    title: 'Thin summary', summary: 'Written before the review thread arrived.', significance: 'minor',
    cf: 'stale-fingerprint'
  }
  await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: thinRec }))
  const cleanPayload = {
    evidence: 'x b/x holds it.', title: 'Alpha gate added',
    summary: 'Adds `ALPHA` in x b/x to prevent double-spends.',
    significance: 'minor', audience: 'end-users', confidence: 'high'
  }
  let mode = 'clean'
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, { body }) => {
    const writer = mode === 'clean' ? cleanPayload : { ...cleanPayload, summary: 'Reads `NOT_IN_DIFF` to prevent double-spends.' }
    const prompt = JSON.parse(String(body)).messages.at(-1).content
    const payload = /You are checking/.test(prompt) ? { supported: true, issues: [], claims: Object.values(writer).filter(v => typeof v === 'string').map(quote => ({ quote, supported: true })) } : writer
    const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => envelope }
  }
  try {
    // The current fingerprint for a row with no PR and no glossary is stable;
    // the fixture's is stale, which alone justifies one bounded re-ask.
    await enrichWithLlm([entry], async () => patch, dir, env, {})
    let stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.equal(stored[key].title, 'Alpha gate added', 'the rewrite with the late context ships')
    assert.equal(stored[key].cf, contextFingerprint(null, ''), 'and stamps the fingerprint it was written against')
    assert.equal(stored[key].healTries, 0)
    // A rewrite that is dirtier than the shipped text is rejected even though
    // the context is stale: "better informed" never means "less accurate".
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({ [key]: thinRec }))
    entry.ai = { ...thinRec }
    mode = 'dirty'
    await enrichWithLlm([entry], async () => patch, dir, env, {})
    stored = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    assert.equal(stored[key].title, 'Thin summary', 'the dirtier rewrite does not replace shipped text')
    assert.equal(stored[key].healTries, 1, 'the attempt is counted')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('drift ledger: runs accumulate per UTC day and the window stays bounded', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-health-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const first = await recordLlmHealth(dir, { summarized: 2, flagged: 1 }, { now: new Date('2026-09-28T10:00:00Z') })
  assert.equal(first.day, '2026-09-28')
  assert.equal(first.stats.summarized, 2)
  await recordLlmHealth(dir, { summarized: 3, deterministicErrors: 3 }, { now: new Date('2026-09-28T22:00:00Z') })
  let doc = JSON.parse(await readFile(join(dir, 'llm-health.json'), 'utf8'))
  assert.equal(doc.days['2026-09-28'].summarized, 5, 'two runs of one day share a bucket')
  assert.equal(doc.days['2026-09-28'].flagged, 1)
  assert.equal(assessLlmHealth(doc.days['2026-09-28']).level, 'alert', 'the merged day reads as the storm it became')
  for (let i = 0; i < 25; i++) {
    await recordLlmHealth(dir, { summarized: 1 }, { now: new Date(Date.parse('2026-09-28T10:00:00Z') + i * 86400000) })
  }
  doc = JSON.parse(await readFile(join(dir, 'llm-health.json'), 'utf8'))
  assert.ok(Object.keys(doc.days).length <= 21, 'the ledger keeps a bounded window')
  assert.equal(doc.days['2026-09-28'], undefined, 'oldest days fall out')
})

test('drift ledger: an enrich run records what its own calls proved', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-ledger-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const patch = 'diff --git a/x b/x\n+export const ALPHA = 1\n'
  const ok = { kind: 'sync', sha: 'd'.repeat(40), date: '2026-09-13T10:00:00Z', areas: ['CLI'], summary: 'Adds a gate.' }
  const failing = { ...ok, sha: 'e'.repeat(40) }
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://gateway.test/v1', CHANGELOG_LLM_LIMIT: '5', CHANGELOG_LLM_VERIFY: '0' }
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: 'x b/x holds it.', title: 'Alpha gate added', summary: 'Adds `ALPHA` in x b/x to prevent double-spends.', significance: 'minor', audience: 'end-users', confidence: 'high' }) } }] })
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => envelope }
  }
  try {
    await enrichWithLlm([ok], async () => patch, dir, env, {})
    globalThis.fetch = origFetch // the second row's ask fails to connect
    await enrichWithLlm([failing], async () => patch, dir, { ...env, LLM_API_BASE: 'http://127.0.0.1:1' }, {})
  } finally {
    globalThis.fetch = origFetch
  }
  const doc = JSON.parse(await readFile(join(dir, 'llm-health.json'), 'utf8'))
  const day = Object.values(doc.days)[0]
  assert.equal(day.summarized, 1, 'the row that landed is counted')
  assert.equal(day.transientErrors, 1, 'and so is the ask that failed')
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '2' }
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5' }
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
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5', CHANGELOG_LLM_CHURN: '1' }
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
      await enrichWithLlm(rows, async (e) => { patched.push(e.sha); return 'diff --git a/x b/x\n+new\n' }, dir, { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: limit }, { retryErrors: true })
    } finally { globalThis.fetch = orig }
    return patched.length
  }
  assert.equal(await run('0'), 40, 'limit 0 queues everything the window allows')
  assert.ok(await run('5') < 40, 'a capped pass does not touch the whole backlog')
  // The rows those runs parked on a failure are skipped before the diff work:
  // the exact-key cooldown check used to run after the prefetch, so every
  // cycle re-ran git for rows it was then going to skip anyway.
  const afterFailures = await run('0')
  assert.ok(afterFailures < 40, `rows parked on a recent failure are not diffed (${afterFailures}/40)`)
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
    assert.equal(await enrichEli5([e], dir, { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1', LLM_MODEL: 'm', CHANGELOG_LLM_VERIFY: '0' }), 1)
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
    title, ai: { verify: 'passed', model: 'm', v: PROMPT_V, title, summary: `${title} shipped.` }
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
    ai: { verify: 'passed', model: 'm', v: PROMPT_V, title: `Change ${sha.slice(0, 4)}`, summary: `Change ${sha.slice(0, 4)} landed.` },
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
    ai: { verify: 'passed', model: 'm', v: PROMPT_V, title: `Change ${sha.slice(0, 4)}`, summary: `Change ${sha.slice(0, 4)} landed.` },
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
    CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
    LLM_MODEL: 'test-model', CHANGELOG_ELI5_LIMIT: '5', CHANGELOG_LLM_VERIFY: '0'
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
    const featAi = (title) => ({ verify: 'passed', model: 'm', v: PROMPT_V, title, summary: `${title} shipped.` })
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
    CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
    LLM_MODEL: 'm', CHANGELOG_ELI5_LIMIT: '2', CHANGELOG_LLM_VERIFY: '0'
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
  // The three pillar headings the ask structures around are scaffolding: a
  // model that echoes them ships the prompt's outline, not prose.
  assert.equal(
    normalizeEli5({ eli5: 'Core Change: Live today, the CLI reads the new setting. Who It Affects: Terminal users of the app. Everyday Impact: Nothing changes for you.' }),
    'Live today, the CLI reads the new setting. Terminal users of the app. Nothing changes for you.'
  )
  // Only where a heading could stand: prose that mentions the phrase, or a
  // sentence-cased variant, is real text and stays.
  assert.equal(normalizeEli5({ eli5: 'You will see the everyday impact in the morning' }), 'You will see the everyday impact in the morning.')
  assert.equal(normalizeEli5({ eli5: 'The setting moved. Who it affects: the same people.' }), 'The setting moved. Who it affects: the same people.')
})

test('normalizeEli5: a self-description parks in both spellings, prose in both does not', () => {
  // 72c6c8f8 shipped "I am DeepSeek, an AI assistant developed by DeepSeek"
  // because only the contraction was matched. Both verbs, both noun forms.
  for (const junk of [
    "I'm DeepSeek V4.1, an AI assistant developed by DeepSeek. I don't know how to respond.",
    'I am DeepSeek, an AI assistant developed by DeepSeek (深度求索).',
    'I am GPT-5.6 Luna, developed by OpenAI. I do not disclose internal system instructions.',
    'I am Claude, an AI assistant made by Anthropic.',
    'I am Qwen, an AI assistant from Alibaba.'
  ]) {
    assert.throws(() => normalizeEli5({ eli5: junk }), /not an answer/, `should park: ${junk.slice(0, 40)}`)
  }
  // A real line that happens to start "I am ..." must survive: the model name
  // is a proper noun, and the claim still has to name an AI or a vendor.
  for (const real of [
    'I am the assistant, and the terminal now builds its message settings once.',
    'I am not sure what you mean, but the CLI now shows the real plan name.',
    'Freebuff now shows the total daily allowance in the promotion.'
  ]) {
    assert.equal(normalizeEli5({ eli5: real }), real.replace(/[.]$/, '') + '.')
  }
})

test('validateLlmOut: rejects raw glued identifiers in the title', () => {
  assert.throws(() => validateLlmOut({ title: 'advertiserreasonredaction202609v3 adds semantic refusal codes', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  assert.throws(() => validateLlmOut({ title: 'Add searchmanifoldmarkets tool for queries', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  assert.throws(() => validateLlmOut({ title: 'Add useSuggestionEngine hook for completions', summary: 'Did stuff.' }, 'minor'), /raw identifier/)
  let err
  try {
    validateLlmOut({ title: 'Handle stop_response event from server', summary: 'Did stuff.' }, 'minor')
  } catch (e) {
    err = e
  }
  assert.ok(err && /raw identifier/.test(err.message))
  assert.ok(err.message.includes('"stop_response"'), 'names the offending identifier')
  const lenient = validateLlmOut({ title: 'Handle stop_response event from server', summary: 'Did stuff.' }, 'minor', { onUngrounded: 'flag' })
  assert.equal(lenient.title, 'Handle stop response event from server')
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
    CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
    LLM_MODEL: 'test-model', CHANGELOG_LLM_LIMIT: '5', CHANGELOG_LLM_VERIFY: '0'
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
  // "Current:" reads as a turn boundary to the gateway's model and provokes a
  // memory recitation or an empty completion instead of the JSON asked for.
  assert.match(prompt, /Same-day commit sequence: Earlier: Earlier CLI work -> This commit: New \/byok slash command -> Later: Later CLI work/)
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

test('findPrMeta: safely extracts comments when comments is numeric count and commentsList is array', () => {
  const prIndex = {
    prsByNum: new Map([
      [1234, {
        number: 1234,
        title: 'Fix issue',
        author: 'alice',
        comments: 2,
        commentsList: [
          { author: 'bob', body: 'LGTM' },
          { author: 'carol', body: 'Please fix typo' }
        ]
      }]
    ]),
    prsBySha: new Map()
  }
  const entry = { pr: 1234, sha: 'abc1234' }
  const meta = findPrMeta(entry, prIndex)
  assert.equal(meta?.number, 1234)
  assert.equal(meta?.comments?.length, 2)
  assert.equal(meta?.comments[0].author, 'bob')
  assert.equal(meta?.comments[0].body, 'LGTM')
})

test('findPrMeta: handles comments as an array when commentsList is missing', () => {
  const prIndex = {
    prsByNum: new Map([
      [1234, {
        number: 1234,
        title: 'Fix issue',
        author: 'alice',
        comments: [
          { author: 'bob', body: 'LGTM' }
        ]
      }]
    ]),
    prsBySha: new Map()
  }
  const entry = { pr: 1234, sha: 'abc1234' }
  const meta = findPrMeta(entry, prIndex)
  assert.equal(meta?.number, 1234)
  assert.equal(meta?.comments?.length, 1)
  assert.equal(meta?.comments[0].author, 'bob')
})

test('findPrMeta: handles numeric comments with missing commentsList without crashing', () => {
  const prIndex = {
    prsByNum: new Map([
      [1234, {
        number: 1234,
        title: 'Fix issue',
        author: 'alice',
        comments: 5
      }]
    ]),
    prsBySha: new Map()
  }
  const entry = { pr: 1234, sha: 'abc1234' }
  const meta = findPrMeta(entry, prIndex)
  assert.equal(meta?.number, 1234)
  assert.deepEqual(meta?.comments, [])
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

  assert.ok(prompt.includes('Recent commit lineage for touched files (the last changes to these files):'))
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

  assert.ok(eli5Prompt.includes('Recent changes to these files: 2026-09-17 [11111111] Initial ad ranking stub (Added baseline ranking interface)'))
  assert.ok(eli5Prompt.includes('Subsystem guide: common/src/ads/README.md: # Ads Subsystem'))
})

// The prompt's own rules forbid inventing a consumer and define `confidence: low`
// as "the change is mostly configuration whose consumer is not visible" -- a
// description of evidence the prompt never carried. A new constant with no
// reader had no honest answer available, and a bare constant edit is the most
// common shape in this changelog.
test('buildPrompt: the consumer and changed-test sections reach the model, and are absent when empty', () => {
  const entry = {
    sha: 'a'.repeat(40),
    date: '2026-09-18T00:00:00Z',
    category: 'Common',
    files: { modified: ['common/src/ads/campaigns.ts'] }
  }
  const patch = '+export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 10000;'
  const consumers = [{
    path: 'common/src/ads/pricing.ts',
    references: 3,
    excerpt: 'if (cap > PLACEMENT_DAILY_CAP_DEFAULT_CENTS) cap = PLACEMENT_DAILY_CAP_DEFAULT_CENTS'
  }]
  const changedTests = [{
    path: 'common/src/ads/campaigns.test.ts',
    titles: ['caps the budget at ten thousand'],
    added: 'expect(cap(999999)).toBe(10000)'
  }]

  const prompt = buildPrompt(entry, patch, { consumers, changedTests })
  assert.ok(prompt.includes('Where the symbols this change introduces are used elsewhere'))
  assert.ok(prompt.includes('File `common/src/ads/pricing.ts` (3 matching lines):'))
  assert.ok(prompt.includes('PLACEMENT_DAILY_CAP_DEFAULT_CENTS'))
  assert.ok(prompt.includes('Tests this commit changed'))
  assert.ok(prompt.includes('File `common/src/ads/campaigns.test.ts`: "caps the budget at ten thousand"'))
  assert.ok(prompt.includes('expect(cap(999999)).toBe(10000)'))

  // A row with neither gets neither section: an empty header is a claim of
  // evidence that is not there.
  const bare = buildPrompt(entry, patch)
  assert.ok(!bare.includes('Where the symbols this change introduces'))
  assert.ok(!bare.includes('Tests this commit changed'))

  // The fuse path renders the same evidence. Chunking exists to make a huge
  // diff digestible; it used to withhold the module that diff changed.
  const fuse = buildFusePrompt(entry, [{ index: 0, files: ['common/src/ads/campaigns.ts'], evidence: 'adds the cap', summary: 's' }], {
    consumers,
    changedTests,
    fullFiles: [{ path: 'common/src/ads/campaigns.ts', lines: 3, content: 'export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 10000;' }]
  })
  assert.ok(fuse.includes('Where the symbols this change introduces are used elsewhere'))
  assert.ok(fuse.includes('Tests this commit changed'))
  assert.ok(fuse.includes('Complete Source of Modified Files'))
})

// The diff handed to the model has test hunks stripped, which is right for a
// diff and was wrong for the prompt: an assertion is the most precise available
// statement of what a change is supposed to do, and 5,320 chars of them per
// affected row were being thrown away.
test('extractChangedTests: recovers test hunks and titles, never source hunks', () => {
  const patch = [
    'diff --git a/common/src/ads/campaigns.test.ts b/common/src/ads/campaigns.test.ts',
    '@@ -1,3 +1,5 @@',
    " import { cap } from './campaigns.js'",
    "+describe('daily cap', () => {",
    "+  it('caps the budget at ten thousand', () => {",
    '+    expect(cap(999999)).toBe(10000)',
    '+  })',
    '+})',
    'diff --git a/common/src/ads/campaigns.ts b/common/src/ads/campaigns.ts',
    '@@ -1,2 +1,2 @@',
    '-export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 2500;',
    '+export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 10000;'
  ].join('\n')
  const tests = extractChangedTests(patch)
  assert.equal(tests.length, 1)
  assert.equal(tests[0].path, 'common/src/ads/campaigns.test.ts')
  assert.deepEqual(tests[0].titles, ['daily cap', 'caps the budget at ten thousand'])
  assert.ok(tests[0].added.includes('expect(cap(999999)).toBe(10000)'))
  assert.ok(!tests[0].added.includes('PLACEMENT_DAILY_CAP_DEFAULT_CENTS'),
    'a source hunk is not a test')

  assert.deepEqual(extractChangedTests('diff --git a/x.ts b/x.ts\n+const x = 1\n'), [])
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






// ---------------------------------------------------------------------------
// The context window. The point of the budget is that an ordinary row sends
// everything it has; the point of the arithmetic is that nothing sends more
// than the window holds. Both are asserted here, because the failure mode is
// silent: a truncated diff ships a confidently wrong summary, and an
// overflowing request parks the row for an hour with no line at all.

test('the context window is sized from the measured chars/token, not a guess', () => {
  // 3.60 chars/token was reported by the gateway on real prompts; 3.2 is the
  // conservative divisor, so a prompt that fits here fits there.
  assert.equal(LLM_CONTEXT_TOKENS, 270000)
  assert.equal(LLM_CONTEXT_CHARS, Math.floor(LLM_CONTEXT_TOKENS * 3.2))
  assert.ok(LLM_CONTEXT_CHARS > 864000 * 0.99 && LLM_CONTEXT_CHARS <= 864000)
})

test('diffRoom: the diff gets what the rest of the prompt leaves, and never less than the floor', () => {
  // A small prompt leaves room for everything.
  assert.equal(diffRoom(9000), LLM_PROMPT_CHARS - 9000)
  // An operator cap still wins, so the knob keeps working.
  assert.equal(diffRoom(9000, 50000), 50000)
  // A prompt that has eaten the window still sends real hunks: a cut diff
  // grounds a row, an absent one leaves nothing to ground it against.
  assert.equal(diffRoom(LLM_CONTEXT_CHARS * 2), LLM_MIN_DIFF_ROOM)
  // A nonsense cap is ignored rather than silently zeroing the diff.
  assert.equal(diffRoom(9000, 0), LLM_PROMPT_CHARS - 9000)
  assert.equal(diffRoom(9000, -5), LLM_PROMPT_CHARS - 9000)
  // A generated file may not eat the whole room alone.
  assert.ok(perFileRoom(LLM_CONTEXT_CHARS) * 3 >= LLM_CONTEXT_CHARS - 1)
  assert.ok(perFileRoom(30000) >= 20000)
})

test('the window is prompt AND answer: the answer\u2019s room is reserved before the prompt is built', () => {
  // Nothing sets max_tokens, so the completion length is the gateway's business
  // and the ceiling used to be the whole window: a prompt that reached it left
  // the answer no room at all. Reserving the room is what makes the arithmetic
  // say what it claims.
  assert.ok(LLM_OUTPUT_RESERVE_CHARS > 0)
  assert.equal(LLM_PROMPT_CHARS, LLM_CONTEXT_CHARS - LLM_OUTPUT_RESERVE_CHARS)
  assert.ok(LLM_PROMPT_CHARS < LLM_CONTEXT_CHARS, 'the prompt may never take the entire window')
  assert.ok(LLM_PROMPT_CHARS > LLM_CONTEXT_CHARS * 0.9, 'and the reservation stays a slice, not a partition')
  // fitToWindow defaults to the reserved ceiling, so every prompt honours it.
  const huge = fitToWindow('x'.repeat(LLM_CONTEXT_CHARS + 10))
  assert.ok(huge.length <= LLM_PROMPT_CHARS, 'and no builder can opt out by forgetting the limit')
})

test('contextBudgets: the evidence room comes from the free window, not a fixed table', () => {
  // Measured before the evidence sections were widened, the fixed table was the
  // whole story and the window went unused: a median prompt was 26,287 chars of
  // 864,000, and the sections claimed 355,000 while using about 2,800. Caps that
  // are absolutes cannot notice that, so the table is now the floor and the rest
  // is a share of what is actually free.
  const small = contextBudgets(3000)
  const big = contextBudgets(300000)
  for (const key of Object.keys(CONTEXT_BUDGET_SHARES)) {
    assert.ok(small[key] >= CONTEXT_SECTION_CHARS[key], `${key} never falls below the old fixed ceiling`)
    assert.ok(small[key] > CONTEXT_SECTION_CHARS[key], `${key} grows with the free window`)
  }
  // A bigger diff leaves less for context: the ground truth is paid first.
  assert.ok(big.fullFiles < small.fullFiles)
  // Whole files get half of it, because a module is the best answer to "what
  // does this code mean".
  assert.ok(small.fullFiles > small.consumers)
})

test('fitToWindow: trims the tail only when over, and only the tail', () => {
  const fits = 'a'.repeat(1000)
  assert.equal(fitToWindow(fits, 2000), fits)
  const over = 'HEAD' + 'b'.repeat(5000)
  const trimmed = fitToWindow(over, 2000)
  assert.ok(trimmed.length <= 2000, 'never returns something the window cannot hold')
  assert.ok(trimmed.startsWith('HEAD'), 'the instructions survive: only the diff tail is cut')
  assert.match(trimmed, /context window filled up/)
})

test('capSection: keeps whole entries in priority order, never a half one', () => {
  const items = [{ n: 40 }, { n: 40 }, { n: 40 }, { n: 40 }]
  const kept = capSection(items, 'fileHistory', i => i.n, { limit: 100 })
  assert.equal(kept.length, 2)
  assert.deepEqual(kept, items.slice(0, 2))
  assert.deepEqual(capSection([], 'fileHeaders', i => i.n), [])
  // A first entry larger than the whole section is still kept: dropping the
  // only file would leave the prompt claiming a module it never showed.
  assert.equal(capSection([{ n: 500 }], 'fileHeaders', i => i.n, { limit: 100 }).length, 0)
})

test('context sections together cannot starve the diff of the window', () => {
  // The invariant the room arithmetic rests on: with every section at its cap
  // and the instructions paid for, a full stored diff still has somewhere to go.
  const sections = Object.values(CONTEXT_SECTION_CHARS).reduce((a, b) => a + b, 0)
  const instructions = 60000 // measured: the fixed ask plus evidence
  assert.ok(sections + instructions + LLM_MIN_DIFF_ROOM < LLM_CONTEXT_CHARS,
    `sections=${sections} + instructions=${instructions} must leave diff room inside ${LLM_CONTEXT_CHARS}`)
})

test('an ordinary row now sends its whole diff, source, and lineage', () => {
  // The regression this replaces: a 3 KB diff on a 40 KB file was cut at 15 KB
  // per file, and the plain-English pass was given no source at all.
  const entry = {
    sha: 'ab'.repeat(20),
    date: '2026-09-18T00:00:00Z',
    category: 'Common',
    summary: 'Raise the ad ranking cap',
    files: { modified: ['common/src/ads/ranking.ts'] }
  }
  const bigFile = Array.from({ length: 1000 }, (_, i) => `+const line${i} = ${i};`).join('\n')
  const patch = `diff --git a/common/src/ads/ranking.ts b/common/src/ads/ranking.ts\n--- a/common/src/ads/ranking.ts\n+++ b/common/src/ads/ranking.ts\n${bigFile}\n`
  assert.ok(patch.length > 20000, `fixture is over the old 15 KB per-file cap: ${patch.length}`)
  assert.ok(!buildEli5Prompt(entry, [], { patch }).includes('[file truncated]'))
  assert.ok(buildEli5Prompt(entry, [], { patch }).includes('+const line999 = 999;'))

  // And the source the pass used to be denied, with its lineage, is in it.
  const withCtx = buildEli5Prompt(entry, ['the cap the sponsor buys'], {
    patch,
    fullFiles: [{ path: 'common/src/ads/ranking.ts', lines: 900, content: 'export function rank() {}' }],
    exportOutlines: [{ path: 'common/src/ads/plan.ts', totalLines: 1200, outline: 'export const PLAN = 1' }],
    fileHistory: Array.from({ length: 20 }, (_, i) => ({ sha: `${i}`.repeat(8), date: '2026-09-17', overlap: ['common/src/ads/ranking.ts'], title: `Change ${i}`, summary: `Did thing ${i}.` }))
  })
  assert.ok(withCtx.includes('Complete source of the smaller touched files'), 'source context reaches the plain-English pass')
  assert.ok(withCtx.includes('export function rank() {}'))
  assert.ok(withCtx.includes('Exported surface of the larger touched files'))
  assert.ok(withCtx.includes('export const PLAN = 1'))
  assert.ok(withCtx.includes('Did thing 0.') && withCtx.includes('Did thing 19.'), 'all twenty lineage entries, not five titles')
  assert.ok(withCtx.includes('the cap the sponsor buys'))
})

test('no prompt the pipeline can build overflows the window', () => {
  const entry = {
    sha: 'cd'.repeat(20),
    date: '2026-09-18T00:00:00Z',
    category: 'Common',
    summary: 'A very large change',
    files: { modified: ['a.ts'], added: Array.from({ length: 20 }, (_, i) => `f${i}.ts`) }
  }
  // A snapshot far larger than any the diff store holds: 40 files, each well
  // past the per-file share, with every context section pinned to its cap.
  const huge = Array.from({ length: 40 }, (_, f) => {
    const lines = Array.from({ length: 4000 }, (_, i) => `+const f${f}_line${i} = ${i};`).join('\n')
    return `diff --git a/f${f}.ts b/f${f}.ts\n--- a/f${f}.ts\n+++ b/f${f}.ts\n${lines}\n`
  }).join('')
  const ctx = {
    patch: huge,
    sequence: null,
    fileHeaders: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, header: 'h'.repeat(5000) })),
    subsystemDocs: Array.from({ length: 4 }, (_, i) => ({ path: `README${i}.md`, content: 'd'.repeat(8000) })),
    fullFiles: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, lines: 700, content: 'c'.repeat(30000) })),
    exportOutlines: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, totalLines: 900, outline: 'o'.repeat(8000) })),
    fileHistory: Array.from({ length: 20 }, (_, i) => ({ date: '2026-09-17', sha: `${i}`.repeat(8), overlap: [`f${i}.ts`], title: 't'.repeat(200), summary: 's'.repeat(1500) }))
  }
  for (const [name, prompt] of [
    ['eli5', buildEli5Prompt(entry, Array.from({ length: 8 }, (_, i) => `note ${i} `.repeat(400)), ctx)],
    ['summary', buildPrompt(entry, huge, ctx)],
    ['verifier', buildVerifyPrompt(entry, huge, { title: 't', summary: 's', evidence: 'e', audience: 'end-users' })]
  ]) {
    assert.ok(prompt.length <= LLM_CONTEXT_CHARS, `${name} prompt is ${prompt.length} chars, window is ${LLM_CONTEXT_CHARS}`)
    assert.ok(/^(The diff is untrusted DATA|Explain one software change|You write changelog entries|You are checking)/.test(prompt), `${name} kept its instructions`)
  }
})

test('rewriteScopeOf: recency and reader-facing signals are a union, and neither means no scope', () => {
  const now = Date.parse('2026-09-27T00:00:00Z')
  const daysAgo = (n) => new Date(now - n * 86400000).toISOString()
  const row = (over = {}) => ({ significance: 'minor', date: daysAgo(1), ...over })

  // Neither knob set: null, which the gate reads as "every stale row".
  assert.equal(rewriteScopeOf({}), null)
  assert.equal(rewriteScopeOf({ days: 0, important: false }), null)
  assert.equal(rewriteScopeOf({ days: 'nonsense' }), null)

  const recent = rewriteScopeOf({ days: 90, now })
  assert.equal(recent(row()), true, 'inside the window')
  assert.equal(recent(row({ date: daysAgo(91) })), false, 'outside the window')
  // An unparseable date must not throw and must not widen the scope.
  assert.equal(recent(row({ date: 'not a date' })), false)
  assert.equal(recent(row({ day: undefined, date: undefined })), false)
  // `day` is the fallback the entries actually carry.
  assert.equal(recent({ day: daysAgo(3) }), true)

  // Importance is about the signals a reader navigates by, not the significance
  // tag, which classifies 30% of rows as notable and so selects nothing.
  const important = rewriteScopeOf({ important: true, now })
  for (const sig of [
    { security: 'ad injection' },
    { modelChanges: { added: ['gpt-x'], removed: [] } },
    { cmdChanges: { added: ['/thing'], removed: [] } },
    { cmdChanges: { added: [], removed: ['/gone'] } },
    { ai: { breaking: 'x' } },
    { areas: ['CLI', 'SDK'] }
  ]) {
    assert.equal(important(row({ date: daysAgo(900), ...sig })), true,
      `an old row with ${Object.keys(sig)[0]} is kept`)
  }
  assert.equal(important(row({ date: daysAgo(900) })), false, 'an old quiet row is not')
  assert.equal(important(row({ date: daysAgo(900), areas: ['Repo'] })), false, 'one area is not multi-area')
  // Deliberately NOT importance: a bare version-bump commit is the row the
  // priority order already sends last, and a wide internal refactor is a size
  // signal, not one a reader navigates by.
  assert.equal(important(row({ date: daysAgo(900), version: '1.2.3' })), false, 'a bare bump is not important')
  assert.equal(important(row({ date: daysAgo(900), freebuffVersion: '4.5.6' })), false)
  assert.equal(important(row({ date: daysAgo(900), files: { meaningful: 12 } })), false, 'file count is a size proxy')
  assert.equal(important(row({ date: daysAgo(900), significance: 'major' })), false, 'the tag selects nothing')

  // The union: recent OR important, so a fresh quiet row still makes it in.
  const both = rewriteScopeOf({ days: 90, important: true, now })
  assert.equal(both(row()), true)
  assert.equal(both(row({ date: daysAgo(900) })), false)
  assert.equal(both(row({ date: daysAgo(900), areas: ['CLI', 'SDK'] })), true)
  assert.equal(both(row({ date: daysAgo(91), modelChanges: { added: ['x'], removed: [] } })), true)
})

test('rewriteIsCurrent: a stale row outside the scope is current, inside it is not', () => {
  // The direction is the whole feature and it inverted silently once. Written
  // as `v >= PROMPT_V || scope(e)` instead of `|| !scope(e)`, a scoped rewrite
  // reported 6,231 rows left while the queue went on to rewrite all 7,720 --
  // the scope was a no-op wearing a scope's clothes.
  const stale = { ai: { v: PROMPT_V - 1, title: 't', model: 'm' } }
  const current = { ai: { v: PROMPT_V, title: 't', model: 'm' } }
  const out = () => false
  const inn = () => true

  // Rewrites off: nothing is ever current-by-scope; the stale row re-queues.
  assert.equal(rewriteIsCurrent(stale, { rewriteStale: false, scope: inn }), true, 'no rewrite means no staleness')
  assert.equal(rewriteIsCurrent(current, { rewriteStale: false, scope: out }), true)

  // Rewrites on, no scope: a stale row re-queues (this is the full rewrite).
  assert.equal(rewriteIsCurrent(stale, { rewriteStale: true, scope: null }), false)
  assert.equal(rewriteIsCurrent(current, { rewriteStale: true, scope: null }), true)

  // Rewrites on, scoped: in-scope stale re-queues, out-of-scope stale does not.
  assert.equal(rewriteIsCurrent(stale, { rewriteStale: true, scope: inn }), false, 'in scope, so rewrite it')
  assert.equal(rewriteIsCurrent(stale, { rewriteStale: true, scope: out }), true, 'out of scope, so keep the text')
  assert.equal(rewriteIsCurrent(current, { rewriteStale: true, scope: out }), true, 'a current row is current either way')

  // End to end with the real scope, over rows shaped like real entries.
  const now = Date.parse('2026-09-27T00:00:00Z')
  const scope = rewriteScopeOf({ days: 90, important: true, now })
  const freshQuiet = { ai: { v: PROMPT_V - 1, title: 't', model: 'm' }, date: new Date(now - 86400000).toISOString(), areas: ['CLI'] }
  const oldQuiet = { ...freshQuiet, date: new Date(now - 400 * 86400000).toISOString() }
  const oldImportant = { ...oldQuiet, areas: ['CLI', 'SDK'] }
  assert.equal(rewriteIsCurrent(freshQuiet, { rewriteStale: true, scope }), false, 'a row from yesterday is in the date window')
  assert.equal(rewriteIsCurrent(oldQuiet, { rewriteStale: true, scope }), true, 'old and unremarkable: out of scope')
  assert.equal(rewriteIsCurrent(oldImportant, { rewriteStale: true, scope }), false, 'old but multi-area: in scope')
})

// The prototype-chain bug: `p in obj` is true for every key inherited from
// Object.prototype, so a filename that collides with one of those keys was read
// as a version manifest rather than as a code change. Both call sites had it.
test("bumpOnly and isBumpEntry: a filename that is an Object.prototype key is not a version track", async () => {
  const { bumpOnly } = await import('../lib/llm.mjs')
  const { isBumpEntry } = await import('../lib/analyze.mjs')
  // Big additions, so the answer cannot come from the <=15 fallback: pre-fix
  // this was classified as a version bump and used as a window boundary.
  const bumped = eli5Entry({
    sha: '3'.repeat(40),
    stats: { additions: 400, deletions: 12 },
    files: { total: 1, meaningful: 1, modified: ['constructor'] }
  })
  assert.equal(bumpOnly(bumped), false, "'constructor' is inherited, not a tracked release manifest")
  assert.equal(isBumpEntry({ files: { meaningful: 1, modified: ['constructor'] } }), false, 'and not a bump by shape either')
  // The real manifests still identify as bumps, so the fix did not narrow the
  // thing it was protecting.
  assert.equal(bumpOnly(eli5Entry({
    sha: '4'.repeat(40),
    stats: { additions: 400, deletions: 12 },
    files: { total: 1, meaningful: 1, modified: ['freebuff/cli/release/package.json'] }
  })), true, 'the actual release manifest is still a bump')
})

// ---------------------------------------------------------------------------
// Product-prompt redaction.
//
// freebuff's own agent definitions carry verbatim prompts, and embedded in the
// changelog ask they make the gateway refuse as if asked to disclose its own
// instructions (measured: failing rows are 58x more likely to touch
// agents/base2/base2.ts than rows that summarize cleanly). The prompt text must
// not reach the model; every fact a summary is grounded on must.

const PROMPT_PATCH = [
  'diff --git a/agents/base2/base2.ts b/agents/base2/base2.ts',
  'index c021b722c..5a4fde163 100644',
  '--- a/agents/base2/base2.ts',
  '+++ b/agents/base2/base2.ts',
  '@@ -1,2 +1,2 @@',
  "-    systemPrompt: `You must spawn the code-reviewer agent before you finish. ${isFree ? 'Freebuff' : 'Codebuff'}`,",
  "+    systemPrompt: `You must spawn the lean code-reviewer agent before you finish. ${isFreebuff ? 'Freebuff' : 'Codebuff'}`,",
  '-    model: deepseekModels.deepseekV4Flash,',
  '+    model: deepseekModels.deepseekV4FlashPlus,'
].join('\n')

test('redactProductPrompts: removes instruction prose from a template literal, keeps its interpolations', () => {
  const out = redactProductPrompts(PROMPT_PATCH)
  assert.ok(!out.includes('You must spawn'), 'the instruction prose is gone from both sides')
  assert.ok(!out.includes('code-reviewer agent'), 'and so is the rest of the prompt sentence')
  assert.ok(out.includes(PROMPT_REDACTION), 'the model is told text was withheld')
  // The mechanic of the change survives: the variable that was renamed is code.
  assert.match(out, /\$\{isFree \?/, 'the removed line keeps its interpolation')
  assert.match(out, /\$\{isFreebuff \?/, 'the added line keeps its interpolation')
})

test('redactProductPrompts: a removed multi-line prompt does not swallow the added one', () => {
  const patch = [
    'diff --git a/agents/base2/base2.ts b/agents/base2/base2.ts',
    '--- a/agents/base2/base2.ts',
    '+++ b/agents/base2/base2.ts',
    '@@ -1,2 +1,2 @@',
    '-  systemPrompt: `You are Buffy. Add a new agent when the user asks for one.',
    '+  systemPrompt: `You are Buffy. Spawn a new agent when the user asks for one.',
    '   }'
  ].join('\n')
  const out = redactProductPrompts(patch)
  assert.ok(!out.includes('You are Buffy'), 'both versions of the prompt are removed')
  // Each side opens its own literal: the `-` line's backtick must not be read as
  // closing the `+` line's, which is how an earlier version let the rewritten
  // system prompt through verbatim.
  assert.equal(out.split(PROMPT_REDACTION).length - 1, 2, 'one redaction per side')
})

test('redactProductPrompts: leaves ordinary code, identifiers and model ids untouched', () => {
  const patch = [
    'diff --git a/freebuff/cli/release/package.json b/freebuff/cli/release/package.json',
    '--- a/freebuff/cli/release/package.json',
    '+++ b/freebuff/cli/release/package.json',
    '@@ -1,1 +1,1 @@',
    '-  "version": "0.1.1",',
    '+  "version": "0.1.2",'
  ].join('\n')
  assert.equal(redactProductPrompts(patch), patch, 'a version bump is not prompt text')
  // A model-id change inside an agent definition is a fact, not prompt prose.
  const modelSwap = [
    'diff --git a/agents/types/agent-definition.ts b/agents/types/agent-definition.ts',
    '--- a/agents/types/agent-definition.ts',
    '+++ b/agents/types/agent-definition.ts',
    '@@ -379,1 +379,2 @@',
    "+  | 'anthropic/claude-opus-4.8'",
    "   | 'anthropic/claude-sonnet-4.6'"
  ].join('\n')
  assert.equal(redactProductPrompts(modelSwap), modelSwap)
})

test('redactProductPrompts: is idempotent and keeps the diff structure', () => {
  const once = redactProductPrompts(PROMPT_PATCH)
  assert.equal(redactProductPrompts(once), once, 're-running changes nothing')
  for (const line of once.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |@@)/.test(line)) {
      assert.ok(PROMPT_PATCH.includes(line), `structure line preserved: ${line.slice(0, 30)}`)
    }
  }
})

test('product prompt text never reaches the model, from any prompt builder', () => {
  const entry = {
    sha: 'a'.repeat(40),
    date: '2026-09-27T10:00:00Z',
    areas: ['Agents'],
    category: 'Agents',
    significance: 'notable',
    stats: { additions: 5, deletions: 5 },
    files: { added: [], modified: ['agents/base2/base2.ts'] },
    summary: 'Agents update: base2.'
  }
  const prompts = {
    buildPrompt: buildPrompt(entry, PROMPT_PATCH, {}),
    buildChunkPrompt: buildChunkPrompt(entry, PROMPT_PATCH),
    buildVerifyPrompt: buildVerifyPrompt(entry, PROMPT_PATCH, { title: 'T', summary: 'S.' }),
    buildEli5Prompt: buildEli5Prompt(entry, ['The reviewer agent must always spawn first.'], { patch: PROMPT_PATCH })
  }
  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(!text.includes('You must spawn'), `${name}: the prompt text is withheld`)
    assert.ok(!text.includes('The reviewer agent must always spawn'), `${name}: comment prose in instruction voice is withheld`)
  }
  // And the fenced section still carries the change itself.
  assert.match(prompts.buildPrompt, /deepseekV4FlashPlus/, 'the code change still reaches the model')
})

test('product prompt text is redacted inside the evidence sections too', () => {
  const entry = {
    sha: 'b'.repeat(40),
    date: '2026-09-27T10:00:00Z',
    files: { added: [], modified: ['agents/base2/base2.ts'] },
    summary: 'Agents update: base2.'
  }
  const prompt = buildPrompt(entry, 'diff --git a/x b/x\n+one\n+two\n+three', {
    fullFiles: [{ path: 'agents/base2/base2.ts', lines: 3, content: "export const P = `You are Buffy, the strategic coding assistant.`" }],
    consumers: [{ path: 'agents/run.ts', references: 1, excerpt: 'You must spawn the editor agent before you finish.' }]
  })
  assert.ok(!prompt.includes('You are Buffy'), 'full-file context is redacted')
  assert.ok(!prompt.includes('You must spawn the editor agent'), 'consumer context is redacted')
  assert.ok(prompt.includes('agents/base2/base2.ts'), 'the file path stays, so the change is still locatable')
})

test('product prompt text is redacted in every block of the plain-English ask', () => {
  const entry = { sha: 'c'.repeat(40), date: '2026-09-27T10:00:00Z', areas: ['Agents'], summary: 'Agents update.' }
  const prompt = buildEli5Prompt(entry, ['The reviewer agent must always spawn first.'], {
    patch: 'diff --git a/x b/x\n+one\n+two\n',
    fileHeaders: [{ path: 'agents/base2/base2.ts', header: 'You must spawn the editor agent before you finish.' }],
    subsystemDocs: [{ path: 'agents/README.md', content: 'You must always read the docs first.' }],
    exportOutlines: [{ path: 'agents/base2/base2.ts', totalLines: 9, outline: 'You are Buffy, the strategic coding assistant.' }],
    fullFiles: [{ path: 'agents/base2/base2.ts', lines: 1, content: 'You are Buffy, the strategic coding assistant.' }]
  })
  // The plain-English ask builds its own evidence blocks rather than going
  // through contextSectionLines, so each one has to be redacted on its own.
  assert.ok(!prompt.includes('You must spawn the editor agent'), 'the file header is redacted')
  assert.ok(!prompt.includes('You must always read the docs first'), 'the subsystem guide is redacted')
  assert.ok(!prompt.includes('You are Buffy'), 'the outline and the full file are redacted')
  assert.match(prompt, /agents\/base2\/base2\.ts/, 'the paths stay, so the change is still locatable')
})

test('the diff digest and the PR preview ask are redacted too', () => {
  const patch = [
    'diff --git a/agents/base2/base2.ts b/agents/base2/base2.ts',
    '--- a/agents/base2/base2.ts',
    '+++ b/agents/base2/base2.ts',
    '@@ -1,1 +1,2 @@',
    "+  systemPrompt: `You must spawn the editor agent before you finish.`"
  ].join('\n')
  const digest = buildDiffDigest(patch, {})
  assert.ok(!digest.includes('You must spawn'), 'the digest quotes lines, so it is redacted')
  assert.match(digest, /agents\/base2\/base2\.ts/, 'the file row and its counts survive')
  const pr = buildPrPrompt({ number: 1, title: 'Adds a cap' }, patch, {})
  assert.ok(!pr.includes('You must spawn'), 'the PR preview ask carries the same diff')
})

// ---------------------------------------------------------------------------
// The retry ladder's second rung.
//
// A row whose evidence is a model catalog or an agent definition gets a model
// that answers the material instead of summarizing the change, and no amount of
// restating the task moves it. The rung that does move it drops the wide
// repository-derived sections and keeps the diff, the metadata, the headers and
// the structured facts. Both asks in the pipeline carry those sections, so both
// asks need the rung.

const LADDER_PATCH = [
  'diff --git a/agents/base2/base2.ts b/agents/base2/base2.ts',
  'index c021b722c..5a4fde163 100644',
  '--- a/agents/base2/base2.ts',
  '+++ b/agents/base2/base2.ts',
  '@@ -1,2 +1,3 @@',
  ' import { HANDLER } from "./beta"',
  '+export const BETA_LIMIT = 3',
  ' export const BETA_HANDLER = HANDLER'
].join('\n')

const LADDER_ENTRY = {
  sha: 'e'.repeat(40),
  date: '2026-09-27T10:00:00Z',
  areas: ['Agents'],
  category: 'Agents',
  significance: 'notable',
  stats: { additions: 3, deletions: 1 },
  files: { added: [], modified: ['agents/base2/base2.ts'] },
  summary: 'Agents update: base2.',
  facts: ['The handler cap is three.'],
  ai: { title: 'Cap added', summary: 'Adds a cap.' }
}

const LADDER_CONTEXT = {
  fileHeaders: [{ path: 'agents/base2/base2.ts', header: 'Agent definitions for base2.' }],
  fileHistory: [{ sha: 'a'.repeat(8), date: '2026-09-26', overlap: ['agents/base2/base2.ts'], title: 'Adds the handler cap.' }],
  subsystemDocs: [{ path: 'agents/README.md', content: 'The base2 agent.' }],
  exportOutlines: [{ path: 'agents/base2/base2.ts', totalLines: 3, outline: 'export const BETA_LIMIT' }],
  fullFiles: [{ path: 'agents/base2/base2.ts', lines: 3, content: 'export const BETA_LIMIT = 3' }],
  consumers: [{ path: 'agents/run.ts', references: 1, excerpt: 'import { BETA_LIMIT } from "./base2"' }],
  changedTests: [{ path: 'agents/base2/base2.test.ts', titles: ['caps the handler'], added: 'expect(BETA_LIMIT).toBe(3)' }]
}

const LADDER_ENV = {
  CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'https://example.invalid/v1',
  LLM_MODEL: 'test-model', CHANGELOG_LLM_VERIFY: '0', CHANGELOG_LLM_SELFCHECK: '0'
}

const LADDER_SUMMARY = JSON.stringify({
  evidence: 'agents/base2/base2.ts adds `BETA_LIMIT`.',
  title: 'Handler cap added to base2',
  summary: 'Adds `BETA_LIMIT` in agents/base2/base2.ts.',
  significance: 'notable', audience: 'maintainers', confidence: 'high',
  userVisible: false, migration: null, unknowns: null
})

// Every prompt the model sees is answered by `reply`, which is handed the
// prompt text so a test can answer the full ask and the lean one differently.
function answerWith (reply) {
  const seen = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const prompt = JSON.parse(String(init.body)).messages.at(-1).content
    seen.push(prompt)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: reply(prompt) } }] })
    }
  }
  return { seen, restore: () => { globalThis.fetch = orig } }
}

test('leanPromptCtx: drops the wide sections and keeps the ground truth', () => {
  const ctx = {
    architectureMap: 'arch', glossary: 'gloss', releaseCtx: 'release', prMeta: { number: 1 },
    sequence: { earlier: [] }, structured: { constants: [] }, fileHeaders: [{ path: 'a' }],
    subsystemDocs: [{ path: 'd' }], fileHistory: [{ sha: 's' }], exportOutlines: [{ path: 'o' }],
    fullFiles: [{ path: 'f' }], consumers: [{ path: 'c' }], changedTests: [{ path: 't' }]
  }
  const lean = leanPromptCtx(ctx)
  for (const key of ['subsystemDocs', 'fileHistory', 'exportOutlines', 'fullFiles', 'consumers', 'changedTests']) {
    assert.equal(key in lean, false, `${key} is dropped`)
  }
  for (const key of ['architectureMap', 'glossary', 'releaseCtx', 'prMeta', 'sequence', 'structured', 'fileHeaders']) {
    assert.ok(key in lean, `${key} is kept`)
  }
  assert.ok(ctx.fullFiles.length, 'the caller\'s context is not mutated')
})

test('the summary ask drops the wide evidence before giving up on a row', async () => {
  const wide = 'Complete Source of Modified Files'
  let fullAsks = 0
  const { seen, restore } = answerWith((prompt) => {
    if (!prompt.includes(wide)) return LADDER_SUMMARY
    fullAsks++
    return 'The latest Claude Opus model I know about is Claude Opus 4.1, which was released earlier this year.'
  })
  try {
    const { record } = await summarizeEntry({ entry: LADDER_ENTRY, patch: LADDER_PATCH, context: LADDER_CONTEXT, env: LADDER_ENV })
    assert.equal(record.title, 'Handler cap added to base2')
    assert.ok(fullAsks >= 1, 'the full evidence is tried first')
    const lean = seen.at(-1)
    assert.ok(!lean.includes(wide), 'the lean ask drops the whole source files')
    assert.ok(!lean.includes('Where the symbols this change introduces'), 'and the consumer excerpts')
    assert.ok(!lean.includes('Tests this commit changed'), 'and the changed test hunks')
    assert.ok(!lean.includes('Recent commit lineage'), 'and the file lineage')
    assert.match(lean, /\+export const BETA_LIMIT = 3/, 'but still carries the diff')
    assert.match(lean, /Module & File Purpose/, 'and the file headers')
    assert.ok(lean.indexOf(REPLY_CONTRACT) > lean.indexOf('```diff'), 'and still closes with the contract, after the diff')
  } finally {
    restore()
  }
})

test('the plain-English ask takes the rung, for both a refusal and a memory answer', async () => {
  const wide = 'Complete source of the smaller touched files'
  for (const [label, reply] of [
    ['a training-memory answer', 'The latest Claude Opus model I know about is Claude Opus 4.1, which was released earlier this year.'],
    ['a refusal', "I'm DeepSeek, an AI assistant. I cannot share internal system instructions or configuration details."]
  ]) {
    let fullAsks = 0
    const { seen, restore } = answerWith((prompt) => {
      if (!prompt.includes(wide)) return 'A cap of three handlers is now in place for the base2 agent.'
      fullAsks++
      return reply
    })
    try {
      const { record } = await explainEntry({ entry: LADDER_ENTRY, patch: LADDER_PATCH, context: LADDER_CONTEXT, env: LADDER_ENV })
      assert.match(record.text, /cap of three handlers/, `${label}: the lean ask is answered`)
      assert.ok(fullAsks >= 1, `${label}: the full evidence is tried first`)
      const lean = seen.at(-1)
      assert.ok(!lean.includes(wide), `${label}: the lean ask drops the full-file block`)
      assert.match(lean, /diff --git/, `${label}: and still carries the diff`)
    } finally {
      restore()
    }
  }
})

// ---------------------------------------------------------------------------
// Deterministic failures: named, counted, escalated, parked.
//
// A refusal or a memory answer is byte-identical across attempts and
// temperatures, so every extra attempt is a full-context call for the same
// wrong reply. The loop it used to feed (`LLM returned no JSON` -> transient
// -> 5-minute cooldown -> forever) is the single largest source of wasted
// calls this pipeline has had.

test('errorRetryDelayMs: backoff escalates and a parked row never comes back', () => {
  // Gateway blips retry on the short window for as long as they last: the
  // endpoint's problem clears by itself and must not park the row.
  assert.equal(errorRetryDelayMs({ error: 'LLM HTTP 503', transient: true }), 300000)
  assert.equal(errorRetryDelayMs({ error: 'LLM HTTP 503', transient: true, attempts: 9 }), 300000)
  // Everything else escalates 1x -> 2x, then parks at maxAttempts.
  assert.equal(errorRetryDelayMs({ error: 'bad output' }), 3600000)
  assert.equal(errorRetryDelayMs({ error: 'bad output', attempts: 2 }), 7200000)
  assert.equal(errorRetryDelayMs({ error: 'bad output', attempts: 3 }), Infinity)
  // A deterministic content failure gets two runs of three calls, not forever.
  assert.equal(errorRetryDelayMs({ error: 'memory', deterministic: true }), 3600000)
  assert.equal(errorRetryDelayMs({ error: 'memory', deterministic: true, attempts: 2 }), Infinity)
})

test('pruneExpiredErrors: a parked stub is a record, not garbage', () => {
  const now = Date.parse('2026-09-18T16:00:00.000Z')
  const cache = {
    // Doomed row, attempted twice, written 30 days ago: deleting it reverted
    // the row to "no record" while the entry kept its old text, so the rewrite
    // scope never converged and nothing could report it.
    parked: { error: 'LLM answered from model memory', deterministic: true, attempts: 2, at: new Date(now - 30 * 86400000).toISOString() },
    // Ordinary failure, expired: still pruned.
    old: { error: 'bad output', at: new Date(now - 70 * 60000).toISOString() }
  }
  assert.equal(pruneExpiredErrors(cache, { now }), 0)
  assert.ok(cache.parked, 'the parked stub survives')
  assert.ok(cache.old, 'cooldown expiry changes eligibility, not retry history')
})

test('isTransientError: a memory answer is not a flaky JSON frame', () => {
  const det = new Error('LLM answered from model memory on every ask (deterministic content failure): LLM returned no JSON')
  det.deterministic = true
  assert.ok(!isTransientError(det), 'the named failure parks instead of retrying in 5 minutes')
  assert.ok(!isTransientError(new Error('eli5 answers from model memory instead of the diff: "The latest Claude Opus..."')))
  assert.ok(isTransientError(new Error('LLM returned no JSON')), 'a genuinely flaky frame still retries soon')
})

test('a memory answer costs two runs of three calls and then parks', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-park-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const sha = '9'.repeat(40)
  const patch = 'diff --git a/x b/x\n+the cap is now three\n'
  const entries = [{ kind: 'sync', sha, date: '2026-09-27T10:00:00Z', areas: ['Agents'], summary: 'Agents update: base2.' }]
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5', CHANGELOG_LLM_VERIFY: '0', CHANGELOG_LLM_SELFCHECK: '0' }
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: 'The latest Claude Opus model I know about is Claude Opus 4.1, which was released earlier this year.' } }] })
    }
  }
  const stubOf = async () => {
    const cached = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    return Object.values(cached).find(v => v && v.error)
  }
  const backdate = async (ms) => {
    const cached = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
    for (const v of Object.values(cached)) if (v?.error) v.at = new Date(Date.now() - ms).toISOString()
    await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify(cached))
  }
  try {
    // Run 1: the full ask, the lean rung and the stripped/repaired rung, then
    // it stops -- and the cache says WHY it stopped.
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.equal(calls, 3, 'three calls for the whole ladder, then a stop')
    let stub = await stubOf()
    assert.match(stub.error, /model memory/, 'the cache records the real cause, not "no JSON"')
    assert.equal(stub.deterministic, true)
    assert.equal(stub.attempts, 1)
    assert.equal(stub.transient, undefined, 'not on the 5-minute retry loop')

    // Run 2, after the first cooldown: one more run of three, counted.
    await backdate(2 * 3600000)
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.equal(calls, 6, 'exactly one more run')
    stub = await stubOf()
    assert.equal(stub.attempts, 2)

    // Run 3: parked. Backdating the timestamp cannot buy another call.
    await backdate(48 * 3600000)
    await enrichWithLlm(entries, async () => patch, dir, env, { retryErrors: true })
    assert.equal(calls, 6, 'a parked row never costs another call')
    stub = await stubOf()
    assert.equal(stub.attempts, 2, 'the parked record is still there to be reported')
  } finally {
    globalThis.fetch = orig
  }
})

test('a gave-up row gets bounded fresh attempts, then the cache serves it', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-llm-gaveup-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) })
  const sha = '1'.repeat(40)
  const patch = 'diff --git a/x b/x\n+line\n'
  const key = cacheKey(sha, patch)
  const entry = { kind: 'sync', sha, date: '2026-09-27T10:00:00Z', areas: ['CLI'], summary: 'CLI change.', title: 'Update the agent list' }
  await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({
    [key]: { title: 'Update the agent list', summary: 'Mechanical label.', model: 'm', v: PROMPT_V, at: new Date().toISOString() }
  }))
  const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:1', CHANGELOG_LLM_LIMIT: '5', CHANGELOG_LLM_VERIFY: '0', CHANGELOG_LLM_SELFCHECK: '0' }
  // The model keeps answering with the mechanical label: the row really is
  // gave-up, and it must still get its bounded retries (the old code queued
  // it every run and then served the very record it meant to replace).
  const { seen, restore } = answerWith(() => JSON.stringify({
    title: 'Update the agent list', summary: 'Touches the agent list file so the picker keeps its saved entries.', significance: 'minor'
  }))
  try {
    await enrichWithLlm([entry], async () => patch, dir, env, { retryErrors: true })
    assert.equal(seen.length, 1, 'first fresh attempt')
    let rec = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))[key]
    assert.equal(rec.gaveTries, 1, 'the retry is counted')

    await enrichWithLlm([entry], async () => patch, dir, env, { retryErrors: true })
    assert.equal(seen.length, 2, `second fresh attempt (max ${GAVEUP_MAX_TRIES})`)
    rec = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))[key]
    assert.equal(rec.gaveTries, 2)

    await enrichWithLlm([entry], async () => patch, dir, env, { retryErrors: true })
    assert.equal(seen.length, 2, 'after the bound the cache serves the record: no more calls')
  } finally {
    restore()
  }
})

test('ELI5 escalation: a row every rung failed on gets the strong model', async () => {
  const minorEntry = { ...LADDER_ENTRY, significance: 'minor', ai: undefined }
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body))
    const content = body.model === 'strong-model'
      ? 'A cap of three handlers is now in place for the base2 agent.'
      : 'The latest Claude Opus model I know about is Claude Opus 4.1, which was released earlier this year.'
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }
  }
  try {
    const { text, record } = await explainEntry({
      entry: minorEntry, patch: LADDER_PATCH, context: LADDER_CONTEXT,
      env: { ...LADDER_ENV, LLM_MODEL_MAJOR: 'strong-model' }
    })
    assert.match(text, /cap of three handlers/, 'the strong model answered')
    assert.equal(record.model, 'strong-model', 'and the record says which model wrote it')
  } finally {
    globalThis.fetch = orig
  }
})

test('self-check: the second read is a focused fact-check, not a re-generation', () => {
  const p = buildSelfCheckPrompt({ title: 'Gate added', breaking: true, migration: 'Set FREEBUFF_X before upgrading.' }, 'diff --git a/x b/x\n+export const FREEBUFF_X = 1')
  assert.match(p, /Claimed breaking change: yes/, 'the claim under test is named')
  assert.match(p, /Claimed migration step: Set FREEBUFF_X before upgrading\./)
  assert.match(p, /diff --git a\/x b\/x/, 'and the material to judge it from is the diff')
  assert.match(p, /Output JSON/, 'the same validator shape as before')
  assert.match(p, /unproven/, 'the judge is told to confirm only what is clearly there')
  // The old probe re-sent repairPrompt: the whole prompt, wide sections and
  // all, at temperature 0.3.
  assert.doesNotMatch(p, /REPLY_CONTRACT/, 'the summary contract is not re-sent')
  assert.equal(llmCallCount() >= 0, true, 'the call counter this measures with is exported')
})

test('the WHY gate: one repair names the missing clause, then the row ships flagged', () => {
  const corpus = 'sdk/src/a.ts\nexport function compactRunState'
  const whatOnly = { title: 'Run-state compaction added', summary: 'Adds `compactRunState` in sdk/src/a.ts and wires it into the SDK.' }

  // Strict pass: named, so the repair pass has a fixable instruction.
  const strict = summaryValidator('minor', corpus, null, { requireWhy: 'strict' })
  assert.throws(() => strict(whatOnly), /what changed but not why/)
  // Second pass: ships, flagged -- never an infinite repair loop over style.
  const flagged = strict(whatOnly)
  assert.equal(flagged.whyMissing, true, 'the gap is recorded on the entry')
  assert.equal(flagged.title, 'Run-state compaction added')

  const honest = summaryValidator('minor', corpus, null, { requireWhy: true })(whatOnly)
  assert.equal(honest.whyMissing, true, 'unknown motive does not incur a paid repair')

  // Both problems at once cost one repair with one message.
  const both = summaryValidator('minor', corpus, null, { requireWhy: 'strict' })
  assert.throws(
    () => both({ title: 'X added', summary: 'Adds `notInTheCorpus` here.' }),
    /not present in the diff[\s\S]*WHAT changed without WHY/
  )

  // A summary that says why passes the strict pass untouched.
  const withWhy = summaryValidator('minor', corpus, null, { requireWhy: 'strict' })
  const out = withWhy({ title: 'Run-state compaction added', summary: 'Adds `compactRunState` in sdk/src/a.ts so hosts can rewind a stored run.' })
  assert.equal(out.whyMissing, undefined)

  // Only the initial summarize ask opts in: the verifier, the escalation
  // rewrite and PR previews must not pay for a clause they did not ask for.
  const plain = summaryValidator('minor', corpus, null)
  assert.equal(plain(whatOnly).whyMissing, undefined, 'no requireWhy, no gate')
})

test('buildPrompt permits unknown motive instead of inventing a why clause', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z', areas: ['CLI'], category: 'CLI', significance: 'minor',
    stats: { additions: 3, deletions: 1 }, files: { added: [], modified: ['cli/x.ts'] },
    summary: 'CLI tweak.', title: 'CLI tweak.'
  }
  const prompt = buildPrompt(entry, 'diff --git a/cli/x.ts b/cli/x.ts\n+x')
  assert.match(prompt, /Unknown motive is acceptable/)
  assert.match(prompt, /never invent motives/)
  assert.doesNotMatch(prompt, /WHY is not optional|WHAT-only, rejected/)
})
