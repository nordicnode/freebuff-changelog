// generator/test/rollup.test.mjs - tests for the daily roll-up pass
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROLLUP_SETTLE_GRACE_MS, ROLLUP_V, buildRollupPrompt, dayRollupReady, generateRollup,
  loadRollups, rollupBacklog, rollupFingerprint, rollupInput, saveRollup, validateRollupOut
} from '../lib/rollup.mjs'
import { shortHash } from '../lib/util.mjs'

const DAY = '2026-10-01'

function entry (over = {}) {
  return {
    kind: 'sync',
    sha: 'a'.repeat(40),
    day: DAY,
    date: `${DAY}T10:00:00Z`,
    noise: false,
    title: 'Mechanical title',
    ai: {
      title: 'Mission mode no longer buys a session hour when automatic starts are off',
      summary: 'Automatic session starts now respect the setting instead of purchasing another hour.',
      significance: 'notable',
      userVisible: true
    },
    eli5: { text: 'Mission mode now stops buying extra session time when automatic starts are turned off.' },
    ...over
  }
}

const ENV = { CHANGELOG_LLM: '1', LLM_API_KEY: 'offline-test', LLM_API_BASE: 'https://example.invalid/v1', LLM_MODEL: 'writer-model', CHANGELOG_LLM_RPM: '-1', CHANGELOG_LLM_VERIFY: '0' }

function answerWith (reply) {
  const prompts = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const prompt = JSON.parse(String(init.body)).messages.at(-1).content
    prompts.push(prompt)
    const content = typeof reply === 'function' ? reply(prompt) : reply
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }
  return { prompts, restore: () => { globalThis.fetch = orig } }
}

async function withDir (fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rollup-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('rollupInput carries the verified text, the plain-English line, and the flags that frame a change', () => {
  const input = rollupInput(DAY, [entry(), entry({
    sha: 'b'.repeat(40),
    ai: { title: 'Sidebar fix', summary: 'The project picker no longer opens behind the sidebar.' },
    eli5: undefined
  })])
  assert.match(input, /Day: 2026-10-01 \(UTC\)/)
  assert.match(input, /\[notable, user-visible\] Mission mode no longer buys a session hour/)
  assert.match(input, /Automatic session starts now respect the setting/)
  assert.match(input, /Plain English: Mission mode now stops buying extra session time/)
  assert.match(input, /- Sidebar fix/)
  assert.doesNotMatch(input, /Mechanical title/, 'the stored ai title is what the digest restates')
})

test('rollupInput skips rows that have no summary yet, so a half-enriched day cannot be digested', () => {
  const input = rollupInput(DAY, [entry(), { ...entry({ sha: 'c'.repeat(40) }), ai: undefined }])
  assert.equal(input.includes('c'.repeat(40)), false)
  assert.match(input, /Mission mode/)
})

test('the prompt names the voice rules and embeds the day, and the fingerprint tracks the input', () => {
  const rows = [entry()]
  const input = rollupInput(DAY, rows)
  const prompt = buildRollupPrompt(DAY, input)
  assert.match(prompt, /past-tense verb/)
  assert.match(prompt, /no markdown, no backticks, no file paths/)
  assert.match(prompt, /Never use em dashes/)
  assert.match(prompt, /only facts, names, and numbers present in the material/)
  assert.match(prompt, /Mission mode no longer buys/)
  assert.equal(rollupFingerprint(DAY, rows), shortHash(input))
  const rewritten = [entry({ ai: { ...entry().ai, summary: 'A different summary.' } })]
  assert.notEqual(rollupFingerprint(DAY, rewritten), rollupFingerprint(DAY, rows), 'a rewritten summary invalidates the digest')
})

test('validateRollupOut cleans bullets and rejects prose, empty answers, and machine text', () => {
  assert.deepEqual(validateRollupOut({ bullets: ['- Added a thing', '2. Fixed another thing', 'Updated a third'] }), {
    bullets: ['Added a thing.', 'Fixed another thing.', 'Updated a third.']
  })
  assert.throws(() => validateRollupOut({ bullets: [] }), /no usable bullets/)
  assert.throws(() => validateRollupOut({ bullets: ['Fixed src/lib/thing.mjs so it works.'] }), /no usable bullets/)
  assert.throws(() => validateRollupOut({ bullets: ['Reverted commit abc1234def.'] }), /no usable bullets/)
  assert.throws(() => validateRollupOut('a prose answer'), /bullets array/)
  // A markdown-flavoured bullet is dropped; the usable ones survive.
  assert.deepEqual(validateRollupOut({ bullets: ['`code` names', 'Simplified the model picker tooltips'] }).bullets, ['Simplified the model picker tooltips.'])
})

test('dayRollupReady waits for the enrichment drain, then goes ahead without parked rows after the grace window', () => {
  const full = [entry()]
  const partial = [entry(), { ...entry({ sha: 'd'.repeat(40) }), ai: undefined }]
  const justAfterMidnight = Date.parse('2026-10-02T02:00:00Z')
  assert.equal(dayRollupReady(DAY, full, { now: justAfterMidnight }), true)
  assert.equal(dayRollupReady(DAY, partial, { now: justAfterMidnight }), false, 'rows still queued hold the digest')
  assert.equal(dayRollupReady(DAY, partial, { now: justAfterMidnight + ROLLUP_SETTLE_GRACE_MS }), true, 'a parked row must not hold the page hostage forever')
  assert.equal(dayRollupReady(DAY, [{ ...entry(), ai: undefined }], { now: justAfterMidnight + ROLLUP_SETTLE_GRACE_MS }), false, 'nothing to digest')
})

test('rollupBacklog: settled days only, newest first, current digests skipped, and today left alone', () => {
  const today = entry({ sha: 'e'.repeat(40), day: '2026-10-03', date: '2026-10-03T10:00:00Z' })
  const noiseOnly = { ...entry({ sha: 'f'.repeat(40), day: '2026-10-02', date: '2026-10-02T10:00:00Z' }), noise: true, ai: undefined }
  const doc = { entries: [today, noiseOnly, entry()] }
  const now = Date.parse('2026-10-03T12:00:00Z')
  const pending = rollupBacklog(doc, { now })
  assert.deepEqual(pending.map(p => p.day), ['2026-10-01'], 'today is not settled and a churn-only day has nothing to digest')
  assert.equal(pending[0].source, rollupFingerprint(DAY, [entry()]))

  const current = { [DAY]: { v: ROLLUP_V, source: pending[0].source, bullets: ['Added a thing.'] } }
  assert.equal(rollupBacklog(doc, { now, rollups: current }).length, 0, 'a current digest is not rewritten')
  assert.equal(rollupBacklog(doc, { now, rollups: current, force: true }).length, 1, 'force rewrites it anyway')
  assert.equal(rollupBacklog(doc, { now, rollups: { [DAY]: { ...current[DAY], v: ROLLUP_V - 1 } } }).length, 1, 'an older prompt version re-queues')
  assert.equal(rollupBacklog(doc, { now, rollups: { [DAY]: { ...current[DAY], source: 'stale' } } }).length, 1, 'changed input re-queues')
  assert.equal(rollupBacklog(doc, { now, limit: 0 }).length, 0)
})

test('saveRollup/loadRollups round-trip a day and ignore strangers in the directory', () => withDir(async dir => {
  await saveRollup(dir, { day: DAY, v: ROLLUP_V, at: '2026-10-02T00:10:00Z', source: 'abc', model: 'm', bullets: ['Added a thing.'] })
  await writeFile(join(dir, 'rollups', 'README.txt'), 'not a digest')
  await writeFile(join(dir, 'rollups', 'broken.json'), '{')
  const loaded = await loadRollups(dir)
  assert.deepEqual(Object.keys(loaded), [DAY])
  assert.deepEqual(loaded[DAY].bullets, ['Added a thing.'])
  assert.deepEqual(await loadRollups(join(dir, 'missing')), {})
}))

test('generateRollup stores the model call as one versioned, fingerprinted file', () => withDir(async dir => {
  const rows = [entry({ sha: '1'.repeat(40) }), entry({ sha: '2'.repeat(40), ai: { title: 'Sidebar fix', summary: 'The project picker no longer opens behind the sidebar.', significance: 'minor' }, eli5: undefined })]
  const { prompts, restore } = answerWith(JSON.stringify({ bullets: ['Added a Mission mode setting that stops extra sessions from starting.', 'Fixed the project picker opening behind the sidebar.'] }))
  try {
    const rollup = await generateRollup(DAY, rows, { dataDir: dir, env: ENV })
    assert.equal(rollup.day, DAY)
    assert.equal(rollup.v, ROLLUP_V)
    assert.equal(rollup.source, rollupFingerprint(DAY, rows))
    assert.equal(rollup.model, 'writer-model')
    assert.deepEqual(rollup.bullets, [
      'Added a Mission mode setting that stops extra sessions from starting.',
      'Fixed the project picker opening behind the sidebar.'
    ])
    const stored = JSON.parse(await readFile(join(dir, 'rollups', `${DAY}.json`), 'utf8'))
    assert.deepEqual(stored.bullets, rollup.bullets)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /Mission mode no longer buys/)
    assert.match(prompts[0], /Sidebar fix/)
  } finally { restore() }
}))

test('generateRollup surfaces a bad answer instead of storing machine text', () => withDir(async dir => {
  const { restore } = answerWith('Here are the bullets: - Added a thing')
  try {
    await assert.rejects(generateRollup(DAY, [entry()], { dataDir: dir, env: ENV }))
    const stored = await loadRollups(dir)
    assert.deepEqual(stored, {}, 'nothing is stored when the model did not answer the ask')
  } finally { restore() }
}))
