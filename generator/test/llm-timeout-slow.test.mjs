import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrichEli5, PROMPT_V } from '../lib/llm.mjs'

// Opt-in: exercises real fetch and AbortSignal timers beyond the old 60s limit.
// RUN_SLOW_LLM_TEST=1 node --test generator/test/llm-timeout-slow.test.mjs
test('ELI5 accepts a response delayed beyond 60 seconds', {
  skip: process.env.RUN_SLOW_LLM_TEST !== '1', timeout: 90000
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-slow-response-'))
  let timer
  let requests = 0
  let requestBody
  const server = createServer(async (req, res) => {
    requests++
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requestBody = JSON.parse(Buffer.concat(chunks).toString())
    timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        eli5: 'The assistant supports another model.'
      }) } }] }))
    }, 65000)
  })
  t.after(async () => {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const entry = {
    sha: 'a'.repeat(40), kind: 'sync', date: '2026-09-17T00:00:00Z',
    day: '2026-09-17', areas: ['CLI'], category: 'CLI', significance: 'minor',
    ai: { model: 'test', v: PROMPT_V, title: 'Additional model supported', summary: 'The assistant supports another model.' }
  }
  const start = performance.now()
  const count = await enrichEli5([entry], dir, {
    CHANGELOG_LLM: '1', LLM_API_KEY: 'test', LLM_MODEL: 'slow-mock',
    LLM_API_BASE: `http://127.0.0.1:${server.address().port}/v1`, LLM_TIMEOUT_MS: '300000'
  })
  assert.equal(count, 1)
  assert.equal(requests, 1, 'succeeds without retrying')
  assert.equal(requestBody.model, 'slow-mock')
  assert.equal(entry.eli5.text, 'The assistant supports another model.')
  assert.ok(performance.now() - start >= 65000)
})
