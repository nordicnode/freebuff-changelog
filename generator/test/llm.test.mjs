// generator/test/llm.test.mjs — tests for the LLM enrichment module
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLlmJson, buildPrompt, enrichWithLlm, llmConfigured } from '../lib/llm.mjs'

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

test('buildPrompt: includes diff, date, and model changes', () => {
  const entry = {
    date: '2026-09-13T10:00:00Z',
    areas: ['CLI', 'Model Catalog'],
    summary: 'Model catalog: Muse Spark 1.3 added.',
    modelChanges: { added: ['Muse Spark 1.3'], removed: [] }
  }
  const prompt = buildPrompt(entry, 'diff --git a/x b/x\n+new line')
  assert.match(prompt, /Muse Spark 1\.3/)
  assert.match(prompt, /CLI, Model Catalog/)
  assert.match(prompt, /diff --git a\/x b\/x/)
})
