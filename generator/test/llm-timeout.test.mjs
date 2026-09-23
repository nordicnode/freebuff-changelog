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
          : { title: 'Additional model supported', summary: 'The assistant supports another model.', significance: 'minor' }
      ) } }] }))
    })
    for (const value of [undefined, '300000', '0', '-1', 'nope', 'Infinity', '1.5', '2147483648']) {
      const dir = await mkdtemp(join(tmpdir(), 'fbweb-timeout-'))
      try {
        const entry = {
          sha: 'a'.repeat(40), kind: 'sync', date: '2026-09-17T00:00:00Z',
          day: '2026-09-17', areas: ['CLI'], category: 'CLI', significance: 'minor',
          summary: 'The assistant supports another model.'
        }
        // The verifier pass is timed by the same clock but has its own tests
        // (v10); here the single-call timeout plumbing is the subject.
        const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'test', LLM_API_BASE: 'https://example.invalid/v1', LLM_TIMEOUT_MS: value, CHANGELOG_LLM_VERIFY: '0' }
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
