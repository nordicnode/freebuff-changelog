// generator/test/rollup.test.mjs - tests for the daily roll-up pass
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROLLUP_SETTLE_GRACE_MS, ROLLUP_V, buildRollupDedupePrompt, buildRollupPrompt, dayRollupReady,
  dedupeBullets, digestibleMaterial, forwardRollupBacklog, generateRollup, loadRollups, nearDuplicate,
  rollupBacklog, rollupFingerprint, rollupInput, saveRollup, validateDedupeOut, validateRollupOut
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

test('the digest material excludes release bumps and test-only rows, and a bump-only day has nothing to digest', () => {
  const bump = entry({
    sha: 'f'.repeat(40),
    version: '1.2.3',
    freebuffVersion: '1.2.3',
    ai: { title: 'Freebuff CLI 1.2.3 release bump', summary: 'The manifest moved from 1.2.2 to 1.2.3 and carried three fixes.', significance: 'major' }
  })
  const testOnly = entry({ sha: 'e'.repeat(40), testOnly: true, ai: { title: 'Test coverage: a.ts', summary: 'Tests only, no shipped code.' } })
  const input = rollupInput(DAY, [entry(), bump, testOnly])
  assert.match(input, /Mission mode/)
  assert.doesNotMatch(input, /1\.2\.3/, 'a release label is not a feature')
  assert.doesNotMatch(input, /Test coverage/, 'test plumbing is not a feature')

  const now = Date.parse('2026-10-10T00:00:00Z')
  assert.equal(dayRollupReady(DAY, [bump, testOnly], { now }), false, 'a bump-only day has nothing a reader would digest')
  assert.deepEqual(rollupBacklog({ entries: [bump, testOnly] }, { now }), [])
})

test('the prompt names the voice rules and embeds the day, and the fingerprint tracks the input', () => {
  const rows = [entry()]
  const input = rollupInput(DAY, rows)
  const prompt = buildRollupPrompt(DAY, input)
  assert.match(prompt, /past-tense verb/)
  assert.match(prompt, /Cover the day/)
  assert.match(prompt, /never about the release that carried it/)
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
  // A restated change, punctuation included, ships once.
  assert.deepEqual(validateRollupOut({ bullets: ['Added a first-tab discount.', 'Added a first tab discount!'] }).bullets, ['Added a first-tab discount.'])
  // Code identifiers mean the bullet is construction work, not a feature.
  assert.throws(() => validateRollupOut({ bullets: ['Fixed freebucksTimeZoneHeaders to take an injected zone.'] }), /no usable bullets/)
  assert.throws(() => validateRollupOut({ bullets: ['Added ADS_IMPRESIA_FETCH_OUTCOMES handling.'] }), /no usable bullets/)
  assert.throws(() => validateRollupOut({ bullets: ['Scoped the write_todos retry guard.'] }), /no usable bullets/)
  // Product names in camel shape are prose, not identifiers.
  assert.deepEqual(validateRollupOut({ bullets: ['Fixed the iOS app picker on macOS.'] }).bullets, ['Fixed the iOS app picker on macOS.'])
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

test('forwardRollupBacklog never drains history: it starts at the newest stored digest', () => {
  const mk = (day, sha) => entry({ sha, day, date: `${day}T10:00:00Z` })
  const doc = { entries: [mk('2026-09-01', '1'.repeat(40)), mk('2026-09-02', '2'.repeat(40)), mk('2026-09-03', '3'.repeat(40)), mk('2026-10-01', '4'.repeat(40))] }
  const now = Date.parse('2026-10-03T00:00:00Z')
  assert.deepEqual(forwardRollupBacklog(doc, { now }).map(p => p.day), ['2026-10-01'], 'with nothing stored, the newest settled day starts the frontier')

  const rollups = { '2026-10-01': { v: ROLLUP_V, source: rollupFingerprint('2026-10-01', [entry({ sha: '4'.repeat(40), day: '2026-10-01', date: '2026-10-01T10:00:00Z' })]), bullets: ['Added a thing.'] } }
  assert.deepEqual(forwardRollupBacklog(doc, { now, rollups }), [], 'older days wait for an explicit backfill')

  const later = { entries: [...doc.entries, mk('2026-10-02', '5'.repeat(40))] }
  assert.deepEqual(forwardRollupBacklog(later, { now: Date.parse('2026-10-04T00:00:00Z'), rollups }).map(p => p.day), ['2026-10-02'], 'a newly settled day joins the frontier')
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

// ------------------------------------------------------------------------------------
// De-duplication. Duplicates arrive from both sides: the day's rows repeat
// themselves, and the model restates a change in two bullets.

test('nearDuplicate: restatements of one change are one change, and shapes that share words are not', () => {
  // Exact restatement, punctuation and hyphenation included.
  assert.equal(nearDuplicate('Added a first-tab discount.', 'Added a first tab discount!'), true)
  // The lead verb is boilerplate: same change, different mandated verb.
  assert.equal(nearDuplicate('Added a first-tab discount.', 'Fixed the first tab discount for checkout.'), true)
  // A restatement that adds a modifier: the shorter is contained in the longer.
  assert.equal(nearDuplicate('Fixed the project picker opening behind the sidebar.',
    'The project picker no longer opens behind the sidebar.'), true)
  // Word order and a light plural do not make a second change.
  assert.equal(nearDuplicate('Added timezone headers to the freebucks widget.',
    'Added the freebucks timezone header.'), true)

  // Numbers are load-bearing: different figures are different claims, however
  // few other words differ.
  assert.equal(nearDuplicate('Upgraded OpenTUI to 0.2.2.', 'Upgraded OpenTUI to 0.3.0.'), false)
  assert.equal(nearDuplicate('Raised the placement cap to 10000 cents.', 'Raised the placement cap to 5000 cents.'), false)
  assert.equal(nearDuplicate('Raised the placement cap to 10000 cents.', 'Raised the placement cap.'), true, 'only one side states a number: that is the vaguer restatement')

  // Two changes that share the sentence's shape are still two changes.
  assert.equal(nearDuplicate('Added dark mode to the settings page.', 'Added light mode to the settings page.'), false)
  assert.equal(nearDuplicate('Fixed crash on startup.', 'Fixed crash on exit.'), false)
  assert.equal(nearDuplicate('Bumped the model catalog to opus-4.8.', 'Bumped the model catalog to sonnet-5.'), false)
  // A one-word bullet is never swallowed by a longer one that mentions it.
  assert.equal(nearDuplicate('Added caching.', 'Added response caching to the API.'), false)
  // Nothing to compare is not a duplicate.
  assert.equal(nearDuplicate('', ''), false)
})

test('duplicate day rows are shown to the model once, and the change count follows', () => {
  // A cherry-picked copy: different sha, the same change reworded a word or two.
  const copy = {
    ...entry({ sha: 'b'.repeat(40) }),
    ai: { ...entry().ai, summary: 'Automatic session starts now respect that setting instead of purchasing another hour.' },
    eli5: { text: 'Mission mode now stops buying extra session time when automatic starts are turned on.' }
  }
  const other = entry({ sha: 'c'.repeat(40), ai: { title: 'Sidebar fix', summary: 'The project picker no longer opens behind the sidebar.' }, eli5: undefined })
  const rows = [entry(), copy, other]

  const material = digestibleMaterial(rows)
  assert.equal(material.length, 2, 'the copy collapses into the original')
  assert.equal(material[0].title, 'Mission mode no longer buys a session hour when automatic starts are off', 'the first of the pair is what is kept')

  const input = rollupInput(DAY, rows)
  assert.match(input, /Day: 2026-10-01 \(UTC\), 2 changes/, 'the material says how many changes there are')
  assert.equal(input.split('Plain English:').length - 1, 1, 'the duplicate row does not add a second plain-English line')
  assert.equal(rollupFingerprint(DAY, rows), rollupFingerprint(DAY, [entry(), other]), 'the fingerprint is taken over the deduplicated material')

  // Distinct changes on the same day all survive.
  const distinct = digestibleMaterial([entry(), other])
  assert.equal(distinct.length, 2)
  assert.match(rollupInput(DAY, [entry(), other]), /, 2 changes/)
})

test('two rows with the same title on the same day are one change, whatever their diffs say', () => {
  // A cherry-pick and a revert-of-a-revert: the summaries differ because the
  // diffs do, but the titles match because the change does.
  const original = entry({ sha: 'b'.repeat(40), ai: { title: 'Windows PTY spawns cmd.exe outside PowerShell', summary: 'createPty now picks powershell.exe or cmd.exe depending on the host shell.' }, eli5: undefined })
  const copy = entry({ sha: 'c'.repeat(40), ai: { title: 'Windows PTY spawns cmd.exe outside PowerShell', summary: 'Reverts the earlier revert so cmd.exe is the fallback when powershell is unavailable.' }, eli5: undefined })
  const unrelated = entry({ sha: 'd'.repeat(40), ai: { title: 'Upgrade OpenTUI to 0.2.2', summary: 'OpenTUI core and react move to 0.2.2.' }, eli5: undefined })
  const otherVersion = entry({ sha: 'e'.repeat(40), ai: { title: 'Upgrade OpenTUI to 0.3.0', summary: 'OpenTUI core and react move to 0.3.0.' }, eli5: undefined })

  const material = digestibleMaterial([original, copy, unrelated])
  assert.equal(material.length, 2, 'the same title collapses, the other change does not')
  assert.equal(material[0].summary.includes('createPty'), true, 'the first of the pair is what is kept')
  assert.equal(digestibleMaterial([unrelated, otherVersion]).length, 2, 'different versions of the same dependency are different changes')
})

test('the prompt asks for one bullet per change, and the answer is held to the change count', () => {
  const prompt = buildRollupPrompt(DAY, rollupInput(DAY, [entry()]))
  assert.match(prompt, /One bullet per change, and one change per bullet/)
  assert.match(prompt, /never write two bullets about the same change/)

  // More bullets than changes: the extra ones are the same changes in disguise.
  const bullets = ['Added one thing today.', 'Added two things today.', 'Added three things today.']
  assert.equal(validateRollupOut({ bullets }).bullets.length, 3, 'without a limit, only the de-duplication applies')
  assert.deepEqual(validateRollupOut({ bullets }, { limit: 2 }).bullets, bullets.slice(0, 2))
  assert.deepEqual(validateRollupOut({ bullets }, { limit: 1 }).bullets, [bullets[0]])
  // The limit is a ceiling, never a floor: a short answer is not padded.
  assert.deepEqual(validateRollupOut({ bullets: [bullets[0]] }, { limit: 12 }).bullets, [bullets[0]])
})

test('validateRollupOut keeps one bullet of a restated pair, whichever words the model chose', () => {
  assert.deepEqual(validateRollupOut({ bullets: [
    'Fixed the project picker opening behind the sidebar.',
    'The project picker no longer opens behind the sidebar.'
  ] }).bullets, ['Fixed the project picker opening behind the sidebar.'], 'the first of the pair wins')
  // A near-duplicate is dropped even when the exact-string rule would keep both.
  assert.deepEqual(validateRollupOut({ bullets: [
    'Added a first-tab discount.',
    'Fixed the first tab discount for checkout.'
  ] }).bullets, ['Added a first-tab discount.'])
  // ...and two genuinely different changes keep both bullets.
  assert.deepEqual(validateRollupOut({ bullets: [
    'Added dark mode to the settings page.',
    'Added light mode to the settings page.'
  ] }).bullets, [
    'Added dark mode to the settings page.',
    'Added light mode to the settings page.'
  ])
})

test('a day with no digestible change is refused instead of asking the model for one', () => withDir(async dir => {
  const bump = entry({ sha: 'f'.repeat(40), version: '1.2.3', freebuffVersion: '1.2.3', ai: { title: 'Freebuff CLI 1.2.3 release bump', summary: 'The manifest moved to 1.2.3.', significance: 'major' } })
  await assert.rejects(generateRollup(DAY, [bump], { dataDir: dir, env: ENV }), /no digestible changes/)
}))

test('generateRollup writes on the day roll-up provider when one is configured, and records where it went', () => withDir(async dir => {
  const seen = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body))
    seen.push({ url: String(url), auth: init.headers.authorization, model: body.model })
    const content = JSON.stringify({ bullets: ['Added a Mission mode setting that stops extra sessions from starting.'] })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }
  try {
    const stageEnv = {
      ...ENV,
      CHANGELOG_ROLLUP_LLM_API_BASE: 'https://logfare.test/v1',
      CHANGELOG_ROLLUP_LLM_API_KEY: 'lfu_test_key',
      CHANGELOG_ROLLUP_LLM_MODEL: 'deepseek-v4.1-flash',
      LLM_API_KEYS: 'primary-ring-1,primary-ring-2'
    }
    const rollup = await generateRollup(DAY, [entry()], { dataDir: dir, env: stageEnv })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'https://logfare.test/v1/chat/completions', 'the stage route is used, not the primary')
    assert.equal(seen[0].auth, 'Bearer lfu_test_key', 'and only its own credential is sent')
    assert.equal(seen[0].model, 'deepseek-v4.1-flash')
    assert.equal(rollup.model, 'deepseek-v4.1-flash')
    assert.equal(rollup.provider, 'https://logfare.test/v1', 'the stored digest says which provider wrote it')
    assert.equal(rollup.source, rollupFingerprint(DAY, [entry()]))

    // Without a stage provider, nothing changes: the primary route serves it.
    seen.length = 0
    const primary = await generateRollup(DAY, [entry()], { dataDir: dir, env: ENV })
    assert.equal(seen[0].url, 'https://example.invalid/v1/chat/completions')
    assert.equal(seen[0].auth, 'Bearer offline-test')
    assert.equal(primary.provider, 'https://example.invalid/v1')
    assert.equal(primary.model, 'writer-model')
  } finally { globalThis.fetch = orig }
}))

// ------------------------------------------------------------------------------------
// The duplicate check: the one thing that can catch a paraphrase. Measured against a
// real day, the restatements that ship share four words in sixteen with the bullet
// they repeat ("Added in-flight sweep ... so a sponsored run that dies before a
// terminal report is marked failed" / "Added launch-time sweep recovery for sponsored
// runs that did not write a terminal report"), so no word-overlap rule reaches them.

test('the duplicate check asks a reader question, and can never empty the list', () => {
  const bullets = ['Added a thing.', 'Added another thing.', 'Fixed a third thing.']
  const prompt = buildRollupDedupePrompt(bullets, 5)
  assert.match(prompt, /1\. Added a thing\./)
  assert.match(prompt, /3\. Fixed a third thing\./)
  assert.match(prompt, /that day's 5 changes/)
  assert.match(prompt, /at most 5 of these bullets can be about different changes/)
  assert.match(prompt, /keep both/, 'when unsure, the reader keeps it')
  assert.match(prompt, /\{"drop":\[2,5\]\}/)
  assert.match(buildRollupDedupePrompt(bullets, 1), /that day's 1 change/, 'the count is singular when it is')

  // In range, integers only, no repeats; out-of-range and junk are ignored.
  assert.deepEqual(validateDedupeOut({ drop: [2, 2, 9, '3', 'x', 1] }, 4), { drop: [1, 2, 3] })
  assert.deepEqual(validateDedupeOut({ drop: [] }, 4), { drop: [] }, 'an empty drop keeps every bullet')
  assert.throws(() => validateDedupeOut('a prose answer', 4), /missing a drop array/)
  assert.throws(() => validateDedupeOut({ drop: [1, 2, 3] }, 3), /every bullet/)
  assert.throws(() => validateDedupeOut({ drop: [1, 2, 3, 4] }, 4), /every bullet/)
})

test('dedupeBullets drops what the check names, and ships the rules when it cannot answer', async () => {
  const bullets = ['Added one thing.', 'Added two things.', 'Added three things.', 'Added four things.']
  const seen = []
  const ok = await dedupeBullets(bullets, {
    changes: 5,
    env: {},
    call: async (prompt, env, validate) => { seen.push(prompt); return { out: validate({ drop: [4] }), requests: [] } }
  })
  assert.deepEqual(ok, { bullets: bullets.slice(0, 3), dropped: 1, source: 'model' })
  assert.match(seen[0], /4\. Added four things\./)

  // A provider outage must not cost the digest.
  const down = await dedupeBullets(bullets, { changes: 5, env: {}, call: async () => { throw new Error('LLM HTTP 503: gone') } })
  assert.deepEqual(down, { bullets, dropped: 0, source: 'rules' })

  // An answer the validator refuses never empties the list either.
  const refuse = await dedupeBullets(bullets, { changes: 5, env: {}, call: async (p, e, validate) => { validate({ drop: [1, 2, 3, 4] }); return { out: {} } } })
  assert.deepEqual(refuse, { bullets, dropped: 0, source: 'rules' })

  // Two bullets have nothing to choose between, and the operator can turn the
  // paid check off: neither spends a request.
  let calls = 0
  const count = async () => { calls++ }
  await dedupeBullets(['Added one thing.', 'Added two things.'], { changes: 5, env: {}, call: count })
  await dedupeBullets(bullets, { changes: 5, env: { CHANGELOG_ROLLUP_DEDUPE: '0' }, call: count })
  assert.equal(calls, 0)
})

test('generateRollup runs the duplicate check and records what it removed', () => withDir(async dir => {
  const rows = [
    entry({ sha: '1'.repeat(40) }),
    entry({ sha: '2'.repeat(40), ai: { title: 'Sidebar fix', summary: 'The project picker no longer opens behind the sidebar.' }, eli5: undefined }),
    entry({ sha: '3'.repeat(40), ai: { title: 'Model picker tooltip wording', summary: 'The model picker tooltip now names the selected model.' }, eli5: undefined }),
    entry({ sha: '4'.repeat(40), ai: { title: 'Session timing note', summary: 'The session panel notes when the current session started.' }, eli5: undefined })
  ]
  const orig = globalThis.fetch
  const prompts = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body))
    const content = body.messages.at(-1).content
    prompts.push(content)
    // First ask: the bullets. Every later ask is the duplicate check.
    const payload = prompts.length === 1
      ? { bullets: ['Added a Mission mode setting that stops extra sessions from starting.', 'Fixed the project picker opening behind the sidebar.', 'Updated the model picker tooltip wording.', 'Added a new note about session timing.'] }
      : { drop: [4] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })
  }
  try {
    const rollup = await generateRollup(DAY, rows, { dataDir: dir, env: ENV })
    assert.equal(prompts.length, 2, 'one call writes the digest, one reads it back for duplicates')
    assert.match(prompts[1], /last check on the bullet list/)
    assert.deepEqual(rollup.bullets, [
      'Added a Mission mode setting that stops extra sessions from starting.',
      'Fixed the project picker opening behind the sidebar.',
      'Updated the model picker tooltip wording.'
    ])
    assert.equal(rollup.dropped, 1, 'the stored digest says how much of the answer did not ship')
    const stored = JSON.parse(await readFile(join(dir, 'rollups', `${DAY}.json`), 'utf8'))
    assert.equal(stored.dropped, 1)
    assert.deepEqual(stored.bullets, rollup.bullets)
  } finally { globalThis.fetch = orig }
}))
