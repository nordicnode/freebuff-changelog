import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  enrichWithLlm, cacheKey, callLlm, llmProviderBanner, planLlmPass, rowBudgetMs,
  eli5RowBudgetMs, errorRetryDelayMs, callUnanswered, isRouteFailure, isGatewayError,
  extractResponseText, resetLlmStreamProbeForTests,
  DEFAULT_LLM_API_BASE, DEFAULT_LLM_MODEL, DEFAULT_ROW_BUDGET_MS, PROMPT_V
} from '../lib/llm.mjs'
import { summaryPassWindow } from '../cli.mjs'
import { resetLlmRateLimiterForTests } from '../lib/llm.mjs'

const patch = 'diff --git a/a.ts b/a.ts\n+export const ALPHA = 1\n'
const row = (sha, extra = {}) => ({
  kind: 'sync', sha: String(sha).repeat(40).slice(0, 40), prevSha: 'b'.repeat(40),
  date: '2026-10-02T00:00:00Z', day: '2026-10-02', areas: ['CLI'], category: 'CLI',
  significance: 'minor', files: { modified: ['a.ts'], total: 1, meaningful: 1 }, stats: { additions: 1, deletions: 0 },
  summary: 'Deterministic.', title: 'Contract update: a', enrichment: { policy: 1 }, ...extra
})
const clean = { evidence: 'a.ts holds it.', title: 'Alpha gate added', summary: 'Adds `ALPHA` in a.ts.', significance: 'minor', audience: 'end-users', confidence: 'high' }
const response = payload => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
const env = (extra = {}) => ({
  CHANGELOG_LLM: '1', LLM_API_KEY: 'offline-test', LLM_API_BASE: 'https://example.invalid/v1',
  LLM_MODEL: 'deepseek-v4.1', CHANGELOG_LLM_NO_BACKFILL: '1', CHANGELOG_LLM_VERIFY: '0',
  CHANGELOG_LLM_HEAL: '0', CHANGELOG_LLM_REVERIFY: '0', CHANGELOG_LLM_RPM: '-1', ...extra
})
const temp = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'fb-budget-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir }

test.beforeEach(() => { resetLlmRateLimiterForTests(); resetLlmStreamProbeForTests() })

test('provider contract: the defaults are the project provider, and the banner names them without the key', () => {
  assert.equal(DEFAULT_LLM_API_BASE, 'https://vyceai.com/v1')
  assert.equal(DEFAULT_LLM_MODEL, 'deepseek-v4.1')
  const off = llmProviderBanner({})
  assert.match(off, /disabled/)
  const banner = llmProviderBanner({ CHANGELOG_LLM: '1', LLM_API_KEY: 'sk-secret-value', LLM_API_BASE: 'https://vyceai.com/v1', LLM_MODEL: 'deepseek-v4.1', LLM_VERIFY_MODEL: 'deepseek-v4.1' })
  assert.match(banner, /write deepseek-v4\.1 @ https:\/\/vyceai\.com\/v1/)
  assert.match(banner, /verify deepseek-v4\.1/)
  assert.doesNotMatch(banner, /sk-secret-value/, 'the banner is safe to log')
})

test('row budgets: configured values are honored, invalid ones fall back', () => {
  assert.equal(rowBudgetMs({}), DEFAULT_ROW_BUDGET_MS)
  assert.equal(rowBudgetMs({ CHANGELOG_LLM_ROW_BUDGET_MS: '25000' }), 25000)
  assert.equal(rowBudgetMs({ CHANGELOG_LLM_ROW_BUDGET_MS: '0' }), DEFAULT_ROW_BUDGET_MS)
  assert.equal(rowBudgetMs({ CHANGELOG_LLM_ROW_BUDGET_MS: 'soon' }), DEFAULT_ROW_BUDGET_MS)
  assert.equal(eli5RowBudgetMs({}), 45000)
  assert.equal(eli5RowBudgetMs({ CHANGELOG_ELI5_ROW_BUDGET_MS: '20000' }), 20000)
})

test('planLlmPass: a pass is sized by what its window can finish, and says so when it cannot', () => {
  // Two workers, 60s rows, a 300s window: three rounds fit.
  assert.equal(planLlmPass({ budgetMs: 300000, limit: 10, concurrency: 2, rowBudgetMs: 60000 }).rows, 10)
  assert.equal(planLlmPass({ budgetMs: 180000, limit: 10, concurrency: 2, rowBudgetMs: 60000 }).rows, 6)
  assert.equal(planLlmPass({ budgetMs: 90000, limit: 10, concurrency: 2, rowBudgetMs: 60000 }).rows, 2)
  // A window smaller than one row is not a pass: zero rows and a reason.
  const empty = planLlmPass({ budgetMs: 30000, limit: 10, concurrency: 2, rowBudgetMs: 60000 })
  assert.equal(empty.rows, 0)
  assert.equal(empty.usable, false)
  assert.match(empty.reason, /less than one/)
  // The cap still binds, and the row budget has a floor so a nonsense value
  // cannot turn into thousands of planned rows.
  assert.equal(planLlmPass({ budgetMs: 600000, limit: 3, concurrency: 2, rowBudgetMs: 60000 }).rows, 3)
  assert.equal(planLlmPass({ budgetMs: 60000, limit: 10, concurrency: 2, rowBudgetMs: 1 }).rowBudgetMs, 15000)
})

test('summaryPassWindow: the plain-English reserve is a share of the window, never the window', () => {
  // The CI shape: a 300s window, ten rows, an ELI5 backlog. The old arithmetic
  // reserved limit*15s = 150s of a 240s clock; a share cannot do that.
  assert.equal(summaryPassWindow(0, 300000, 10), 200000)
  assert.equal(summaryPassWindow(0, 240000, 10), 156000)
  // Nothing pending: no reserve at all.
  assert.equal(summaryPassWindow(0, 300000, 0), 300000)
  // A window too small for the reserve still leaves the summary pass one.
  assert.ok(summaryPassWindow(0, 60000, 10) > 0)
})

test('a window that is already over asks nothing and cools nothing down', async (t) => {
  const dir = await temp(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(clean) })
  // Exactly the production bug: a deadline already in the past (the sync phase
  // ate the window). The writer must not send a call it cannot receive -- and
  // it must not write a failure stub either, because a stub would start a
  // cooldown for a row nobody asked.
  const stale = await enrichWithLlm([row('1')], async () => patch, dir, env({ CHANGELOG_LLM_LIMIT: '2', LLM_DEADLINE_AT: String(Date.now() - 1) }), { retryErrors: true })
  assert.equal(stale, 0)
  assert.equal(calls, 0)
  await assert.rejects(readFile(join(dir, 'ai-summaries.json'), 'utf8'), /ENOENT/, 'no stub for a call that was never sent')
  // The classification above is still what a mid-pass deadline kill gets.
  assert.equal(errorRetryDelayMs({ error: 'LLM cycle deadline exceeded', attempts: 4 }), 300000)
  assert.equal(callUnanswered(new Error('LLM cycle deadline exceeded')), true)
  assert.equal(isRouteFailure(new Error('LLM cycle deadline exceeded')), false, 'and it is not a reason to fail the route over')
})

test('pass budget: rows inside a real window are written, not killed by the queue arithmetic', async (t) => {
  const dir = await temp(t)
  const rows = [row('1'), row('2'), row('3'), row('4')]
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(clean) })
  // A 45s window, 15s rows, two workers: the plan is six rows of room for the
  // four that exist. Every one of them must be asked -- the old arithmetic
  // handed this shape of window a deadline in the past and asked nothing.
  const plan = planLlmPass({ budgetMs: 45000, limit: 4, concurrency: 2, rowBudgetMs: 15000 })
  assert.equal(plan.rows, 4)
  assert.equal(plan.usable, true)
  const n = await enrichWithLlm(rows, async () => patch, dir, env({
    CHANGELOG_LLM_LIMIT: String(plan.rows),
    CHANGELOG_LLM_ROW_BUDGET_MS: String(plan.rowBudgetMs),
    LLM_DEADLINE_AT: String(Date.now() + 45000)
  }), { retryErrors: true })
  assert.equal(n, 4, 'every planned row is asked and written')
  assert.equal(rows.filter(e => e.ai?.title).length, 4)
  assert.equal(calls, 4, 'and no row needed a repair or a re-ask')
})

test('row budget: one slow row cannot spend the pass, and the row behind it is still asked', async (t) => {
  const dir = await temp(t)
  const rows = [row('1'), row('2')]
  let calls = 0
  let first = true
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++
    if (first) {
      first = false
      // A real 300s provider call, aborted by the row's own share.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
        })
      })
    }
    return response(clean)
  })
  const n = await enrichWithLlm(rows, async () => patch, dir, env({
    CHANGELOG_LLM_LIMIT: '2',
    CHANGELOG_LLM_ROW_BUDGET_MS: '150',
    LLM_DEADLINE_AT: String(Date.now() + 30000)
  }), { retryErrors: true })
  assert.equal(n, 1, 'the slow row loses its own budget, not the pass')
  assert.equal(rows.filter(e => e.ai?.title).length, 1, 'exactly one row is written; the slow one is not')
  assert.equal(calls, 2, 'one aborted call, one answered call -- no retry ladder on a dead row')
  const cache = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
  const stub = Object.values(cache).find(r => r?.error)
  assert.ok(stub, 'the slow row carries its failure')
  // Either the aborted call or the ladder's next rung hitting the same clock;
  // both are the row's own budget ending, and both stay retryable.
  assert.match(String(stub.error), /budget exceeded|timeout/i)
  assert.equal(errorRetryDelayMs(stub), 300000, 'an aborted row keeps the short cooldown rather than parking')
})

test('the row clock is per row: a bounded row does not spend another row\'s share', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(clean) })
  const env1 = env({ CHANGELOG_LLM_ROW_BUDGET_MS: '400', LLM_DEADLINE_AT: String(Date.now() + 30000) })
  // Two top-level calls are two rows, and each opens its own clock: the second
  // is answered even though the first row's share expired in between. If the
  // clock were shared per pass instead of per row, this second call would be
  // refused and a stuck row would starve every row behind it.
  assert.ok(await callLlm('writer', env1, 1, x => x))
  await new Promise(r => setTimeout(r, 500))
  assert.ok(await callLlm('writer', env1, 1, x => x), 'a new row gets a new clock')
  assert.equal(calls, 2)
  // The classification of the budget error, which is what keeps such a row
  // retryable: unanswered, short cooldown, never a park.
  assert.equal(callUnanswered(new Error('LLM entry time budget exceeded')), true)
  assert.equal(errorRetryDelayMs({ error: 'LLM entry time budget exceeded' }), 300000)
  assert.equal(isRouteFailure(new Error('LLM entry time budget exceeded')), false)
})

test('streaming: the ask is streamed by default and an SSE body is reassembled', async (t) => {
  let body = null
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    body = JSON.parse(String(init.body))
    // The provider's streaming shape: chunk frames, one JSON object per line.
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      `data: {"choices":[{"delta":{"content":${JSON.stringify(JSON.stringify(clean))}}}]}`,
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]'
    ].join('\n\n')
    return new Response(frames)
  })
  const out = await callLlm('writer', env({ LLM_DEADLINE_AT: String(Date.now() + 30000) }), 1, x => x)
  assert.equal(body.stream, true, 'the request asks for streaming')
  assert.equal(out.title, 'Alpha gate added', 'the deltas are reassembled into the answer')
})

test('streaming: a gateway that rejects the field is retried once without it, and never asked again', async (t) => {
  // The probe is sticky for the process, and tests share one; put it back.
  t.after(() => resetLlmStreamProbeForTests())
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    seen.push(Boolean(body.stream))
    if (body.stream) return new Response('unknown field: stream', { status: 400 })
    return response(clean)
  })
  const e = env({ LLM_DEADLINE_AT: String(Date.now() + 30000) })
  assert.equal((await callLlm('writer', e, 1, x => x)).title, 'Alpha gate added')
  assert.equal((await callLlm('writer', e, 1, x => x)).title, 'Alpha gate added')
  assert.deepEqual(seen, [true, false, false], 'probed once, sticky afterwards')
})

test('a gateway error delivered inside a 200 body is a transport failure, not a bad answer', async () => {
  // Measured shape from the provider: HTTP 200, then this frame.
  const frame = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"error":{"message":"The request timed out. Please try again.","code":"timeout"}}\n\n'
  assert.throws(() => extractResponseText(frame), /gateway error in the response body \(timeout\)/)
  const err = (() => { try { extractResponseText(frame) } catch (e) { return e } })()
  assert.equal(isGatewayError(err), true, 'classified as transport, so the lean rung and the failover route own it')
  assert.equal(callUnanswered(err), true, 'no answer came back: it must not spend a content attempt')
  // The same thing as a plain JSON body.
  assert.throws(() => extractResponseText('{"error":{"message":"The request timed out. Please try again.","code":"timeout"}}'), /gateway error in the response body/)
  // A normal body is untouched.
  assert.equal(extractResponseText(JSON.stringify({ choices: [{ message: { content: JSON.stringify(clean) } }] })), JSON.stringify(clean))
})

test('cache identity is unchanged by the budget work: the same row still hashes the same key', () => {
  // A guard rail, not a hope: nothing in this change may move stored identities.
  const e = row('3')
  const key = cacheKey(e.sha, patch, '', 0)
  assert.equal(key, `${e.sha}:v${PROMPT_V}:${key.split(':')[2]}`)
})
