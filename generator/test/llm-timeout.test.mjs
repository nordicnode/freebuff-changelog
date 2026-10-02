import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrichWithLlm, enrichEli5, PROMPT_V } from '../lib/llm.mjs'

for (const pass of ['summary', 'eli5']) {
  test(`${pass}: configurable timeout reaches the request signal; invalid values retain default`, async (t) => {
    const durations = []
    const controller = new AbortController()
    t.mock.method(AbortSignal, 'timeout', ms => {
      durations.push(ms)
      return controller.signal
    })
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.signal, controller.signal)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(
        pass === 'eli5' ? { eli5: 'The assistant supports another model.' }
          : { title: 'Additional model supported', summary: 'The assistant supports another model so users can pick it.', significance: 'minor' }
      ) } }] }))
    })
    for (const value of [undefined, '300000', '0', '-1', 'nope', 'Infinity', '1.5', '2147483648']) {
      const dir = await mkdtemp(join(tmpdir(), 'fbweb-timeout-'))
      try {
        const entry = {
          sha: 'a'.repeat(40), kind: 'sync', date: '2026-09-17T00:00:00Z',
          day: '2026-09-17', areas: ['CLI'], category: 'CLI', significance: 'minor',
          summary: 'The assistant supports another model so users can pick it.'
        }
        // The verifier pass is timed by the same clock but has its own tests
        // (v10); here the single-call timeout plumbing is the subject. The row
        // budgets are set well above every configured timeout on purpose: the
        // signal is `min(configured, row share)` and this test is about the
        // configured half of that. The row-share half has its own test below.
        const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'test', LLM_API_BASE: 'https://example.invalid/v1', LLM_TIMEOUT_MS: value, CHANGELOG_LLM_VERIFY: '0', CHANGELOG_LLM_ROW_BUDGET_MS: '600000', CHANGELOG_ELI5_ROW_BUDGET_MS: '600000' }
        if (pass === 'eli5') {
          entry.ai = { model: 'test', v: PROMPT_V, title: 'Additional model supported', summary: entry.summary }
          assert.equal(await enrichEli5([entry], dir, env), 1)
        } else {
          assert.equal(await enrichWithLlm([entry], async () => 'diff --git a/x b/x\n+new\n', dir, env), 1)
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    assert.deepEqual(durations, [60000, 300000, 60000, 60000, 60000, 60000, 60000, 60000])
  })
}

// The other half of the same signal: a configured 300s timeout must never be
// handed a row that owns 20s, or the call aborts at the row's boundary while
// the provider was still working -- the shape that left queued rows unasked.
test('a row budget bounds the request signal below the configured timeout', async (t) => {
  const durations = []
  t.mock.method(AbortSignal, 'timeout', ms => { durations.push(ms); return new AbortController().signal })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Additional model supported', summary: 'The assistant supports another model so users can pick it.', significance: 'minor' }) } }] })))
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-timeout-cap-'))
  try {
    const entry = { sha: 'b'.repeat(40), kind: 'sync', date: '2026-09-17T00:00:00Z', day: '2026-09-17', areas: ['CLI'], category: 'CLI', significance: 'minor', summary: 'The assistant supports another model so users can pick it.' }
    const env = { CHANGELOG_LLM_NO_BACKFILL: '0', CHANGELOG_LLM: '1', LLM_API_KEY: 'test', LLM_API_BASE: 'https://example.invalid/v1', LLM_TIMEOUT_MS: '300000', CHANGELOG_LLM_VERIFY: '0', CHANGELOG_LLM_ROW_BUDGET_MS: '20000' }
    assert.equal(await enrichWithLlm([entry], async () => 'diff --git a/x b/x\n+new\n', dir, env), 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  assert.equal(durations.length, 1)
  assert.ok(durations[0] <= 20000 && durations[0] > 19000, `the row's share reaches the signal, got ${durations[0]}`)
})

