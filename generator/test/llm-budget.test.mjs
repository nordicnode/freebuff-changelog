import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadChangelog } from '../lib/changelog-store.mjs'
import {
  enrichWithLlm, cacheKey, callLlm, llmProviderBanner, planLlmPass, rowBudgetMs,
  eli5RowBudgetMs, errorRetryDelayMs, callUnanswered, isRouteFailure, isGatewayError, isTransientError,
  extractResponseText, resetLlmStreamProbeForTests, llmConfigured, llmKeysOf, nextLlmKey,
  resetLlmKeyRotationForTests, backupEnvOf, createLlmRateLimiter, llmRpm, llmCapOf,
  rollupLlmEnv, stageLlmEnv, ROLLUP_LLM_STAGE,
  DEFAULT_LLM_API_BASE, DEFAULT_LLM_MODEL, DEFAULT_ROW_BUDGET_MS, PROMPT_V,
  enrichEli5, enrichOpenPrs, summaryBacklog, validateLlmConfig, llmCallCount, llmRouteIdentity, ELI5_V,
  buildEli5Prompt, diffRoom, promptCharsForClock, LLM_PREFILL_CHARS_PER_SEC,
  LLM_PROMPT_CLOCK_SHARE, LLM_PROMPT_CHARS, LLM_MIN_DIFF_ROOM, eli5RollupBudgetMs, explainEntry,
  mapPhaseDiffRoom, PROMPT_PREAMBLE_CHARS, leadWithLean, eli5Source, summarizeEntry
} from '../lib/llm.mjs'
import { summaryPassWindow, regenerationEli5Deadline, cmdGenerationHealth, cmdWatch } from '../cli.mjs'
import { generationHealth, qualityOf } from '../lib/quality.mjs'
import { checkDeployedHead } from '../lib/sync.mjs'
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

test.beforeEach(() => { resetLlmRateLimiterForTests(); resetLlmStreamProbeForTests(); resetLlmKeyRotationForTests() })

test('provider contract: the defaults are the project provider, and the banner names them without the key', () => {
  assert.equal(DEFAULT_LLM_API_BASE, 'https://apihub.agnes-ai.com/v1')
  assert.equal(DEFAULT_LLM_MODEL, 'agnes-3.0-flash')
  const off = llmProviderBanner({})
  assert.match(off, /disabled/)
  const banner = llmProviderBanner({ CHANGELOG_LLM: '1', LLM_API_KEY: 'sk-secret-value', LLM_API_BASE: 'https://apihub.agnes-ai.com/v1', LLM_MODEL: 'agnes-3.0-flash', LLM_VERIFY_MODEL: 'agnes-3.0-flash' })
  assert.match(banner, /write agnes-3\.0-flash @ https:\/\/apihub\.agnes-ai\.com\/v1/)
  assert.match(banner, /verify agnes-3\.0-flash/)
  assert.doesNotMatch(banner, /sk-secret-value/, 'the banner is safe to log')
})

test('configuration faults fail once without spending slots, reading patches or poisoning rows', async t => {
  const dir = await temp(t)
  let calls = 0, reads = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(clean) })
  for (const extra of [{ LLM_API_BASE: '-' }, { LLM_API_BASE: 'file:///tmp/key' }, { LLM_API_BASE: 'https://user:secret@example.invalid/v1' }, { LLM_API_BASE: 'https://example.invalid/v1?key=secret' }, { LLM_API_BASE: 'https://example.invalid/v1/chat/completions' }, { LLM_MODEL: '-' }, { LLM_BACKUP_API_BASE: 'https://backup.invalid/v1' }, { CHANGELOG_ROLLUP_LLM_API_KEY: 'secret' }]) {
    const bad = env(extra)
    assert.throws(() => validateLlmConfig(bad), /LLM configuration:/)
    const before = llmCallCount()
    await assert.rejects(enrichWithLlm([row('1')], async () => { reads++; return patch }, dir, bad), /LLM configuration:/)
    assert.equal(llmCallCount(), before)
  }
  await assert.rejects(callLlm('prompt', env({ LLM_API_BASE: '-' })), /absolute HTTP/)
  assert.equal(calls, 0)
  assert.equal(reads, 0)
  await assert.rejects(readFile(join(dir, 'ai-summaries.json')), /ENOENT/)
  validateLlmConfig(env())
})

test('auth failure is a configuration fault, not a parked row; watch fails immediately', async t => {
  const dir = await temp(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('private auth detail', { status: 401 }))
  await assert.rejects(enrichWithLlm([row('1')], async () => patch, dir, env(), { retryErrors: true }), /configuration: primary authentication failed/)
  await assert.rejects(readFile(join(dir, 'ai-summaries.json')), /ENOENT/)
  let cycles = 0
  await assert.rejects(cmdWatch(['--duration', '1s'], { cycle: async () => { cycles++; validateLlmConfig(env({ LLM_API_BASE: '-' })) } }), /configuration:/)
  assert.equal(cycles, 1)
})

test('old-route parked failures and explanation failures cannot veto the writer', async t => {
  const dir = await temp(t)
  const e = row('1')
  const oldKey = cacheKey(e.sha, patch, '', 0, { model: 'old', provider: 'https://old.invalid/v1' })
  await writeFile(join(dir, 'ai-summaries.json'), JSON.stringify({
    [oldKey]: { error: 'LLM answered from model memory', deterministic: true, attempts: 2, at: new Date().toISOString() },
    [`${e.sha}:eli5:v${ELI5_V}:old`]: { error: 'LLM refused the request', deterministic: true, attempts: 2, at: new Date().toISOString() }
  }))
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(clean) })
  assert.equal(await enrichWithLlm([e], async () => patch, dir, env({ LLM_MODEL: 'agnes-3.0-flash' }), { retryErrors: true }), 1)
  assert.equal(e.ai.model, 'agnes-3.0-flash')
  assert.equal(calls, 1)
})

test('same-identity cooldown avoids patch work, but explicit force bypasses it', async t => {
  const dir = await temp(t)
  const e = row('1')
  let reads = 0, calls = 0, good = false
  t.mock.method(globalThis, 'fetch', async () => { calls++; return good ? response(clean) : response({ title: '' }) })
  const read = async () => { reads++; return patch }
  await enrichWithLlm([e], read, dir, env(), { retryErrors: true })
  const cache = JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))
  const stub = Object.values(cache).find(r => r.error)
  assert.ok(stub.inputIdentity)
  assert.equal(stub.routeIdentity, llmRouteIdentity(env()))
  const before = { reads, calls }
  await enrichWithLlm([e], read, dir, env(), { retryErrors: true })
  assert.deepEqual({ reads, calls }, before, 'cooling requests cost no diff work or calls')
  const backlog = await summaryBacklog([e], dir, env())
  assert.equal(backlog.cooling, 1)
  assert.equal(backlog.eligible, 0)
  good = true
  assert.equal(await enrichWithLlm([e], read, dir, env(), { force: new Set([e.sha]), only: new Set([e.sha]), retryErrors: true }), 1)
  assert.equal((await summaryBacklog([e], dir, env())).pending.length, 0)
})

test('provider and backup changes release old-route cooldowns without resetting same-route retries', async t => {
  const dir = await temp(t)
  const e = row('1')
  t.mock.method(globalThis, 'fetch', async () => response({ title: '' }))
  await enrichWithLlm([e], async () => patch, dir, env(), { retryErrors: true })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(clean) })
  const changed = env({ LLM_BACKUP_API_BASE: 'https://backup.invalid/v1', LLM_BACKUP_API_KEY: 'backup', LLM_BACKUP_MODEL: 'different' })
  assert.equal((await summaryBacklog([e], dir, changed)).eligible, 1)
  assert.equal(await enrichWithLlm([e], async () => patch, dir, changed, { retryErrors: true }), 1)
  assert.equal(calls, 1)
})

test('parked probes stay bounded and transient outages never become permanent parks', () => {
  const deterministic = { error: 'LLM answered from model memory', deterministic: true, attempts: 20 }
  assert.equal(errorRetryDelayMs(deterministic), Infinity)
  assert.equal(errorRetryDelayMs(deterministic, { parkedRetryMs: 86400000 }), 86400000)
  assert.equal(errorRetryDelayMs({ error: 'LLM HTTP 504', transient: true, attempts: 100 }, { parkedRetryMs: 86400000 }), 300000)
  assert.equal(errorRetryDelayMs({ error: 'Failed to parse URL from -/chat/completions', attempts: 100 }), 300000)
})

test('third-attempt gateway error envelope still reaches the backup route', async t => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async url => {
    seen.push(String(url))
    return String(url).includes('backup.invalid') ? response({ ok: true }) : new Response('data: {"error":{"code":"timeout","message":"The request timed out"}}\n\n')
  })
  const cfg = env({ LLM_BACKUP_API_BASE: 'https://backup.invalid/v1', LLM_BACKUP_API_KEY: 'backup' })
  assert.deepEqual(await callLlm('prompt', cfg, 3, x => x, { usedLean: true }), { ok: true })
  assert.equal(seen.length, 2)
})

test('memory answer followed by backup timeout is transient, not deterministic parking', async t => {
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('backup.invalid') ? new Response('data: {"error":{"code":"timeout","message":"The request timed out"}}\n\n') : response({ text: 'The latest model I know about is from my knowledge cutoff.' }))
  const cfg = env({ LLM_BACKUP_API_BASE: 'https://backup.invalid/v1', LLM_BACKUP_API_KEY: 'backup' })
  await assert.rejects(callLlm('prompt', cfg, 3, () => { throw new Error('answered from model memory') }, { usedLean: true }), err => {
    assert.equal(isTransientError(err), true)
    assert.equal(callUnanswered(err), true)
    assert.notEqual(err.deterministic, true)
    return true
  })
})

test('healing with verification off improves unchecked text without clearing recorded objections', async t => {
  for (const verify of ['unchecked', 'flagged']) {
    const dir = await temp(t), e = row('1')
    t.mock.method(globalThis, 'fetch', async () => response(clean))
    await enrichWithLlm([e], async () => patch, dir, env())
    const cachePath = join(dir, 'ai-summaries.json')
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    const key = Object.keys(cache).find(k => cache[k].title)
    const record = { ...cache[key], ungrounded: ['INVENTED'], at: '2020-01-01T00:00:00Z', ...(verify === 'flagged' ? { verify: 'flagged', verifyClaims: [{ claim: 'An unsupported claim remains' }] } : {}) }
    e.ai = { ...record }
    await writeFile(cachePath, JSON.stringify({ [key]: record }))
    await enrichWithLlm([e], async () => patch, dir, env({ CHANGELOG_LLM_HEAL: '1' }))
    const updated = JSON.parse(await readFile(cachePath, 'utf8'))[key]
    if (verify === 'unchecked') {
      assert.equal(e.ai.ungrounded, undefined)
      assert.equal(updated.verify, undefined, 'no fake passing verdict')
    } else {
      assert.equal(updated.verify, 'flagged')
      assert.equal(updated.verifyClaims[0].claim, 'An unsupported claim remains')
    }
  }
})

test('PR previews retry a changed provider and retain transient retry eligibility', async t => {
  const dir = await temp(t)
  const pr = { number: 1, title: 'Alpha added', body: 'Adds ALPHA.', enrichment: { policy: 1 } }
  t.mock.method(globalThis, 'fetch', async () => response({ title: '' }))
  await enrichOpenPrs([pr], dir, env(), { getDiff: async () => patch })
  const old = JSON.parse(await readFile(join(dir, 'pr-summaries.json'), 'utf8'))
  assert.ok(Object.values(old)[0].inputIdentity)
  t.mock.method(globalThis, 'fetch', async () => response(clean))
  assert.equal(await enrichOpenPrs([pr], dir, env({ LLM_MODEL: 'agnes-3.0-flash' }), { getDiff: async () => patch }), 1)
  assert.equal(pr.ai.verify, undefined, 'verification off is not a provider outage')
})

test('regeneration gives explanations their own post-summary window under the total deadline', () => {
  const started = 1000000, total = 360000, plain = 144000
  assert.equal(regenerationEli5Deadline(started, total, plain, started + 216000), started + 360000)
  assert.equal(regenerationEli5Deadline(started, total, plain, started + 180000) - (started + 180000), plain)
  assert.equal(regenerationEli5Deadline(started, total, plain, started + total), started + total)
})

test('generation health gates overdue admitted text, not intentional unchecked text or historical gaps', async t => {
  const dir = await temp(t), now = Date.parse('2026-10-05T12:00:00Z')
  const ready = row('1', { enrichment: { policy: 1, admittedAt: '2026-10-05T10:00:00Z' }, ai: { title: 'Alpha added', summary: 'Adds Alpha.', policy: 1 }, eli5: { text: 'Alpha is present.', policy: 1 } })
  const recent = row('2', { enrichment: { policy: 1, admittedAt: '2026-10-05T11:59:00Z' } })
  const old = row('3', { enrichment: undefined })
  const overdue = row('4', { enrichment: { policy: 1, admittedAt: '2026-10-05T11:00:00Z' } })
  const rows = [ready, recent, old, overdue]
  const h = generationHealth(rows, { now })
  assert.equal(h.admitted, 3)
  assert.equal(h.reviewPending, 1)
  assert.deepEqual(h.overdue.map(e => e.sha), [overdue.sha])
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({ entries: rows }))
  await assert.rejects(cmdGenerationHealth([], { dataDir: dir, now, env: {} }), /44444444/)
  // --report is the same reading without the throw, for the workflow that only
  // publishes (deploy-site): it cannot write text or dispatch a cycle, so the
  // relay keeps the hard verdict. It must still return the row list.
  const reported = await cmdGenerationHealth(['--report'], { dataDir: dir, now, env: {} })
  assert.deepEqual(reported.overdue.map(e => e.sha), [overdue.sha])
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({ entries: [ready, recent, old] }))
  assert.equal((await cmdGenerationHealth([], { dataDir: dir, now, env: {} })).overdue.length, 0)
})

test('a rewritten summary restarts its line clock; the admission clock cannot make it instantly overdue', async t => {
  const dir = await temp(t), now = Date.parse('2026-10-05T12:00:00Z')
  // Admitted 4 days ago, so the admission clock alone calls it overdue...
  const admission = { policy: 1, admittedAt: '2026-10-01T08:00:00Z' }
  // ...and its summary was rewritten 2 minutes ago, which is what deleted the
  // plain-English line. The relay has had those 2 minutes, not 4 days.
  const rewritten = row('5', { enrichment: admission, ai: { title: 'Beta added', summary: 'Adds Beta.', policy: 1, at: '2026-10-05T11:58:00Z' } })
  assert.deepEqual(generationHealth([rewritten], { now }).overdue, [])
  assert.equal(generationHealth([rewritten], { now }).missingPlain, 1)
  // The same row with a summary written long ago is a real gap and stays red.
  const stalled = row('6', { enrichment: admission, ai: { title: 'Gamma added', summary: 'Adds Gamma.', policy: 1, at: '2026-10-01T08:00:00Z' } })
  assert.deepEqual(generationHealth([stalled], { now }).overdue.map(e => e.sha), [stalled.sha])
  assert.equal(generationHealth([stalled], { now }).overdue[0].missingSince, '2026-10-01T08:00:00.000Z')
  // Once the grace elapses the rewritten row is overdue like any other.
  assert.deepEqual(generationHealth([rewritten], { now: now + 30 * 60000 }).overdue.map(e => e.sha), [rewritten.sha])
})

test('prompt size is bound by the row clock, not only by the model window', () => {
  // The measurement this exists for: a real production call carrying 828,311
  // chars answered in 63,439 ms (13,056 chars/second), and the plain-English
  // clock is 45s. A prompt is sized from half the clock, so the biggest row in
  // the repo cannot be asked a question its own budget cannot prefill.
  const share = LLM_PROMPT_CLOCK_SHARE
  assert.equal(promptCharsForClock(45000), Math.max(LLM_MIN_DIFF_ROOM, Math.floor(45 * LLM_PREFILL_CHARS_PER_SEC * share)))
  assert.equal(promptCharsForClock(90000), 2 * promptCharsForClock(45000))
  // No clock known: the window stays the only ceiling (the old behavior).
  assert.equal(promptCharsForClock(undefined), Infinity)
  assert.equal(diffRoom(9000, Infinity, Infinity), LLM_PROMPT_CHARS - 9000)
  assert.equal(diffRoom(9000, Infinity), LLM_PROMPT_CHARS - 9000)
  // A clock: the diff gets what is left of it, not what is left of the window.
  assert.equal(diffRoom(9000, Infinity, 45000), promptCharsForClock(45000) - 9000)
  assert.equal(diffRoom(9000, Infinity, 90000), promptCharsForClock(90000) - 9000)
  // Either ceiling can win, and the floor survives both.
  assert.equal(diffRoom(LLM_PROMPT_CHARS + 1000, Infinity, 45000), LLM_MIN_DIFF_ROOM)
  assert.equal(diffRoom(9000, 50000, 45000), 50000)
  assert.equal(diffRoom(9000, 5000, 45000), 5000)
  assert.equal(diffRoom(9000, Infinity, 0), LLM_MIN_DIFF_ROOM)
})

test('a plain-English row is never asked a prompt its own clock cannot prefill', async t => {
  const dir = await temp(t)
  const e = row('1', { ai: { ...clean, model: 'test', v: PROMPT_V } })
  // ~1.2 MB across three files: the shape of the row that stayed unexplained.
  const huge = [1, 2, 3].map(n => `diff --git a/big${n}.ts b/big${n}.ts\n` + '+export const BIG = 1\n'.repeat(20000)).join('')
  const clockMs = 45000
  const ceiling = promptCharsForClock(clockMs)
  const bounded = buildEli5Prompt(e, [], { patch: huge, rowBudgetMs: clockMs, diffBytes: Infinity })
  assert.ok(bounded.length <= ceiling + 20000, `prompt is ${bounded.length} chars against a ${ceiling}-char clock ceiling`)
  const unbounded = buildEli5Prompt(e, [], { patch: huge, diffBytes: Infinity })
  assert.ok(unbounded.length > bounded.length * 3, 'without a clock the same row carries the whole diff')
  let sent = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => { sent = String(init.body).length; return response({ eli5: 'The gate reads a flag before it acts.' }) })
  assert.equal(await enrichEli5([e], dir, env({ CHANGELOG_ELI5_ROW_BUDGET_MS: String(clockMs) }), { retryErrors: true, getPatch: async () => huge }), 1)
  assert.ok(sent <= ceiling + 20000, `the call sent ${sent} chars, the row clock allows ${ceiling}`)
  assert.equal(e.eli5.text, 'The gate reads a flag before it acts.')
})

test('the plain-English pass charges its rows to CHANGELOG_ELI5_ROW_BUDGET_MS, not the summary budget', async t => {
  const dir = await temp(t)
  const text = { eli5: 'The gate reads a flag before it acts.' }
  let calls = 0
  // A model that answers in 1.2s. Against a 150ms plain-English clock that is
  // eight times too slow, and the only question is which clock cut it.
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(text)), 1200)
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })) })
    })
  })
  // The plain-English clock owns the row (enrichEli5 remaps its knob onto the
  // generic one, and explainEntry charges the scope to it directly), so a share
  // too small for the call leaves the row for the next cycle instead of
  // spending it. This is the 45s clock that the 842,051-char prompt
  // overran on every cycle.
  const e = row('1', { ai: { ...clean, model: 'test', v: PROMPT_V } })
  assert.equal(await enrichEli5([e], dir, env({ CHANGELOG_ELI5_ROW_BUDGET_MS: '150' }), { retryErrors: true, getPatch: async () => patch }), 0)
  assert.ok(calls >= 1, 'the call was attempted and then cut, not skipped')
  assert.equal(e.eli5, undefined)
  assert.match(Object.values(JSON.parse(await readFile(join(dir, 'ai-summaries.json'), 'utf8'))).find(r => r.error).error, /budget exceeded|aborted/)
  // The summary budget is not the plain-English clock: the same row shape, under
  // a summary clock of the same 150ms, is answered on the default 45s share.
  const other = row('2', { ai: { ...clean, model: 'test', v: PROMPT_V } })
  assert.equal(await enrichEli5([other], dir, env({ CHANGELOG_LLM_ROW_BUDGET_MS: '150' }), { retryErrors: true, getPatch: async () => patch }), 1)
  assert.equal(other.eli5.text, text.eli5)
})

test('a release roll-up is charged the wide clock, not the per-change share', async t => {
  const dir = await temp(t)
  // A roll-up carries the release window (the same wide evidence the summary
  // ask pays 90s for) and answers in up to eight sentences. Charged the 45s
  // per-change share it was aborted mid-answer and wrote nothing, which is how
  // a bump row kept failing its explanation in production while smaller rows in
  // the same pass finished in seconds.
  assert.equal(eli5RollupBudgetMs({ CHANGELOG_ELI5_ROW_BUDGET_MS: '45000', CHANGELOG_LLM_ROW_BUDGET_MS: '90000' }), 90000)
  assert.equal(eli5RollupBudgetMs({ CHANGELOG_ELI5_ROLLUP_BUDGET_MS: '120000' }), 120000)
  assert.equal(eli5RollupBudgetMs({ CHANGELOG_ELI5_ROW_BUDGET_MS: '60000', CHANGELOG_LLM_ROW_BUDGET_MS: '60000' }), 60000, 'the wider of the two, never narrower than the per-change share')
  assert.equal(eli5RollupBudgetMs({ CHANGELOG_ELI5_ROW_BUDGET_MS: '60000' }), 90000, 'the summary default is the wider clock when only one is stated')
  // Sizing follows the same clock: the window is the fixed part, so a wider
  // clock is what lets a big release window keep real hunks.
  const window = `Updates included in this release (1.2.3 since 1.2.2):\n${'- a shipped change with a sentence of what it did\n'.repeat(3000)}`
  // Not `bumpOnly`: such a row drops the diff from the roll-up ask entirely, so
  // the two clocks would have nothing to differ about.
  const bump = row('9', { version: '1.2.3', stats: { additions: 200, deletions: 10 }, files: { modified: ['a.ts'], total: 6, meaningful: 6 }, ai: { ...clean, model: 'test', v: PROMPT_V } })
  const bigPatch = ['diff --git a/a.ts b/a.ts\n', '+export const X = 1\n'.repeat(30000)].join('')
  const narrow = buildEli5Prompt(bump, [], { patch: bigPatch, releaseCtx: window, rowBudgetMs: 45000 })
  const wide = buildEli5Prompt(bump, [], { patch: bigPatch, releaseCtx: window, rowBudgetMs: 90000 })
  assert.ok(wide.length > narrow.length, 'the wide clock buys back hunks the narrow one cut')
  assert.ok(wide.length <= promptCharsForClock(90000) + 20000, `roll-up prompt is ${wide.length} chars`)
  // And the clock really is what the row is charged: same 1.2s answer, same
  // 150ms plain-English share, but the roll-up row is allowed its wider clock
  // while the per-change row is cut.
  const text = { eli5: 'The gate reads a flag before it acts.' }
  t.mock.method(globalThis, 'fetch', async (url, init) => await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(response(text)), 1200)
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })) })
  }))
  const shared = env({ CHANGELOG_ELI5_ROW_BUDGET_MS: '150', CHANGELOG_LLM_ROW_BUDGET_MS: '90000' })
  const rollup = await explainEntry({ entry: row('3', { version: '1.2.3' }), patch, relText: window, env: shared, dataDir: dir })
  assert.equal(rollup.text, text.eli5)
  await assert.rejects(explainEntry({ entry: row('4'), patch, relText: '', env: shared, dataDir: dir }), /budget exceeded|aborted/)
})

test('served probe refuses an old deploy even when the upstream head did not move', async () => {
  const now = Date.parse('2026-10-05T12:00:00Z')
  const fetchImpl = async () => new Response(JSON.stringify({ headSha: 'head', generatedAt: '2026-10-05T11:58:00Z' }))
  await assert.rejects(checkDeployedHead('https://site.invalid', 'head', { now, fetchImpl, minGeneratedAt: '2026-10-05T11:59:00Z' }), /older than the uploaded/)
})

test('forced explanation generation bypasses a current cached explanation without touching neighbors', async t => {
  const dir = await temp(t), e = row('1')
  e.ai = { ...clean, model: 'test', v: PROMPT_V }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ eli5: 'The internal setting changed.' }) })
  assert.equal(await enrichEli5([e], dir, env(), { getPatch: async () => patch }), 1)
  const before = calls
  assert.equal(await enrichEli5([e], dir, env(), { getPatch: async () => patch }), 0)
  assert.equal(calls, before)
  assert.equal(await enrichEli5([e], dir, env(), { force: new Set([e.sha]), only: new Set([e.sha]), getPatch: async () => patch }), 1)
  assert.equal(calls, before + 1)
})

test('missing explanations outrank stale rewrites under a bounded pass', async t => {
  const dir = await temp(t)
  const missing = row('1', { date: '2026-10-01T00:00:00Z', ai: { ...clean, model: 'test', v: PROMPT_V } })
  const stale = row('2', {
    significance: 'notable', ai: { ...clean, model: 'test', v: PROMPT_V },
    eli5: { text: 'An earlier explanation.', v: ELI5_V, src: 'old-source', model: 'test' }
  })
  t.mock.method(globalThis, 'fetch', async () => response({ eli5: 'The internal setting changed.' }))
  assert.equal(await enrichEli5([stale, missing], dir, env({ CHANGELOG_ELI5_LIMIT: '1' }), { getPatch: async () => patch }), 1)
  assert.equal(missing.eli5?.text, 'The internal setting changed.')
  assert.equal(stale.eli5.text, 'An earlier explanation.', 'optional rewrite keeps its shipped text and spends no slot')
})

test('CLI regen-last writes both artifacts even when the writer consumes over 40% of the budget', async t => {
  const root = await temp(t), source = join(root, 'source')
  await mkdir(source)
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test')
  await writeFile(join(source, 'a.ts'), 'export const ALPHA = 0\n')
  git('add', 'a.ts'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  await writeFile(join(source, 'a.ts'), 'export const ALPHA = 1\n')
  git('add', 'a.ts'); git('commit', '-qm', 'alpha')
  const sha = git('rev-parse', 'HEAD')
  const e = row('1', { sha, prevSha: base, enrichment: { policy: 1, admittedAt: '2026-10-05T00:00:00Z' } })
  await mkdir(join(root, 'data'))
  await writeFile(join(root, 'data/changelog.json'), JSON.stringify({ generatedAt: new Date().toISOString(), headSha: sha, entries: [e] }))
  const preload = join(root, 'offline-provider.mjs')
  // Advance the clock after the successful writer reply, not real wall time:
  // this is the production deadline shape without waiting three minutes.
  await writeFile(preload, `let offset=0; const clock=Date.now; Date.now=()=>clock()+offset;
    globalThis.fetch=async (url,init)=>{const p=JSON.parse(init.body).messages.at(-1).content;
    const plain=/Reply with JSON only:.*eli5|"eli5":/.test(p); if(!plain)offset+=180000;
    const out=plain?{eli5:'The internal setting changed.'}:${JSON.stringify(clean)};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]}));};`)
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
  const result = spawnSync(process.execPath, ['--import', preload, cli, 'regen-last', sha], {
    env: { ...process.env, ...env({ CHANGELOG_WORKSPACE_ROOT: root, FREEBUFF_REPO: source, CHANGELOG_LLM_RPM_WARMUP: '0', LLM_API_KEYS: '', LLM_BACKUP_API_BASE: '', LLM_BACKUP_API_KEY: '', LLM_MODEL_MAJOR: '' }) }, encoding: 'utf8', timeout: 20000
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /1\/1 rows rewritten/)
  const saved = await loadChangelog(join(root, 'data'))
  assert.equal(saved.entries[0].ai.title, clean.title)
  assert.equal(saved.entries[0].eli5.text, 'The internal setting changed.')
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

test('mapPhaseDiffRoom: the chunk asks share the row clock, so a giant diff loses hunks and not its row', () => {
  const clock = 90000
  const allowance = promptCharsForClock(clock)
  const chunks = 8
  const room = mapPhaseDiffRoom(clock, chunks)
  // The whole ladder is charged to one clock: the diff the eight asks carry,
  // plus each ask's fixed preamble, must fit what the row can prefill.
  assert.ok(room * chunks + PROMPT_PREAMBLE_CHARS * chunks <= allowance, 'the map asks fit the row clock')
  assert.ok(room >= LLM_MIN_DIFF_ROOM, 'and still send real hunks, never an empty diff')
  // More chunks means less per ask; fewer chunks lets each carry more.
  assert.ok(mapPhaseDiffRoom(clock, 2) > mapPhaseDiffRoom(clock, 8))
  // No clock known: unchanged, uncapped (the old behaviour for callers without one).
  assert.equal(mapPhaseDiffRoom(Infinity, 8), Infinity)
})

test('map-reduce: a diff too big for the row clock is chunked to fit instead of failing every cycle', async (t) => {
  const dir = await temp(t)
  // A diff big enough to force the chunked path (see the threshold override below),
  // built from file shapes the entry's own summary can ground against.
  const parts = ['diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n+export const ALPHA = 1\n const base = 0\n']
  let len = parts[0].length
  for (let i = 0; len < 400000; i++) {
    const p = `diff --git a/src/f${i}.ts b/src/f${i}.ts\nindex 1111111..2222222 100644\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,2 +1,3 @@\n+export const ALPHA = 1\n const base = ${i}\n`
    parts.push(p); len += p.length
  }
  const big = parts.join('')
  const clock = 20000
  const allowance = promptCharsForClock(clock)
  // The provider cannot answer a prompt the row's clock cannot prefill: model it
  // as a 5xx, which is exactly how the oversized chunk asks failed in production.
  const oversized = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    const prompt = String(body.messages?.at(-1)?.content || '')
    if (prompt.length > allowance) { oversized.push(prompt.length); return new Response('request too large to prefill in budget', { status: 504 }) }
    return response(prompt.startsWith('You summarize part') ? { evidence: 'a.ts has it.', summary: 'Adds ALPHA in the source files.' } : clean)
  })
  const e = row('1')
  const n = await enrichWithLlm([e], async () => big, dir, env({
    CHANGELOG_LLM_MAPREDUCE_THRESHOLD: '50000',
    CHANGELOG_LLM_ROW_BUDGET_MS: String(clock)
  }), { retryErrors: true })
  assert.equal(oversized.length, 0, 'no chunk ask exceeds what the row clock can prefill')
  assert.equal(n, 1, 'the oversized row is still summarized')
  assert.ok(e.ai?.title && e.ai?.summary, 'and it ships a real summary rather than staying missing')
})

// A diff big enough to force the chunked path, built from file shapes the
// entry's own summary can ground against.
const chunkablePatch = () => {
  const parts = ['diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n+export const ALPHA = 1\n const base = 0\n']
  let len = parts[0].length
  for (let i = 0; len < 400000; i++) {
    const p = `diff --git a/src/f${i}.ts b/src/f${i}.ts\nindex 1111111..2222222 100644\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,2 +1,3 @@\n+export const ALPHA = 1\n const base = ${i}\n`
    parts.push(p); len += p.length
  }
  return parts.join('')
}

test('map-reduce: when the chunk asks fail, the row is still answered from the digest alone', async (t) => {
  const dir = await temp(t)
  let mapCalls = 0, fuseCalls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    const prompt = String(body.messages?.at(-1)?.content || '')
    if (prompt.startsWith('You summarize part')) { mapCalls++; return new Response('overloaded', { status: 503 }) }
    fuseCalls++
    return response(clean)
  })
  const e = row('1')
  const n = await enrichWithLlm([e], async () => chunkablePatch(), dir, env({ CHANGELOG_LLM_MAPREDUCE_THRESHOLD: '50000' }), { retryErrors: true })
  assert.ok(mapCalls >= 1, 'the full chunk asks were tried first')
  assert.equal(fuseCalls, 1, 'and the digest-only rung answered on the first try')
  assert.equal(n, 1, 'the row is written rather than left missing')
  assert.ok(e.ai?.title && e.ai?.summary, 'and it ships a real summary')
})

test('map-reduce: a row whose rungs all fail on the routed model is retried lean on the strong model', async (t) => {
  const dir = await temp(t)
  const models = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    models.push(body.model)
    if (String(body.messages?.at(-1)?.content || '').startsWith('You summarize part')) return new Response('overloaded', { status: 503 })
    return body.model === 'strong-model' ? response(clean) : new Response('overloaded', { status: 503 })
  })
  const e = row('1')
  const n = await enrichWithLlm([e], async () => chunkablePatch(), dir, env({
    CHANGELOG_LLM_MAPREDUCE_THRESHOLD: '50000', LLM_MODEL: 'weak-model', LLM_MODEL_MAJOR: 'strong-model'
  }), { retryErrors: true })
  assert.equal(n, 1, 'the row is written by the strong model')
  assert.ok(models.includes('strong-model'), 'the strong model answered the lean ask')
  assert.ok(e.ai?.title, 'and the entry carries the summary')
})

test('quality: an admitted row with no generated text discloses that the summary is still coming', () => {
  const bare = qualityOf(row('1'))
  assert.equal(bare.generation.status, 'missing')
  assert.match(bare.notes.join(' '), /still being generated/, 'the pending status is stated, not left implicit')
  assert.doesNotMatch(qualityOf(row('2', { enrichment: {} })).notes.join(' '), /still being generated/, 'a row outside admission claims nothing')
  assert.doesNotMatch(qualityOf(row('3', { ai: clean })).notes.join(' '), /still being generated/, 'and a generated row does not warn')
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
  // The gateway's own vocabulary. None of these words is in the transport
  // pattern, and none of them is the model's answer: a provider outage must
  // never look like a content failure (permanent cooldown, no failover).
  for (const msg of ['Service temporarily unavailable', 'Provider overloaded. Please try again shortly.', 'Service temporarily at capacity']) {
    const frameErr = new Error(`LLM gateway error in the response body (server_error): ${msg}`)
    assert.equal(isGatewayError(frameErr), true, msg)
    assert.equal(isTransientError(frameErr), true, msg)
    assert.equal(callUnanswered(frameErr), true, msg)
    assert.equal(isRouteFailure(frameErr), true, msg)
  }
  // The same thing as a plain JSON body.
  assert.throws(() => extractResponseText('{"error":{"message":"The request timed out. Please try again.","code":"timeout"}}'), /gateway error in the response body/)
  // A normal body is untouched.
  assert.equal(extractResponseText(JSON.stringify({ choices: [{ message: { content: JSON.stringify(clean) } }] })), JSON.stringify(clean))
})

test('key ring: LLM_API_KEYS rotates one key per call and the backup route keeps its own', async (t) => {
  assert.deepEqual(llmKeysOf({ LLM_API_KEYS: ' a , b ,, c ' }), ['a', 'b', 'c'])
  assert.deepEqual(llmKeysOf({ LLM_API_KEY: 'solo' }), ['solo'])
  assert.deepEqual(llmKeysOf({}), [])
  assert.equal(llmConfigured({ CHANGELOG_LLM: '1', LLM_API_KEYS: 'a,b' }), true, 'a ring alone configures the provider')

  const ring = { CHANGELOG_LLM: '1', LLM_API_KEYS: 'k1,k2', LLM_API_KEY: 'k1' }
  assert.equal(nextLlmKey(ring), 'k1')
  assert.equal(nextLlmKey(ring), 'k2')
  assert.equal(nextLlmKey(ring), 'k1', 'the ring wraps')
  assert.equal(nextLlmKey({ LLM_API_KEY: 'solo' }), 'solo', 'the single-key form is unchanged')

  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push(init.headers.authorization)
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      `data: {"choices":[{"delta":{"content":${JSON.stringify(JSON.stringify(clean))}}}]}`,
      'data: [DONE]'
    ].join('\n\n')
    return new Response(frames)
  })
  const wire = { ...ring, LLM_API_BASE: 'https://ring.test/v1', CHANGELOG_LLM_RPM: '-1', LLM_DEADLINE_AT: String(Date.now() + 30000) }
  assert.equal((await callLlm('writer', wire, 1, x => x)).title, 'Alpha gate added')
  assert.equal((await callLlm('writer', wire, 1, x => x)).title, 'Alpha gate added')
  assert.deepEqual(seen, ['Bearer k1', 'Bearer k2'], 'calls alternate keys under one RPM window')

  const backup = backupEnvOf({ ...ring, LLM_BACKUP_API_BASE: 'https://backup.test/v1', LLM_BACKUP_API_KEY: 'bk', LLM_BACKUP_MODEL: 'backup-model' })
  assert.deepEqual(llmKeysOf(backup), ['bk'], 'the failover route carries only its own key')
  assert.equal(backup.LLM_API_KEYS, '', 'the primary ring does not leak into the backup route')
})

test('the quiet-minute warmup is a process cost, not a row cost: the bounded path refuses a wait that outlives the row clock', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(clean))
  // The lazy path at the first call charges the 60s quiet window against the
  // row's own share. With a 400ms row clock the wait cannot fit, so the call is
  // refused before anything is sent -- the exact failure that killed named rows
  // 9s into a dispatched regeneration. Paid passes warm with
  // warmLlmRpmWindow() before arming any budget, which is the fix; this pins
  // the failure mode so the two paths cannot be re-merged silently.
  const e = env({ CHANGELOG_LLM_RPM_WARMUP: '1', CHANGELOG_LLM_ROW_BUDGET_MS: '400', LLM_DEADLINE_AT: String(Date.now() + 120000) })
  await assert.rejects(callLlm('writer', e, 1, x => x), /entry time budget exceeded/)
  assert.equal(callUnanswered(new Error('LLM entry time budget exceeded')), true, 'and stays retryable, never parked')
})

test('cache identity is unchanged by the budget work: the same row still hashes the same key', () => {
  // A guard rail, not a hope: nothing in this change may move stored identities.
  const e = row('3')
  const key = cacheKey(e.sha, patch, '', 0)
  assert.equal(key, `${e.sha}:v${PROMPT_V}:${key.split(':')[2]}`)
})

// ---------------------------------------------------------------------------
// The daily roll-up's own provider: a dedicated base, key and plan, with
// nothing else routed through it.

test('day roll-up route: enabled only by base+key, carrying its own plan and no primary credential', () => {
  assert.equal(rollupLlmEnv({}), null, 'unconfigured, the roll-up stays on the primary route')
  assert.equal(rollupLlmEnv({ CHANGELOG_ROLLUP_LLM_API_BASE: 'https://logfare.ai/v1' }), null, 'a base without a key does not enable it')
  assert.equal(rollupLlmEnv({ CHANGELOG_ROLLUP_LLM_API_KEY: 'lfu_only' }), null, 'a key without a base does not enable it')

  const stage = rollupLlmEnv({
    ...env({ LLM_API_KEYS: 'ring1,ring2', LLM_BACKUP_API_BASE: 'https://backup.test/v1', LLM_BACKUP_API_KEY: 'bk', LLM_BACKUP_MODEL: 'gemini-3.6-flash' }),
    CHANGELOG_ROLLUP_LLM_API_BASE: 'https://logfare.ai/v1',
    CHANGELOG_ROLLUP_LLM_API_KEY: 'lfu_key',
    CHANGELOG_ROLLUP_LLM_MODEL: 'deepseek-v4.1-flash'
  })
  assert.equal(stage.LLM_API_BASE, 'https://logfare.ai/v1')
  assert.equal(stage.LLM_API_KEY, 'lfu_key')
  assert.equal(stage.LLM_API_KEYS, '', 'the primary key ring stays on the primary provider')
  assert.equal(stage.LLM_MODEL, 'deepseek-v4.1-flash')
  assert.equal(stage.LLM_ROUTE, 'rollup', 'the request ledger can tell which route served a digest')
  assert.equal(stage.CHANGELOG_LLM_BACKUP, '0', 'a dedicated route does not fail over to a different provider')
  // The stated plan, as the enforced defaults.
  assert.equal(stage.LLM_RPM, 20)
  assert.equal(stage.LLM_MAX_PER_HOUR, 500)
  assert.equal(stage.LLM_MAX_PER_DAY, 2500)
  assert.equal(stage.LLM_MAX_CONCURRENT, 3)
  assert.equal(llmRpm(stage), 20, 'bounded by its own rate, not by the 60 RPM contract')
  assert.equal(ROLLUP_LLM_STAGE.rpm, 20)
  assert.equal(ROLLUP_LLM_STAGE.concurrency, 3)

  // Every plan number is overridable per value, and nonsense falls back.
  const tuned = rollupLlmEnv({
    CHANGELOG_ROLLUP_LLM_API_BASE: 'b', CHANGELOG_ROLLUP_LLM_API_KEY: 'k',
    CHANGELOG_ROLLUP_LLM_RPM: '5', CHANGELOG_ROLLUP_LLM_MAX_CONCURRENT: '1', CHANGELOG_ROLLUP_LLM_MAX_PER_DAY: 'nope'
  })
  assert.equal(tuned.LLM_RPM, 5)
  assert.equal(tuned.LLM_MAX_CONCURRENT, 1)
  assert.equal(tuned.LLM_MAX_PER_DAY, 2500)
  // The generic form works for any stage prefix.
  assert.equal(stageLlmEnv({ FOO_API_BASE: 'x', FOO_API_KEY: 'y' }, { prefix: 'FOO', rpm: 7 }).LLM_RPM, 7)
  assert.equal(stageLlmEnv({ FOO_API_BASE: 'x' }, { prefix: 'FOO' }), null)
  assert.equal(stageLlmEnv({ FOO_API_BASE: 'x', FOO_API_KEY: 'y' }, {}), null, 'a stage without a prefix is nothing')
})

test('day roll-up route: the provider banner names it, without any key', () => {
  const banner = llmProviderBanner({
    CHANGELOG_LLM: '1', LLM_API_KEY: 'sk-secret', LLM_API_BASE: 'https://vyceai.com/v1', LLM_MODEL: 'deepseek-v4.1',
    CHANGELOG_ROLLUP_LLM_API_BASE: 'https://logfare.ai/v1', CHANGELOG_ROLLUP_LLM_API_KEY: 'lfu-secret', CHANGELOG_ROLLUP_LLM_MODEL: 'deepseek-v4.1-flash'
  })
  assert.match(banner, /day roll-up deepseek-v4\.1-flash @ https:\/\/logfare\.ai\/v1/)
  assert.doesNotMatch(banner, /lfu-secret|sk-secret/)
  assert.equal(llmProviderBanner({ CHANGELOG_LLM: '1', LLM_API_KEY: 'sk' }).includes('day roll-up'), false, 'no clause when no stage provider is configured')
})

test('provider rate limit: a concurrency plan limit bounds how many requests are open at once', async t => {
  let active = 0, peak = 0
  t.mock.method(globalThis, 'fetch', async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(r => setTimeout(r, 15))
    active--
    return response(clean)
  })
  const e = env({ LLM_API_BASE: 'https://conc.test/v1', LLM_MAX_CONCURRENT: '2' })
  await Promise.all(Array.from({ length: 5 }, (_, i) => callLlm(`caller ${i}`, e, 1, x => x)))
  assert.equal(peak, 2, 'never more than the plan allows, however many callers ask at once')
  assert.equal(active, 0, 'every slot is released, including on the paths that fail')
})

test('a gateway that rejects structured outputs gets one retry without strict JSON mode', async t => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    seen.push(Boolean(body.response_format))
    if (body.response_format) {
      // The measured phrasing from an OpenAI-compatible gateway that bridges
      // to a model without structured outputs. It never says "response_format",
      // so matching only that word cost the call (and then both repairs).
      return new Response('{"error":{"message":"model: some/ling-3.0-flash-vl does not support feature: structured-outputs"}}', { status: 400 })
    }
    return response(clean)
  })
  const e = env({ LLM_API_BASE: 'https://novita.test/v1' })
  assert.equal((await callLlm('writer', e, 1, x => x)).title, 'Alpha gate added')
  assert.deepEqual(seen, [true, false], 'one probe, then the answer without the field')
})

test('provider probes are per route: a gateway that rejects stream keeps its own verdict', async t => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    seen.push({ url: String(url), stream: body.stream, strict: !!body.response_format })
    if (String(url).startsWith('https://picky.test')) return new Response('{"error":{"message":"streaming is not supported here"}}', { status: 400 })
    return response(clean)
  })
  const picky = env({ LLM_API_BASE: 'https://picky.test/v1' })
  await assert.rejects(callLlm('stage', picky, 1, x => x), /HTTP 400/)
  assert.equal(seen.length, 2, 'one probe, one refusal, then it stops asking')
  assert.equal(seen[0].stream, true)
  assert.equal(seen[1].stream, undefined, 'this route stopped asking for streaming')

  await callLlm('primary', env({ LLM_API_BASE: 'https://main.test/v1' }), 1, x => x)
  assert.equal(seen.at(-1).stream, true, 'the other provider was never consulted about this')
  assert.equal(seen.at(-1).strict, true, 'and strict JSON mode still stands where it works')
})

// ---------------------------------------------------------------------------
// Shrink-on-retry: a row that twice burned its clock on the full ask leads
// with the lean one instead of hanging the same way every cycle.
// ---------------------------------------------------------------------------

test('leadWithLean: twice budget-exceeded retries the smaller question; anything else does not', () => {
  const env_ = { LLM_API_BASE: 'https://example.invalid/v1', LLM_MODEL: 'm' }
  const stub = (error, attempts, extra = {}) => ({ error, attempts, at: new Date().toISOString(), ...extra })
  assert.equal(leadWithLean(null, env_), false)
  assert.equal(leadWithLean({}, env_), false)
  assert.equal(leadWithLean(stub('LLM entry time budget exceeded', 1), env_), false, 'one fluke still gets its full retry')
  assert.equal(leadWithLean(stub('LLM entry time budget exceeded', 2), env_), true)
  assert.equal(leadWithLean(stub('The operation was aborted due to timeout', 4), env_), true)
  assert.equal(leadWithLean(stub('LLM HTTP 504', 5), env_), false, 'a gateway failure is not a size problem')
  assert.equal(leadWithLean(stub('LLM cycle deadline exceeded', 3), env_), false, 'a pass-level deadline is not the ask failing')
  assert.equal(leadWithLean(stub('LLM entry request budget exceeded', 2), env_), false, 'an exhausted call budget already tried every rung')
  assert.equal(leadWithLean(stub('LLM entry time budget exceeded', 2, { deterministic: true }), env_), false, 'a refusal is not a size problem')
  assert.equal(leadWithLean(stub('LLM entry time budget exceeded', 2, { routeIdentity: 'other-route' }), env_), false, 'a route change restarts with the full ask')
})

test('summarizeEntry with leadLean asks the lean prompt first', async t => {
  const dir = await temp(t)
  const seen = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(String(init.body)).messages.at(-1).content)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(clean) } }] }) }
  }
  t.after(() => { globalThis.fetch = orig })
  const wide = 'Complete Source of Modified Files'
  const ctx = { fullFiles: [{ path: 'a.ts', lines: 3, content: 'export const ALPHA = 1' }] }
  const mk = (sha) => row(sha, { files: { modified: ['a.ts'], total: 1, meaningful: 1 } })
  await summarizeEntry({ entry: mk('a1'), patch, context: ctx, env: env({}), dataDir: dir })
  assert.ok(seen[0].includes(wide), 'without leadLean the full ask goes first')
  seen.length = 0
  await summarizeEntry({ entry: mk('a2'), patch, context: ctx, env: env({}), dataDir: dir, leadLean: true })
  assert.ok(!seen[0].includes(wide), 'with leadLean the lean ask goes first')
  assert.match(seen[0], /diff --git/, 'and it still carries the diff')
})

test('explainEntry with leadLean asks the lean prompt first', async t => {
  const dir = await temp(t)
  const seen = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(String(init.body)).messages.at(-1).content)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ eli5: 'The gate reads a flag before it acts.' }) } }] }) }
  }
  t.after(() => { globalThis.fetch = orig })
  const wide = 'Complete source of the smaller touched files'
  const ctx = { fullFiles: [{ path: 'a.ts', lines: 3, content: 'export const ALPHA = 1' }] }
  const mk = (sha) => row(sha, { ai: { ...clean, model: 'test', v: PROMPT_V } })
  await explainEntry({ entry: mk('b1'), patch, context: ctx, env: env({}), dataDir: dir })
  assert.ok(seen[0].includes(wide), 'without leadLean the full ask goes first')
  seen.length = 0
  const { text } = await explainEntry({ entry: mk('b2'), patch, context: ctx, env: env({}), dataDir: dir, leadLean: true })
  assert.ok(!seen[0].includes(wide), 'with leadLean the lean ask goes first')
  assert.match(seen[0], /diff --git/, 'and it still carries the diff')
  assert.equal(text, 'The gate reads a flag before it acts.')
})

test('the plain-English pass leads with the lean ask after two budget-exceeded failures', async t => {
  const dir = await temp(t)
  const testPatch = 'diff --git a/handler.test.ts b/handler.test.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/handler.test.ts\n@@ -0,0 +1,3 @@\n+test(\'caps the handler\', () => {\n+  expect(1).toBe(1)\n+})\n'
  const prompts = []
  let hang = true
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    prompts.push(JSON.parse(String(init.body)).messages.at(-1).content)
    if (hang) {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response({ eli5: 'A test now caps the handler.' })), 10000)
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })) })
      })
    }
    return response({ eli5: 'A test now caps the handler.' })
  })
  const e = row('c1', { ai: { ...clean, model: 'test', v: PROMPT_V } })
  const runEnv = env({ CHANGELOG_ELI5_ROW_BUDGET_MS: '400', CHANGELOG_LLM_TRANSIENT_RETRY_MS: '1' })
  const opts = { retryErrors: true, getPatch: async () => testPatch }
  // Two cycles burn the 400ms clock on the hanging full ask.
  assert.equal(await enrichEli5([e], dir, runEnv, opts), 0)
  assert.equal(await enrichEli5([e], dir, runEnv, opts), 0)
  // The third cycle leads with the lean ask, which answers at once.
  hang = false
  prompts.length = 0
  assert.equal(await enrichEli5([e], dir, runEnv, opts), 1)
  assert.equal(prompts.length, 1, 'the lean ask answers on the first call')
  assert.ok(!prompts[0].includes('Tests this commit changed'), 'the retry leads with the lean ask')
  assert.match(prompts[0], /diff --git/, 'and it still carries the diff')
  assert.equal(e.eli5.text, 'A test now caps the handler.')
})

test('the plain-English pass compacts deleted files on large diffs, like the summary pass', async t => {
  const dir = await temp(t)
  const big = 'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex abc..000 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1,20000 +0,0 @@\n' + '-old line\n'.repeat(20000)
  const prompts = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    prompts.push(JSON.parse(String(init.body)).messages.at(-1).content)
    return response({ eli5: 'Old code was removed.' })
  })
  const e = row('d1', { ai: { ...clean, model: 'test', v: PROMPT_V } })
  await enrichEli5([e], dir, env({ CHANGELOG_LLM_MAPREDUCE_THRESHOLD: '1000' }), { retryErrors: true, getPatch: async () => big })
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes('removed lines omitted'), 'deleted bodies are compacted before the prompt is built')
  assert.ok(!prompts[0].includes('-old line\n-old line'), 'the 20k removed lines are not sent')
  assert.equal(e.eli5.text, 'Old code was removed.')
  // And an ordinary row keeps its exact prompt: the gate is size-only.
  prompts.length = 0
  const e2 = row('d2', { ai: { ...clean, model: 'test', v: PROMPT_V } })
  await enrichEli5([e2], dir, env({ CHANGELOG_LLM_MAPREDUCE_THRESHOLD: '1000' }), { retryErrors: true, getPatch: async () => patch })
  assert.match(prompts[0], /\+export const ALPHA = 1/, 'a small diff is sent uncompacted')
})
