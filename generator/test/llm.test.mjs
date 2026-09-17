// generator/test/llm.test.mjs - tests for the LLM enrichment module
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLlmJson, buildPrompt, enrichWithLlm, enrichEli5, llmConfigured, validateLlmOut, truncateWords, budgetPatch, cacheKey, firstSentence, isTransientError, shortError, PROMPT_V, ELI5_V, eli5Eligible, eli5Done, eli5Source, eli5Key, normalizeEli5, buildEli5Prompt, eli5Notes, eli5Patch } from '../lib/llm.mjs'
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
  assert.match(prompt, /Files: README\.md/)
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
  const out = validateLlmOut({ title: 'Ad Reason Redaction v3 adds semantic refusal codes', summary: 'Did stuff.' }, 'minor')
  assert.equal(out.title, 'Ad Reason Redaction v3 adds semantic refusal codes')
})

test('normalizeEli5: points robotic pronouns at the reader and cuts archive bleed', () => {
  assert.equal(normalizeEli5({ eli5: 'Workers put rules in place, so that person would notice nothing different today.' }),
    'Workers put rules in place, so you would notice nothing different today.')
  assert.equal(normalizeEli5({ eli5: 'Nothing changes for the viewer today.' }), 'Nothing changes for you today.')
  const bled = normalizeEli5({ eli5: 'You will see no changes today because this only collects details. May 13, 2025 (22)May 12, 2025 (15)' })
  assert.ok(!/2025/.test(bled), 'archive calendar cut')
  assert.ok(bled.endsWith('.'), 'cut end repunctuated')
})

test('buildEli5Prompt: addresses you, leads with experience, stops at sentences', () => {
  const p = buildEli5Prompt(eli5Entry(), [], {})
  assert.match(p, /what you would notice/)
  assert.match(p, /never write "that person"/)
  assert.match(p, /NEVER use conversational preambles/)
  assert.match(p, /An access change recorded in the evidence is a change/)
  assert.match(p, /without|Never invent/)
  assert.match(p, /Include an effective date only when the evidence supplies it/)
})

test('buildPrompt: tells the model to translate identifiers', () => {
  const p = buildPrompt({ date: '2026-09-16T00:00:00Z', areas: ['CLI'], significance: 'minor' }, 'diff')
  assert.match(p, /glued identifier/)
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
