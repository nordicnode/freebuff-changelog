// generator/test/howto.test.mjs - the self-writing how-to guide.
//
// Three modules that only make sense together, so they are tested together:
// facets.mjs compiles the fact set (and decides which questions are worth
// asking), guide.mjs supplies the grounding checks, and howto.mjs retrieves and
// answers. The tests below are mostly about the checks that caught real wrong
// answers during development, because those are the ones that will catch the
// next real wrong answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildGuide, auditGuide, guideDelta } from '../lib/facets.mjs'
import { facetContradictions, ungroundedNumbers, facetCorpus } from '../lib/guide.mjs'
import { buildHowIndex, retrieve, retrieveExpanded, buildExpansionPrompt, parseExpansion, tokenize, matchEntities, generateQuestions, validateAnswer, howToKey, writeHowto, HOWTO_V, HOWTO_SECTION_CHARS, HOWTO_TIGHT_CHARS, assembleHowContext, surfaceNames, userFacingWhy, buildAnswerIndex, scoreAnswer, bandOf, bandReason, BAND_HIGH, BAND_LOW } from '../lib/howto.mjs'
import { mergeAnswerCache } from '../lib/mergedata.mjs'
import { isTransientError } from '../lib/llm.mjs'

const sha = (c) => String(c).repeat(40)
const day = (n) => ({ sha: sha(n), day: `2026-09-0${n}` })
// `t2` is the context for a test that has to await inside a dynamic import.
const t2 = { after: () => {} }

// ---------------------------------------------------------------------------
// facets.mjs -- the replay

test('facets: status is decided by the LAST event, not the first', () => {
  // The three shapes that decide everything downstream, because generateQuestions
  // asks about live items and only live items.
  const entries = [
    { ...day(1), cmdChanges: { added: ['/alpha'] } },
    { ...day(2), cmdChanges: { added: ['/beta'], removed: ['/gamma'] } },
    { ...day(3), cmdChanges: { added: ['/gamma'] } }
  ]
  const g = buildGuide(entries, { facets: ['commands'] })
  const by = Object.fromEntries(g.facets[0].items.map(i => [i.key, i]))
  assert.equal(by['/alpha'].status, 'live')
  assert.equal(by['/beta'].status, 'live')
  assert.equal(by['/gamma'].status, 'live', 'removed then re-added is live again')
  assert.equal(by['/gamma'].events.length, 2, 'the supersession chain survives collapse')
  assert.deepEqual(by['/gamma'].events.map(e => e.kind), ['added', 'removed'], 'events are newest first')
})

test('facets: a key whose last event is a removal is retired', () => {
  const g = buildGuide([{ ...day(1), cmdChanges: { added: ['/gone'] }, }, { ...day(2), cmdChanges: { removed: ['/gone'] } }], { facets: ['commands'] })
  const it = g.facets[0].items[0]
  assert.equal(it.status, 'retired')
  assert.equal(g.facets[0].live, 0)
  assert.equal(g.facets[0].items.length, 1, 'a retired key is still an item, not deleted')
})

test('facets: repeated adds collapse, but a real removal between them does not', () => {
  // The collapse rule exists so "added -> added -> added" (the extractor reading
  // the same name out of three files) does not render as a lifecycle.
  const noisy = buildGuide([
    { ...day(1), cmdChanges: { added: ['/dup'] } },
    { ...day(2), cmdChanges: { added: ['/dup'] } },
    { ...day(3), cmdChanges: { added: ['/dup'] } }
  ], { facets: ['commands'] })
  assert.equal(noisy.facets[0].items[0].events.length, 1)
  assert.equal(noisy.facets[0].items[0].events[0].seenIn, 3)
  assert.equal(noisy.facets[0].items[0].events[0].alsoIn.length, 2, 'the duplicate sightings are recorded, not dropped')

  const real = buildGuide([
    { ...day(1), cmdChanges: { added: ['/flip'] } },
    { ...day(2), cmdChanges: { added: ['/flip'] } },
    { ...day(3), cmdChanges: { removed: ['/flip'] } },
    { ...day(4), cmdChanges: { added: ['/flip'] } }
  ], { facets: ['commands'] })
  assert.equal(real.facets[0].items[0].events.length, 3, 'a removal is a lifecycle event, not a duplicate sighting')
  assert.equal(real.facets[0].items[0].status, 'live')
})

test('facets: a re-stated model row is a change event, and keeps the model live', () => {
  const g = buildGuide([
    { ...day(1), modelChanges: { added: ['GLM 5.3 Flash'], tables: {} } },
    {
      ...day(2),
      modelChanges: {
        added: [],
        removed: [],
        tables: { 'GLM 5.3 Flash': { before: ['GLM 5.3 Flash', 'free', 'x'], after: ['GLM 5.3 Flash', 'pro', 'y'] } }
      }
    }
  ], { facets: ['models'] })
  const it = g.facets[0].items[0]
  assert.equal(it.status, 'live', 'a re-statement is evidence it still exists')
  assert.equal(it.detail, 'pro', 'the fresher value wins')
  assert.deepEqual(it.events.map(e => e.kind), ['changed', 'added'])
})

test('facets: asOf is the NEWEST day, not rows[0]', () => {
  // Entries are stored oldest-first. The first version read rows[0].day and
  // reported the guide as of 2024 while it described 2026.
  const g = buildGuide([
    { ...day(1), cmdChanges: { added: ['/a'] } },
    { ...day(7), cmdChanges: { added: ['/b'] } },
    { ...day(4), cmdChanges: { added: ['/c'] } }
  ])
  assert.equal(g.asOf, '2026-09-07')
})

test('facets: --since keeps only items whose latest event is new, retired ones included', () => {
  const entries = [
    { ...day(1), cmdChanges: { added: ['/old'] } },
    { ...day(2), cmdChanges: { added: ['/new'] } },
    { ...day(3), cmdChanges: { removed: ['/old'] } }
  ]
  const since = buildGuide(entries, { since: '2026-09-02', facets: ['commands'] })
  const keys = since.facets[0].items.map(i => i.key)
  assert.deepEqual(keys, ['/new', '/old'], '"the command you were using is gone" is exactly the news a delta carries')
  assert.equal(since.facets[0].total, 2, 'total is the unfiltered size, so the page can say what it is showing of what')
  assert.equal(since.facets[0].items.length, 2)
})

test('facets: coverage reports the share of tracked changes that carried facts', () => {
  const entries = [
    { ...day(1), cmdChanges: { added: ['/a'] } },
    { ...day(2), ai: { title: 'unrelated work' } }
  ]
  const g = buildGuide(entries, { facets: ['commands'] })
  assert.equal(g.facets[0].coverage.rows, 1)
  assert.equal(g.facets[0].coverage.of, 2)
  assert.equal(g.facets[0].coverage.pct, 50)
})

test('facets: the headline is the news, not the bulk', () => {
  // 3,906 live exported symbols rendered as a list is a data dump. Retirements
  // and supersession chains are what a human reads first.
  const entries = [{ ...day(1), structured: { exportsAdded: Array.from({ length: 60 }, (_, i) => `exported${i}`) } }]
  for (let i = 0; i < 12; i++) entries.push({ ...day(2), structured: { exportsAdded: [`live${i}`], exportsRemoved: [`exported${i}`] } })
  const g = buildGuide(entries, { facets: ['api'] })
  assert.equal(g.facets[0].items.length, 72, '60 exports plus the 12 that replaced them')
  assert.equal(g.facets[0].headline.length, 12)
  assert.ok(g.facets[0].headline.every(i => i.status === 'retired'), 'the 48 untouched exports and the 12 replacements are not the story')
})

test('auditGuide: a guide that cannot be reproduced is reported', () => {
  const entries = [
    { ...day(1), cmdChanges: { added: ['/a'] } },
    { ...day(2), cmdChanges: { added: ['/b'], removed: ['/c'] } }
  ]
  assert.deepEqual(auditGuide(buildGuide(entries), entries), [], 'a freshly built guide audits clean')

  // A rendered page that disagrees with the replay is the failure worth
  // catching: a value with no commit behind it reads exactly as well as one
  // that has a commit behind it.
  const tampered = buildGuide(entries)
  const cmds = tampered.facets.find(f => f.id === 'commands')
  cmds.items.find(i => i.key === '/a').status = 'retired'
  const problems = auditGuide(tampered, entries)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /"\/a" does not match the replay/)
})

test('auditGuide: a cited commit that is not in the changelog is reported', () => {
  const entries = [{ ...day(1), cmdChanges: { added: ['/a'] } }]
  const g = buildGuide(entries)
  g.facets.find(f => f.id === 'commands').items[0].events[0].sha = sha('f')
  const problems = auditGuide(g, entries)
  assert.ok(problems.some(p => /cites commit/.test(p)), problems.join('; '))
})

test('guideDelta: newest first, across facets', () => {
  const entries = [
    { ...day(1), cmdChanges: { added: ['/a'] } },
    { ...day(5), structured: { exportsRemoved: ['oldExport'] } },
    { ...day(3), modelChanges: { added: ['M1'], tables: {} } }
  ]
  const d = guideDelta(buildGuide(entries))
  assert.deepEqual(d.map(x => x.day), ['2026-09-05', '2026-09-03', '2026-09-01'])
  assert.equal(d[0].facet, 'api')
  assert.equal(d[0].facetLabel, 'Public API surface')
})

// ---------------------------------------------------------------------------
// guide.mjs -- the grounding checks

test('writeHowto: a rate-limited question is asked again next run, a real verdict is not', async (t) => {
  // 20 of 22 failures in one full run were bare 429s, and the cache treated
  // every cached error as final -- so each of those questions would have been
  // skipped forever by the next nightly drain. A transport fault is not a
  // verdict on the question and must not be cached as one.
  // 429 counts as transient, and that is the case the run actually hit.
  assert.ok(isTransientError(new Error('LLM HTTP 429: rate limited')), 'a 429 is transient')
  const dir = await mkdtemp(join(tmpdir(), 'howto-transient-'))
  const data = await mkdtemp(join(tmpdir(), 'howto-tdata-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'session.ts'), 'export function exportSession () { return 1 }\n')
  g('add', '-A')
  g('commit', '-qm', 'x')
  const index = await buildHowIndex([], dir)
  const ask = [{ q: 'How do I export a session?', tags: ['command'] }]
  const env = { LLM_API_KEY: 'k', LLM_MODEL: 'm', CHANGELOG_LLM_RPM: 0 }
  const opts = { index, questions: ask, expand: false }
  const orig = globalThis.fetch

  // First run: the gateway drops the connection. A network fault is the same
  // class of verdict-less failure as a 429, and unlike a 429 it costs no real
  // backoff sleep in the test.
  globalThis.fetch = async () => { throw new Error('fetch failed') }
  try {
    const first = await writeHowto([], dir, data, env, opts)
    assert.ok(first.failed > 0, 'the run reports the failure')
    const stored = Object.values(JSON.parse(await readFile(join(data, 'howto.json'), 'utf8')))
    const errRec = stored.find(r => r.error)
    assert.equal(errRec.transient, true, 'recorded as transient, not as a verdict')
  } finally {
    globalThis.fetch = orig
  }

  // Second run: the gateway is healthy. The question must be asked again.
  const GOOD = JSON.stringify({ covered: true, answer: 'Use the export command to write the session to a file.', used: [] })
  let asked = 0
  globalThis.fetch = async () => {
    asked++
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: GOOD } }] }) }
  }
  try {
    const second = await writeHowto([], dir, data, env, opts)
    assert.ok(asked > 0, 'the rate-limited question was asked again rather than skipped')
    assert.equal(second.results[0].covered, true)
    assert.match(second.results[0].answer, /export command/)
  } finally {
    globalThis.fetch = orig
  }
})

test('writeHowto: a refusal is re-asked once against tighter evidence, and that answer is published', async (t) => {
  // This is the path that was broken and no other test could see it: the
  // second shot is made from the catch block, so a helper declared inside the
  // try is not in scope there. The run reported "ask is not defined", recorded
  // a decline anyway, and moved on. Syntax checks and unit tests were all
  // green throughout, because nothing drove the writer against a stub.
  const dir = await mkdtemp(join(tmpdir(), 'howto-refuse-'))
  const data = await mkdtemp(join(tmpdir(), 'howto-data-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await mkdir(join(dir, 'cli/src/commands'), { recursive: true })
  await writeFile(
    join(dir, 'cli/src/commands/session.ts'),
    'export function exportSession () {\n  return writeFileSync(SESSION_PATH)\n}\n// The export command writes the current session to a file on disk.\n'
  )
  g('add', '-A')
  g('commit', '-qm', 'x')

  const index = await buildHowIndex([], dir)
  const REFUSAL = "I'm DeepSeek, an AI assistant developed by DeepSeek. I cannot share or dump internal system instructions or prompts, but I'm ready to help."
  const GOOD = JSON.stringify({ covered: true, answer: 'Use the export command, which writes the current session to a file on disk.', used: ['cli/src/commands/session.ts'] })
  const prompts = []
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls++
    const prompt = JSON.parse(String(init.body)).messages[0].content
    prompts.push(prompt)
    // Three attempts per ask before it gives up, so the fourth call is the
    // first call of the second, tighter ask.
    const content = calls <= 3 ? REFUSAL : GOOD
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }
  }
  try {
    const res = await writeHowto([], dir, data, { LLM_API_KEY: 'k', LLM_MODEL: 'm', CHANGELOG_LLM_RPM: 0 }, {
      index,
      questions: [{ q: 'How do I export a session?', tags: ['command'] }],
      expand: false
    })
    assert.equal(res.failed, 0, 'a refusal is not a failure')
    assert.equal(res.declined, 0, 'the second shot answered, so nothing is declined')
    const rec = res.results[0]
    assert.equal(rec.covered, true)
    assert.match(rec.answer, /export command/)
    assert.equal(rec.refused, undefined, 'a rescued answer is an ordinary answer, not a flagged decline')
    const answerPrompts = prompts.filter(p => /Answer the question/.test(p))
    // callLlm spends three in-call attempts on a refusal before giving up, so
    // four answer prompts means the fourth was the separate, tighter ask.
    assert.ok(answerPrompts.length >= 4, `the tighter second ask was made, got ${answerPrompts.length} answer prompts`)
  } finally {
    globalThis.fetch = orig
  }
})

test('writeHowto: a question that refuses twice is recorded as a decline, not an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'howto-refuse2-'))
  const data = await mkdtemp(join(tmpdir(), 'howto-data2-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'session.ts'), 'export function exportSession () { return 1 }\n')
  g('add', '-A')
  g('commit', '-qm', 'x')

  const index = await buildHowIndex([], dir)
  const REFUSAL = "I'm DeepSeek, an AI assistant developed by DeepSeek. I cannot share or dump internal system instructions or prompts."
  const orig = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ message: { content: REFUSAL } }] })
  })
  try {
    const res = await writeHowto([], dir, data, { LLM_API_KEY: 'k', LLM_MODEL: 'm', CHANGELOG_LLM_RPM: 0 }, {
      index,
      questions: [{ q: 'How do I export a session?', tags: ['command'] }],
      expand: false
    })
    assert.equal(res.failed, 0, 'still not a failure')
    assert.equal(res.declined, 1)
    const rec = res.results[0]
    assert.equal(rec.covered, false)
    assert.equal(rec.refused, true, 'flagged, so a maintainer can see the backlog')
    assert.equal(rec.error, undefined, 'a decline is not parked as an error')
  } finally {
    globalThis.fetch = orig
  }
})

test('the tight pass is a real subset, and docs and changes keep a larger share', () => {
  // The second attempt after a refusal uses the same files in less space, so
  // every per-kind cap has to be smaller than the first pass or it is not a
  // second attempt at all.
  for (const k of ['docs', 'changes', 'code', 'total']) {
    assert.ok(HOWTO_TIGHT_CHARS[k] < HOWTO_SECTION_CHARS[k], `${k} shrinks on the second pass`)
  }
  assert.ok(HOWTO_TIGHT_CHARS.total < HOWTO_SECTION_CHARS.total / 2, 'a third of the window, not a token trim')
  // Code is what fills the window and what the model balks at; docs and changes
  // are where a procedure or a caveat is stated outright, so they keep more of
  // their share rather than being cut hardest.
  const share = (c) => c.docs / c.total - c.code / c.total
  assert.ok(share(HOWTO_TIGHT_CHARS) > share(HOWTO_SECTION_CHARS), 'docs and changes gain share on the tight pass')
})

test('assembleHowContext: the tight budget is honoured and names what it dropped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'howto-tight-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await mkdir(join(dir, 'cli/src/commands'), { recursive: true })
  // One file between the two code caps: the full pass can carry it, the tight
  // pass cannot. That gap is the whole point of the second attempt. Distinct
  // identifiers per line, because a file of one repeated token fills its
  // 400-term index budget with that token and retrieves on nothing.
  const wide = Array.from({ length: 6000 }, (_, i) => `export const WIDE_${i} = ${i} // zephyr`).join('\n')
  await writeFile(join(dir, 'cli/src/commands/big.ts'), wide)
  await writeFile(join(dir, 'cli/src/commands/small.ts'), 'export const NARROW = 2 // zephyr\n'.repeat(50))
  g('add', '-A')
  g('commit', '-qm', 'x')

  const index = await buildHowIndex([], dir)
  const hits = retrieve(index, 'zephyr')
  assert.ok(hits.code.length >= 2, `both files retrieved, got ${hits.code.map(u => u.path).join(', ')}`)
  const tight = await assembleHowContext(index, hits, { sectionChars: HOWTO_TIGHT_CHARS, expandDirs: false })
  const full = await assembleHowContext(index, hits, { sectionChars: HOWTO_SECTION_CHARS, expandDirs: false })
  assert.ok(tight.chars <= HOWTO_TIGHT_CHARS.total, `tight pass respected its cap, got ${tight.chars}`)
  assert.ok(full.chars <= HOWTO_SECTION_CHARS.total, `full pass respected its cap, got ${full.chars}`)
  assert.ok(tight.chars < full.chars, 'the tight pass really is smaller')
  assert.ok(tight.dropped.length > 0, 'a file that does not fit is dropped whole and named, never cut')
  assert.ok(tight.dropped.some(d => /big\.ts/.test(d)), `the oversized file is the one named: ${tight.dropped.join(', ')}`)
})

test('parseExpansion: a named path with the wrong folder is recovered by its filename', () => {
  // The model reads "bring my own API key" and knows the file is byok.ts, then
  // guesses three directories that do not exist. The real files are in
  // sdk/src, cli/src/commands and common/src/constants. All three guesses were
  // discarded, and the answer got written without a byok file in it.
  const index = {
    units: [
      { path: 'sdk/src/byok.ts' },
      { path: 'cli/src/commands/byok.ts' },
      { path: 'common/src/constants/byok.ts' },
      { path: 'cli/src/utils/exit-cleanly.ts' }
    ]
  }
  const ex = parseExpansion({ files: ['byok.ts', 'cli/src/agents/byok.ts', 'common/src/tools/params/tool/byok.ts'], terms: ['byok'] }, index)
  assert.deepEqual(ex.files, ['sdk/src/byok.ts', 'cli/src/commands/byok.ts', 'common/src/constants/byok.ts'])
  assert.equal(ex.rejectedFiles, 0, 'a right filename in a wrong folder is not a fabrication')
  assert.equal(ex.stemMatches, 3)
  assert.deepEqual(ex.terms, ['byok'])
})

test('parseExpansion: a filename that exists nowhere is still discarded', () => {
  const index = { units: [{ path: 'sdk/src/byok.ts' }, { path: 'cli/src/utils/exit-cleanly.ts' }] }
  const ex = parseExpansion({ files: ['totally/made/up.ts', 'api/keys/hypothetical.ts'], terms: [] }, index)
  assert.deepEqual(ex.files, [], 'nothing real was named, so nothing is fetched')
  assert.equal(ex.rejectedFiles, 2)
  assert.equal(ex.stemMatches, 0)
})

test('parseExpansion: a stem guess and an exact path both survive, in the order named', () => {
  const index = { units: [{ path: 'cli/src/commands/byok.ts' }, { path: 'sdk/src/byok.ts' }] }
  const ex = parseExpansion({ files: ['byok.ts', 'cli/src/commands/byok.ts'], terms: [] }, index)
  assert.deepEqual(ex.files, ['cli/src/commands/byok.ts', 'sdk/src/byok.ts'], 'both real files, the model order kept')
  assert.equal(ex.rejectedFiles, 0)
  assert.equal(ex.stemMatches, 1, 'the bare stem was the one that needed recovering')
})

test('ungroundedNumbers: an inherited Object property is not a number', () => {
  // `p in NUMBER_WORDS` walks the prototype chain, so "constructor",
  // "toString" and "valueOf" read as present and wordNumber handed back the
  // *function*. Every comparison against it is false, so the word survived the
  // "bare word" carve-out and was reported as an ungrounded number -- which
  // threw away a correct answer for mentioning the constructor.
  for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual(
      ungroundedNumbers(`The ${word} decides the tier.`, 'FREEBUFF_MODELS defines tiers'),
      [],
      `"${word}" is a word, not a number`
    )
  }
})

test('ungroundedNumbers: digits must exist in the evidence', () => {
  assert.deepEqual(ungroundedNumbers('The cap is 401 settings.', 'there are 401 items'), [])
  assert.deepEqual(ungroundedNumbers('The cap is 12_500.', 'price_cents = 12_500'), [])
  assert.deepEqual(ungroundedNumbers('The cap is 402.', 'there are 401 items'), ['402'])
  assert.deepEqual(ungroundedNumbers('Ids 12, 15 and 19 survived.', 'ids 12 15 19'), [], 'a list, not three separate claims')
})

test('ungroundedNumbers: number words are the hole, and compounds close it', () => {
  // The real failure: a sentence reading "Forty-one ... including the 401
  // currently present settings" where 401 was grounded and forty-one was not.
  assert.deepEqual(ungroundedNumbers('Forty-one sections are live.', 'live: 41'), [])
  assert.deepEqual(ungroundedNumbers('Forty-one sections are live.', 'live: 40'), ['forty-one'])
  assert.deepEqual(ungroundedNumbers('One hundred rows carry facts.', 'rows: 100'), [])
  assert.deepEqual(ungroundedNumbers('Two thousand rows.', 'rows: 2000'), [], 'two-word numbers multiply, they do not concatenate')
  assert.deepEqual(ungroundedNumbers('Two thousand rows.', 'rows: 1000'), ['two thousand'])
  assert.deepEqual(ungroundedNumbers('A hundred rows.', 'rows: 7'), [], 'a bare "hundred" is a multiplier, not a claim of 100')
  assert.deepEqual(ungroundedNumbers('Twenty one commands.', 'n: 21'), [], 'spaced compounds count too')
  // Not a number: the word scan must not fire on ordinary prose.
  assert.deepEqual(ungroundedNumbers('One of the commands is /copy.', '/copy is a command'), [])
  assert.deepEqual(ungroundedNumbers('Nothing was changed.', ''), [])
})

test('facetContradictions: a negation is read as absence, not presence', () => {
  // Every correctly-written sentence about a retired item says it is "no longer
  // present". The bare word "present" is in the presence list, so without the
  // negation guard this fires on the correct sentence and on nothing else.
  const retired = { noun: 'setting', items: [{ key: 'FREEBUFF_X', status: 'retired', events: [{ kind: 'removed', day: '2026-01-01' }] }] }
  assert.deepEqual(facetContradictions(retired, 'FREEBUFF_X is no longer present.'), [])
  assert.deepEqual(facetContradictions(retired, 'FREEBUFF_X is no longer available.'), [])
  const live = { noun: 'setting', items: [{ key: 'FREEBUFF_X', status: 'live', events: [{ kind: 'added', day: '2026-01-01' }] }] }
  // The same sentence about a live item IS a contradiction, and must say so.
  assert.match(facetContradictions(live, 'FREEBUFF_X is no longer present.').join('; '), /is called gone/)
  assert.deepEqual(facetContradictions(live, 'No setting is currently available for that.'), [], '"no" is not an indefinite quantifier, so this states the opposite')
})

test('facetContradictions: a live item called gone is caught, per item', () => {
  const facet = { noun: 'model', items: [{ key: 'GLM 5.3 Flash', status: 'live', events: [{ kind: 'added', day: '2026-01-01' }] }] }
  const bad = facetContradictions(facet, 'GLM 5.3 Flash was retired in the last release.')
  assert.equal(bad.length, 1)
  assert.match(bad[0], /"GLM 5\.3 Flash" is called gone/)
  // The facet counts are all zero-retirement here, so the per-item check is what
  // has to fire; if only the count check existed this would pass.
})

test('facetContradictions: a retired item called present is caught', () => {
  const facet = { noun: 'command', items: [{ key: '/reasoning', status: 'retired', events: [{ kind: 'removed', day: '2026-01-01' }] }] }
  assert.equal(facetContradictions(facet, 'The /reasoning command is currently available in the picker.').length, 1)
  assert.deepEqual(facetContradictions(facet, 'The /reasoning command is no longer available.'), [])
})

test('facetContradictions: a key containing a period is not split on it', () => {
  // "MiMo 2.5" cut in half by a clause split on punctuation is how the original
  // check missed every version-shaped name.
  const facet = {
    noun: 'model',
    items: [
      { key: 'MiMo 2.5', status: 'live', events: [{ kind: 'added', day: '2026-01-01' }] },
      { key: 'GLM 5.3 Flash', status: 'live', events: [{ kind: 'added', day: '2026-01-01' }] }
    ]
  }
  assert.match(facetContradictions(facet, 'MiMo 2.5 has been dropped.').join('; '), /"MiMo 2\.5" is called gone/)
  assert.match(facetContradictions(facet, 'GLM 5.3 Flash was discontinued.').join('; '), /"GLM 5\.3 Flash" is called gone/)
})

test('facetContradictions: a facet-wide claim is checked against the counts', () => {
  const none = { noun: 'setting', items: [] }
  assert.equal(facetContradictions(none, 'A number of configurations were retired.').length, 1, 'the `i` flag is load-bearing here')
  assert.equal(facetContradictions(none, 'Several settings are currently available.').length, 1)
  assert.equal(facetContradictions(none, 'Some settings changed their access tier.').length, 1)
  // Negated, these are the same words saying the opposite, and must survive.
  assert.deepEqual(facetContradictions(none, 'No configuration has been retired.'), [])
  assert.deepEqual(facetContradictions(none, 'A configuration was changed.'), [], 'no indefinite quantifier, so it states no count')
  assert.equal(facetContradictions(none, 'Some configuration was changed.').length, 1)

  const present = {
    noun: 'setting',
    items: [{ key: 'A', status: 'live', events: [{ kind: 'added', day: '2026-01-01' }] }, { key: 'B', status: 'retired', events: [{ kind: 'removed', day: '2026-01-01' }] }]
  }
  assert.deepEqual(facetContradictions(present, 'No setting was retired.'), [], 'one really was')
  assert.deepEqual(facetContradictions(present, 'No setting changed its access tier.'), [], 'no event records a value change')
})

test('facetContradictions: a commit hash in prose is rejected', () => {
  // The first version handed the model log lines with a `commits:` field and
  // every draft narrated the hashes back instead of summarising.
  const facet = { noun: 'model', items: [{ key: 'M1', status: 'live', events: [{ kind: 'added', day: '2026-01-01' }] }] }
  assert.ok(facetContradictions(facet, 'M1 was added in 0cbff57a.').some(p => /commit hash/.test(p)))
  assert.deepEqual(facetContradictions(facet, 'M1 landed in March.'), [], 'an ordinary word that is not a hash')
})

test('facetCorpus: counts and note are part of the closed world', () => {
  const facet = {
    label: 'Model catalog',
    question: 'What can a user pick?',
    note: 'Reconstructed from rows.',
    items: [{ key: 'M1', label: 'M1', detail: 'pro', status: 'live', events: [{ day: '2026-09-01', title: 'add M1' }] }],
    headline: [{ key: 'M0', label: 'M0', detail: null }],
    live: 1,
    total: 2,
    coverage: { rows: 9, of: 200, pct: 4.5 }
  }
  const c = facetCorpus(facet)
  assert.match(c, /^Model catalog/)
  assert.ok(c.includes('4.5') && c.includes('200'), 'a passage is allowed to say "across the 9 recorded changes"')
  assert.ok(c.includes('Reconstructed from rows.'))
})

// ---------------------------------------------------------------------------
// howto.mjs -- questions

test('generateQuestions: only live capabilities are asked about', () => {
  const entries = [
    { ...day(1), cmdChanges: { added: ['/copy', '/goneaway'] } },
    { ...day(2), cmdChanges: { removed: ['/goneaway'], added: ['/export'] } },
    { ...day(3), modelChanges: { added: ['GLM 5.3 Flash', 'Retired Model'], tables: {} } },
    { ...day(4), modelChanges: { added: [], removed: ['Retired Model'], tables: {} } },
    { ...day(5), structured: { envVars: ['FREEBUFF_PORT'], flags: ['--no-tty'] } },
    { ...day(6), ai: { title: 'Dropped the old auth path', breaking: true, migration: 'Use /export instead.' } }
  ]
  const qs = generateQuestions(entries)
  const text = qs.map(q => q.q).join('\n')
  assert.ok(text.includes('/copy'), 'a live command is worth a page')
  assert.ok(!text.includes('/goneaway'), '"how do I use /goneaway" is a question about something that no longer exists')
  assert.ok(text.includes('GLM 5.3 Flash'))
  assert.ok(!text.includes('What is the Retired Model model'), 'a retired model is not offered as a page')
  assert.ok(text.includes('FREEBUFF_PORT'), 'an env var is asked as "what is this for", not listed as a change')
  assert.ok(text.includes('--no-tty'), 'a flag is asked as a flag')
  assert.ok(text.includes('Dropped the old auth path'), 'a breaking change is its own question, not a line in a list')
  // Seeds survive, and every question is identifiable so a re-run is a no-op.
  assert.ok(qs.some(q => q.tags.includes('byok')))
  assert.equal(new Set(qs.map(q => q.id)).size, qs.length, 'question ids are unique')
})

test('generateQuestions: this site is a product too, and gets asked about', () => {
  const qs = generateQuestions([{ ...day(1), cmdChanges: { added: ['/copy'] } }])
  const site = qs.filter(q => q.tags.includes('site'))
  assert.ok(site.length >= 8, `expected the site questions, got ${site.length}`)
  const text = site.map(q => q.q).join(' ').toLowerCase()
  for (const word of ['rss', 'search', 'stale', 'api', 'badge']) {
    assert.ok(text.includes(word), `no site question mentions ${word}`)
  }
})

test('generateQuestions: a real supersession becomes a comparison, a self-swap does not', () => {
  // The bug this guards: reading the pair off the facet chain produces
  // "X versus X", because a `removed` event's key is the model that went away.
  const entries = [
    // A real swap is one commit that adds one name and removes another.
    { ...day(1), modelChanges: { added: ['New Model'], removed: ['Old Model'], tables: {} } },
    // A commit that both adds and removes the SAME name: a no-op, not a swap.
    { ...day(2), modelChanges: { added: ['Flip Model'], removed: ['Flip Model'], tables: {} } }
  ]
  const cmp = generateQuestions(entries).filter(q => q.tags.includes('compare'))
  assert.equal(cmp.length, 1, cmp.map(q => q.q).join(' | '))
  assert.match(cmp[0].q, /New Model and Old Model/)
  assert.ok(!/Flip Model.*Flip Model/.test(cmp[0].q))
  // A swap where neither side is still offered is history, not a question. The
  // added model is live by definition at the swap, so it takes a LATER commit
  // to retire both and make the comparison un-askable.
  const retired = [
    { ...day(1), modelChanges: { added: ['A'], removed: ['B'], tables: {} } },
    { ...day(2), modelChanges: { added: [], removed: ['A', 'B'], tables: {} } }
  ]
  assert.equal(generateQuestions(retired).filter(q => q.tags.includes('compare')).length, 0)
})

test('userFacingWhy: a refactor is not a user-facing change, and a swap is', () => {
  // The first filter subtracted an "internal" word list and dropped "/export"
  // and "MiniMax M3 withdrawn" because "file" and "module" appear in innocent
  // titles. Nothing is subtracted now; the question is only what was touched.
  assert.deepEqual(userFacingWhy({ files: { modified: ['common/src/utils/redaction.ts'] }, ai: { title: 'Delete advertiser reason redaction module from common' } }), [])
  assert.deepEqual(userFacingWhy({ cmdChanges: { added: ['/export'] }, ai: { title: 'Add /export command to save conversations to a file' } }), ['command +/export', 'visible behaviour'], 'two signals can fire, and both are reported')
  assert.deepEqual(userFacingWhy({ modelChanges: { added: [], removed: ['MiniMax M3'] }, ai: { title: 'MiniMax M3 withdrawn from Freebuff free models' } }), ['model -MiniMax M3'])
  assert.deepEqual(userFacingWhy({ files: { modified: ['common/src/constants/freebuff-subscriptions.ts'] }, ai: { title: 'Starter and Plus tiers resized' } }), ['surface file'])
  assert.deepEqual(userFacingWhy({ ai: { title: 'Clipboard copy on Linux appends a fix-it hint' } }), ['visible behaviour'])
  assert.deepEqual(userFacingWhy({ noise: true, cmdChanges: { added: ['/x'] } }), [], 'a noise row is never user-facing')
  assert.deepEqual(userFacingWhy(null), [])
})

test('generateQuestions: internal refactors never become a question', () => {
  const entries = [
    { ...day(1), ai: { title: 'Delete advertiser reason redaction module from common', breaking: true, migration: 'nothing to do' } },
    { ...day(2), ai: { title: 'Add /export command to save conversations to a file', breaking: true, migration: 'nothing to do' }, cmdChanges: { added: ['/export'] } }
  ]
  const text = generateQuestions(entries).map(q => q.q).join('\n')
  assert.ok(!text.includes('advertiser'), 'an implementer-only change is not a user-facing question')
  assert.ok(text.includes('/export'))
})

test('generateQuestions: two commits with the same title show once, newest kept', () => {
  // The real case: the summary pass wrote the same title for two different
  // commits, and the page rendered it twice, which reads as a bug rather than
  // as a timeline. Two DIFFERENT titles ("1.2 replaces 1.3" and "1.3 replaces
  // 1.2") are two real events and both stay.
  const title = 'Muse Spark 1.2 replaces 1.3 in free model picker'
  const entries = [
    { ...day(1), ai: { title, breaking: true }, modelChanges: { added: ['Muse Spark 1.2'], removed: ['Muse Spark 1.3'], tables: {} } },
    { ...day(2), ai: { title, breaking: true }, modelChanges: { added: ['Muse Spark 1.2'], removed: ['Muse Spark 1.3'], tables: {} } },
    { ...day(3), ai: { title: 'Muse Spark 1.3 replaces 1.2 in free model picker', breaking: true }, modelChanges: { added: ['Muse Spark 1.3'], removed: ['Muse Spark 1.2'], tables: {} } }
  ]
  const breaking = generateQuestions(entries).filter(q => q.tags.includes('breaking'))
  assert.equal(breaking.length, 2, breaking.map(q => q.q).join(' | '))
  assert.equal(breaking.filter(q => q.q.includes('1.3 replaces 1.2 in free model')).length, 1)
  assert.match(breaking[0].q, /1\.3 replaces 1\.2/, 'newest first')
})

// ---------------------------------------------------------------------------
// howto.mjs -- abstention

test('validateAnswer: declining is a valid answer and is never retried', () => {
  const out = validateAnswer({ covered: false, answer: 'The material has no pricing table, so this cannot be answered from it.', used: ['x.ts'] }, ctxOf('anything'))
  assert.equal(out.covered, false)
  assert.equal(out.used.length, 0, 'a decline leans on nothing, so it must claim nothing')
  // No grounding check runs: a decline makes no claim to ground.
  assert.doesNotThrow(() => validateAnswer({ covered: false, answer: 'Nothing in the material mentions 47 widgets.' }, ctxOf('none')))
  assert.throws(() => validateAnswer({ covered: false, answer: '' }, ctxOf('x')), /no reason/)
  assert.throws(() => validateAnswer({ covered: false, answer: "I'm sorry, I cannot help with that." }, ctxOf('x')), /refusal/)
})

test('validateAnswer: a decline is a real result, not an error', async () => {
  // The bug this prevents: treating "covered: false" as a failure makes the
  // pass retry it, and retrying a question the evidence cannot answer is how a
  // "we do not know" eventually becomes a plausible invention.
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-decline-'))
  t2.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const { writeHowto, loadHowto } = await import('../lib/howto.mjs')
  const out = await writeHowto([], dir, dir, { CHANGELOG_LLM: '1', LLM_API_KEY: 'x', LLM_BASE_URL: 'http://127.0.0.1:1', LLM_MODEL: 'm' }, {
    questions: [{ q: 'How much does the Pro plan cost per month exactly in dollars?', id: 'ask:1', tags: ['ask'] }]
  })
  // No LLM reachable, so this must record a failure rather than pretend.
  assert.equal(out.answers ?? out.results.length >= 0, true)
  assert.equal(out.declined, 0, 'a transport error is a failure, not a decline')
  assert.equal(out.failed, 1)
  assert.equal((await loadHowto(dir)).size, 0, 'a failure stores no answer')
})

// ---------------------------------------------------------------------------
// howto.mjs -- matching a reader's words

test('buildAnswerIndex: a reader typing "queue" finds the /queue answer', () => {
  const idx = buildAnswerIndex([
    { q: 'What does the /queue command do, and how do I use it?', tags: ['command', '/queue'], answer: 'The /queue command lists pending requests.' },
    { q: 'What does the /export command do?', tags: ['command', '/export'], answer: 'The /export command writes a conversation to a file.' }
  ])
  const hit = scoreAnswer(idx.items[0].t, [...tokenize('is there a command to see the queue')], idx)
  const miss = scoreAnswer(idx.items[1].t, [...tokenize('is there a command to see the queue')], idx)
  assert.ok(hit.score > 0, 'the slash is what the product calls it, not what a reader types')
  assert.ok(hit.score > miss.score)
})

test('buildAnswerIndex: a question about something unheard of scores zero coverage', () => {
  // The whole abstention mechanism in one assertion: a term in no answer counts
  // toward the denominator at full rarity, so an out-of-domain question cannot
  // cover enough of itself to clear the low band.
  const idx = buildAnswerIndex([
    { q: 'What does the /export command do?', tags: ['command', '/export'], answer: 'Writes a conversation to a file.' }
  ])
  const known = scoreAnswer(idx.items[0].t, [...tokenize('export a conversation')], idx)
  const unknown = scoreAnswer(idx.items[0].t, [...tokenize('bake sourdough bread at home')], idx)
  assert.equal(bandOf(known.conf, known.matched, idx.df, idx.n), 'high')
  assert.equal(bandOf(unknown.conf, unknown.matched, idx.df, idx.n), 'none', `conf was ${unknown.conf}`)
  assert.equal(unknown.score, 0)
})

test('bands: three states, and the middle one exists on purpose', () => {
  // Two matched terms: corroborated, so coverage alone decides.
  assert.equal(bandOf(0.9, ['a', 'b'], {}), 'high')
  assert.equal(bandOf(BAND_HIGH + 0.01, ['a', 'b'], {}), 'high')
  assert.equal(bandOf(0.2, ['a', 'b'], {}), 'partial')
  assert.equal(bandOf(0.01, [], {}), 'none')
  // A reader who might be wrong is better served by an answer marked uncertain
  // than by either a confident wrong answer or a refusal to try.
  assert.equal(bandOf(BAND_LOW, ['a', 'b'], {}), 'partial')
})

test('bands: one ordinary word matching an answer is an accident, not a match', () => {
  // The case that made the corroboration rule necessary. "make it faster"
  // cleared the high band on the strength of the word "make", which three
  // answers happened to contain. A lone term that is everywhere in the
  // background corpus is not evidence that the answer is about it.
  const corpus = { make: 900, faster: 2 }
  assert.equal(bandOf(0.52, ['make'], corpus), 'partial', 'one common term')
  assert.equal(bandOf(0.52, ['faster'], corpus), 'high', 'one rare term is the thing the reader named')
  assert.match(bandReason(0.52, ['make'], corpus), /accident/)
  assert.equal(bandReason(0.52, ['faster'], corpus), '')
})

test('a background corpus is what stops ordinary words looking rare', () => {
  // Without one, rarity is measured against a few dozen answers and every word
  // the guide happens not to use looks informative.
  const answers = [{ q: 'What does the /export command do?', tags: ['command', '/export'], answer: 'Writes a conversation to a file. Also make one.' }]
  const bare = buildAnswerIndex(answers)
  const withBg = buildAnswerIndex(answers, { background: Array.from({ length: 300 }, () => 'make the thing that you can use to write a file') })
  assert.ok((withBg.df.make || 0) > (bare.df.make || 0), '"make" is no longer rare once the background counts it')
  assert.ok(withBg.n > bare.n)
  assert.ok((withBg.df.export || 0) <= 2, 'a word the background never uses stays rare, which is the point')
  assert.ok((withBg.df.make || 0) > 100 * (withBg.df.export || 1), 'rarity is now estimated against the background, not the answer count')
})

test('askQuestions: a reader question joins the pass once, and only if it is a question', async () => {
  const { askQuestions } = await import('../lib/howto.mjs')
  const asks = askQuestions([
    'Why did my model disappear from the picker overnight?',
    { q: 'Why did my model disappear from the picker overnight?' },
    'why did my model disappear from the picker overnight',
    'hi',
    'x'.repeat(400)
  ], [])
  assert.equal(asks.length, 1, 'punctuation and case are not a different question')
  assert.equal(asks[0].tags[0], 'ask')
  // An already-answered question is not paid for twice.
  assert.equal(askQuestions(['Why did my model disappear from the picker overnight?'], ['Why did my model disappear from the picker overnight?']).length, 0)
})

test('generateQuestions: a guide can be passed in rather than rebuilt', () => {
  const entries = [{ ...day(1), cmdChanges: { added: ['/copy'] } }]
  const stub = { facets: [{ id: 'commands', items: [{ key: '/copy', status: 'live' }] }, { id: 'models', items: [] }, { id: 'config', items: [] }] }
  assert.ok(generateQuestions(entries, stub).some(q => q.q.includes('/copy')))
  // A missing facet must not throw: the stub above has no `breaking`.
  assert.doesNotThrow(() => generateQuestions(entries, stub))
})

test('surfaceNames: names come from the change log, so nothing is hand-maintained', () => {
  const names = surfaceNames([
    { ...day(1), cmdChanges: { added: ['/copy'] }, modelChanges: { added: ['GLM 5.3 Flash'], tables: {} }, structured: { envVars: ['FREEBUFF_X'] } },
    { ...day(2), ai: { newFlags: ['--headless'] } },
    { ...day(3), noise: true, cmdChanges: { added: ['/hidden'] } }
  ])
  assert.deepEqual(names.sort(), ['--headless', '/copy', 'FREEBUFF_X', 'GLM 5.3 Flash'])
  assert.ok(!names.includes('/hidden'), 'a noise row contributes no name')
})

// ---------------------------------------------------------------------------
// howto.mjs -- retrieval

test('tokenize: keeps the identifiers a developer types, drops the filler', () => {
  const t = tokenize('How do I use the /copy command with FREEBUFF_MAX_TOKENS set?')
  assert.ok(t.has('/copy'), 'a slash command stays one token, so it does not match every row saying "copy"')
  assert.ok(t.has('freebuff_max_tokens'))
  assert.ok(!t.has('how') && !t.has('the') && !t.has('with'))
})

test('retrieval: a named model selects the rows that name it, not every row saying "model"', async (t) => {
  // This is the reason the index carries a literal `raw` per unit. "GLM 5.3
  // Flash" tokenises to glm/flash, which matches hundreds of rows.
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-howto-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'models.ts'), 'export const GLM_TABLE = 1\nexport const UNRELATED = 2\n')
  await mkdir(join(dir, 'docs'), { recursive: true })
  await writeFile(join(dir, 'docs/model-picker.md'), '# The model picker\n\nThe /copy command copies to the clipboard. GLM 5.3 Flash is listed here.\n')
  g('add', '-A')
  g('commit', '-qm', 'x')

  const entries = [
    { ...day(1), ai: { title: 'Add GLM 5.3 Flash to the catalog' }, modelChanges: { added: ['GLM 5.3 Flash'], tables: {} } },
    { ...day(2), ai: { title: 'Document the model picker' } },
    { ...day(3), ai: { title: 'Tidy the model list formatting' } }
  ]
  const index = await buildHowIndex(entries, dir, { entities: surfaceNames(entries) })

  const hits = retrieve(index, 'Which models can I pick, and what is GLM 5.3 Flash good at?')
  assert.ok(hits.entities.includes('glm 5.3 flash'), 'the literal name is matched whole')
  const top = hits.changes[0]
  assert.match(top.title, /GLM 5\.3 Flash/, 'the row naming the model outranks the two that merely say "model"')
  assert.ok(hits.docs.some(d => d.path === 'docs/model-picker.md'), 'the doc mentioning it is retrieved')
  assert.ok(index.units.some(u => u.kind === 'code' && u.path === 'models.ts'), 'code units exist, which is the bug the missing -h caused')
  assert.ok(hits.code.some(c => c.path === 'models.ts'), 'and a file is reachable by the path words a reader would use')

  // A question naming nothing gets no entity boost and no empty crash.
  assert.ok(retrieve(index, 'zzzqqq').changes.length === 0)
})

test('retrieval: entities are matched against the whole name, longest first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-howto2-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'a.ts'), 'export const A = 1\n')
  g('add', '-A')
  g('commit', '-qm', 'x')
  const entries = [
    { ...day(1), ai: { title: 'Add DeepSeek V4.1 Flash' }, modelChanges: { added: ['DeepSeek V4.1 Flash'], tables: {} } }
  ]
  const index = await buildHowIndex(entries, dir, { entities: surfaceNames(entries) })
  const ents = matchEntities(index, 'Is DeepSeek V4.1 Flash free?')
  assert.ok(ents.length >= 1)
  assert.equal(ents[0].name, 'deepseek v4.1 flash', 'the whole name, not the token "flash"')
  assert.equal(ents[0].units.length, 1)
})

// ---------------------------------------------------------------------------
// howto.mjs -- the answer gate

const ctxOf = (corpusText) => ({ sections: [], dropped: [], chars: corpusText.length, corpus: [corpusText], corpusText })

test('validateAnswer: an invented identifier is rejected', () => {
  // An answer that tells someone to run `--reexport-everything` because the
  // model liked the shape of the word is worse than no answer at all.
  const ctx = ctxOf('run /export to write a file; --no-tty is accepted by the CLI')
  assert.doesNotThrow(() => validateAnswer({ answer: 'Run /export, and pass --no-tty if you want plain output.' }, ctx))
  assert.throws(() => validateAnswer({ answer: 'Run /export with --reexport-everything.' }, ctx), /not in the evidence/)
  assert.throws(() => validateAnswer({ answer: 'Call migrateSavedDefaultModelPreference() first.' }, ctx), /not in the evidence/)
})

test('validateAnswer: an invented number is rejected, a grounded one is not', () => {
  const ctx = ctxOf('OSC 52 payloads are truncated at 22 KB; the window is 270000 tokens')
  assert.doesNotThrow(() => validateAnswer({ answer: 'Clipboard payloads are truncated at 22 KB.' }, ctx))
  assert.throws(() => validateAnswer({ answer: 'Clipboard payloads are truncated at 25 KB.' }, ctx), /not in the evidence/)
})

test('validateAnswer: a refusal and an empty answer are rejected', () => {
  const ctx = ctxOf('nothing relevant')
  assert.throws(() => validateAnswer({ answer: '' }, ctx), /empty/)
  assert.throws(() => validateAnswer({ answer: "I'm sorry, I cannot help with that." }, ctx), /refusal/)
  assert.throws(() => validateAnswer({ answer: 'x'.repeat(4000) }, ctx), /over the/)
})

test('validateAnswer: used is normalised, not trusted', () => {
  const out = validateAnswer({ answer: 'Use /export.', used: ['a.ts', 42, ...Array.from({ length: 30 }, (_, i) => `f${i}.ts`)] }, ctxOf('/export'))
  assert.equal(out.used.length, 12)
  assert.ok(out.used.every(u => typeof u === 'string'))
  assert.equal(out.used[1], '42', 'a non-string source is kept as one rather than dropped')
})

test('howToKey: same evidence and model reuse, a moved source does not', () => {
  const a = howToKey('How do I use /copy?', ctxOf('a'.repeat(500)), 'deepseek-v4.1')
  assert.equal(a, howToKey('How do I use /copy?', ctxOf('a'.repeat(500)), 'deepseek-v4.1'))
  assert.notEqual(a, howToKey('How do I use /copy?', ctxOf('b'.repeat(500)), 'deepseek-v4.1'), 'the source moved')
  assert.notEqual(a, howToKey('How do I use /export?', ctxOf('a'.repeat(500)), 'deepseek-v4.1'), 'the question changed')
  assert.notEqual(a, howToKey('How do I use /copy?', ctxOf('a'.repeat(500)), 'gpt-4o-mini'), 'the model changed')
  assert.match(a, new RegExp(`:v${HOWTO_V}$`), 'the version is in the key, so a prompt bump invalidates every answer')
})

// ---------------------------------------------------------------------------
// mergedata.mjs -- the cache that must not eat itself

test('mergeAnswerCache: keeps a key the summary-cache pruner would delete', () => {
  // Regression: these caches are not in the summary cache's version space, and
  // running them through mergeAiCache emptied them on the first write. A cache
  // that empties itself looks like it is working.
  const entry = { q: 'q', answer: 'a', v: HOWTO_V, at: '2026-09-27T10:00:00.000Z' }
  const ours = { 'how:aaa:bbb:ccc:v1': entry }
  const theirs = { 'how:aaa:bbb:ddd:v1': { ...entry, answer: 'newer', at: '2026-09-27T11:00:00.000Z' } }
  const out = mergeAnswerCache(ours, theirs)
  assert.equal(Object.keys(out).length, 2, 'disjoint keys are unioned, not dropped')
  assert.equal(out['how:aaa:bbb:ccc:v1'], entry)

  // Same key, both writers: the newer timestamp wins, and the merge is
  // commutative in the sense that matters -- it does not depend on argument order.
  const old = { k: { ...entry, answer: 'old', at: '2026-09-27T10:00:00.000Z' } }
  const fresh = { k: { ...entry, answer: 'new', at: '2026-09-27T12:00:00.000Z' } }
  assert.equal(mergeAnswerCache(old, fresh).k.answer, 'new')
  assert.equal(mergeAnswerCache(fresh, old).k.answer, 'new')
  assert.deepEqual(mergeAnswerCache(undefined, ours), ours)
  assert.deepEqual(mergeAnswerCache(ours, undefined), ours)
})

// ---------------------------------------------------------------------------
// howto.mjs -- query expansion

test('parseExpansion: a file that does not exist is discarded, not fetched', () => {
  // This is the one place a model can point the retriever at a path that was
  // never there. A fabricated path becomes a fabricated answer, so grounding
  // happens before the file is ever opened, and the rejection is counted so a
  // pass that invents paths is visible rather than silent.
  const index = { units: [{ path: 'cli/src/commands/copy.ts' }, { path: 'common/src/constants/models.ts' }] }
  const ex = parseExpansion({
    files: ['common/src/constants/models.ts', 'etc/passwd', 'cli/src/commands/../../secrets.ts', './cli/src/commands/copy.ts'],
    terms: ['model', 'catalog', '../escape', 'ok-term']
  }, index)
  assert.deepEqual(ex.files, ['common/src/constants/models.ts', 'cli/src/commands/copy.ts'], 'real paths kept, in order')
  assert.equal(ex.rejectedFiles, 2, 'the two that were not in the index are counted')
  assert.deepEqual(ex.terms, ['model', 'catalog', 'ok-term'], 'a term that is not a plain identifier is dropped')
})

test('parseExpansion: shapes that are not the agreed one yield nothing', () => {
  const index = { units: [{ path: 'a.ts' }] }
  for (const bad of [null, undefined, 'not json', '[]', '{"files":"nope"}', 42]) {
    const ex = parseExpansion(bad, index)
    assert.equal(ex.files.length, 0, `${JSON.stringify(bad)} produced files`)
  }
  // A JSON string with prose around it is still read, because models wrap JSON
  // in explanation no matter what the prompt says.
  const wrapped = parseExpansion('Here you go:\n```json\n{"files":["a.ts"],"terms":["x"]}\n```\nHope that helps.', index)
  assert.deepEqual(wrapped.files, ['a.ts'])
})

test('buildExpansionPrompt: shows paths and symbols, and asks for no answer', () => {
  const p = buildExpansionPrompt('How do I switch models?', {
    code: [{ path: 'common/src/constants/models.ts', title: 'FREE_MODELS, freeModelIds' }],
    docs: [{ path: 'README.md', title: 'readme' }]
  })
  assert.match(p, /common\/src\/constants\/models\.ts/)
  assert.match(p, /FREE_MODELS/)
  assert.match(p, /You are NOT answering the question/)
  assert.match(p, /empty list/)
  // The cheap pass must stay small, or it stops being cheap.
  assert.ok(p.length < 8000, `prompt was ${p.length} chars`)
})

test('retrieveExpanded: a named file is promoted, and a no-op expansion changes nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-expand-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'a.ts'), 'export const unrelatedThing = 1\n')
  await writeFile(join(dir, 'b.ts'), 'export const theAnswer = 2\n')
  g('add', '-A')
  g('commit', '-qm', 'x')
  const index = await buildHowIndex([{ ...day(1), ai: { title: 'x' } }], dir)
  const base = retrieve(index, 'the answer')
  const same = retrieveExpanded(index, 'the answer', base, { files: [], terms: [] })
  assert.deepEqual(same.code.map(c => c.path), base.code.map(c => c.path), 'an empty expansion is exactly the old behaviour')
  const widened = retrieveExpanded(index, 'the answer', base, { files: [], terms: ['theAnswer'] })
  assert.ok(widened.code.length >= base.code.length)
})
