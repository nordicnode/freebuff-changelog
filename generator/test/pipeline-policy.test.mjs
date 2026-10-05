import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  enrichWithLlm, enrichEli5, enrichOpenPrs, validateVerifyOut, verifySummary,
  summarizeEntry, explainEntry, deliveredEvidence, buildPrompt, cacheKey,
  contextFingerprint, callLlm, llmCallCount, PROMPT_V, DEFAULT_VERIFY_MODEL,
  LLM_CONTEXT_TOKENS, rememberClosedPrs, matchPrByPaths, prSummaryKey,
  pruneExpiredErrors, gatherEntryContext, collectReleaseContext, formatReleaseContext,
  buildVerifyPrompt, buildEli5Prompt, getReleaseContextFor, summaryValidator, releaseBoilerplate, RELEASE_ROLLUP_V, VERIFY_POLICY_V, eli5Key, eli5Source, ELI5_V, normalizeEli5, ELI5_ROLLUP_MAX_CHARS,
  llmRpm, llmCapOf, createLlmRateLimiter, resetLlmRateLimiterForTests, retryAfterMs, gatherReleaseEvidence,
  backupEnvOf, isRouteFailure, servedModelOf
} from '../lib/llm.mjs'
import { artifactHash, qualityOf, qualityText, qualityNote, qualityStatus, dedupeClaims, generationState, regenUnfinished, QUALITY_POLICY_V } from '../lib/quality.mjs'
import { mergeChangelog, mergeOpenPrs, mergeHealth, persistMerged } from '../lib/mergedata.mjs'
import { runEval, latestResult } from '../lib/eval.mjs'
import { writeJson, withLock, withDeadline, git, shortHash } from '../lib/util.mjs'
import { checkDeployedHead } from '../lib/sync.mjs'
import { entryRecord, discordText, generateReleaseNotesMarkdown, buildSite, entryCard } from '../lib/site.mjs'
import { extractStructuredFacts, deterministicSummary } from '../lib/analyze.mjs'

beforeEach(() => resetLlmRateLimiterForTests())

const env = { CHANGELOG_LLM: '1', LLM_API_KEY: 'offline-test', LLM_API_BASE: 'https://example.invalid/v1', LLM_MODEL: 'unchanged-model', CHANGELOG_LLM_RPM: '-1', CHANGELOG_LLM_ESCALATE: '0' }
const entry = () => ({ sha: 'a'.repeat(40), prevSha: 'b'.repeat(40), kind: 'sync', date: '2026-09-30T00:00:00Z', day: '2026-09-30', summary: 'Internal limit changed.', title: 'Limit changed', significance: 'minor', files: { modified: ['a.ts'] } })
const patch = 'diff --git a/a.ts b/a.ts\n-export const LIMIT = 1\n+export const LIMIT = 2\n'
const response = payload => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'fb-policy-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir }

test('R19: default historical summary, ELI5 and PR queues spend zero provider calls', async t => {
  const dir = await temp(t)
  let calls = 0, reads = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected request') })
  const e = { ...entry(), ai: { v: PROMPT_V, model: 'old', title: 'Old text', summary: 'Old explanation.' } }
  assert.equal(await enrichWithLlm([e], async () => { reads++; return patch }, dir, env), 0)
  assert.equal(await enrichEli5([e], dir, env, { getPatch: async () => { reads++; return patch } }), 0)
  assert.equal(await enrichOpenPrs([{ number: 1, body: 'Historical' }], dir, env, { getDiff: async () => { reads++; return patch } }), 0)
  assert.equal(calls, 0)
  assert.equal(reads, 0)
  assert.equal(LLM_CONTEXT_TOKENS, 270000)
  assert.equal(DEFAULT_VERIFY_MODEL, 'deepseek-v4.1')
})

test('R1: malformed verdicts fail closed and negative-empty stays negative', () => {
  for (const value of [{}, [], { supported: true, issues: [], claims: [] }, { supported: true, issues: {}, claims: [] }, { supported: true, issues: [], claims: [{ quote: 'x' }] }]) assert.throws(() => validateVerifyOut(value))
  const negative = validateVerifyOut({ supported: false, issues: [], claims: [] })
  assert.equal(negative.supported, false)
  assert.ok(negative.issues.length)
})

test('R3: verifier requires audience and exact boolean field coverage', async t => {
  const clean = { title: 'Limit changed', summary: 'The limit changed.', audience: 'maintainers', userVisible: false, breaking: true, migration: 'Operators must update settings.' }
  let includeFields = false
  t.mock.method(globalThis, 'fetch', async () => response({ supported: true, issues: [], claims: [clean.title, clean.summary, clean.migration, ...(includeFields ? ['maintainers', 'userVisible: false', 'breaking: true'] : [])].map(quote => ({ quote, supported: true })) }))
  assert.equal((await verifySummary(entry(), patch, clean, env)).supported, false)
  includeFields = true
  assert.equal((await verifySummary(entry(), patch, clean, env)).supported, true)
})

test('R2: unavailable repair cannot clear the original verifier objection', async t => {
  const dir = await temp(t)
  let checks = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    if (/You are checking/.test(p)) {
      if (++checks === 1) return response({ supported: false, issues: ['Original claim lacks support'], claims: [] })
      throw new Error('verifier offline')
    }
    return response({ title: /A reviewer/.test(p) ? 'Replacement title' : 'Limit changed', summary: 'The internal limit changed.', confidence: 'high' })
  })
  const { record } = await summarizeEntry({ entry: entry(), patch, env, dataDir: dir })
  assert.equal(record.title, 'Limit changed')
  assert.equal(record.verify, 'flagged')
  assert.match(record.verifyClaims[0].claim, /Original claim/)
  assert.notEqual(record.confidence, 'high')
})

test('R4: invented plain-English promises receive a semantic objection', async t => {
  const dir = await temp(t)
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    return response(/You are checking/.test(p) ? { supported: false, issues: ['Unlimited free access is not in the evidence.'], claims: [] } : { eli5: 'Everyone gets unlimited free access and guaranteed preservation of their work.' })
  })
  const { record } = await explainEntry({ entry: entry(), patch, env, dataDir: dir })
  assert.equal(record.verify, 'flagged')
  assert.ok(qualityText({ eli5: record }).includes('Unlimited free access'))
  assert.equal(record.verifyHash, undefined)
})

test('verifier off: a fresh plain-English line carries no verdict, and no check is sent', async t => {
  const dir = await temp(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++
    const p = JSON.parse(init.body).messages.at(-1).content
    if (/You are checking/.test(p)) throw new Error('the verifier must not be asked when it is disabled')
    return response({ eli5: 'The internal limit was raised.' })
  })
  const off = { ...env, CHANGELOG_LLM_VERIFY: '0' }
  const { record } = await explainEntry({ entry: entry(), patch, env: off, dataDir: dir })
  assert.equal(calls, 1, 'only the writer was called')
  // 'unavailable' means a check was attempted and the route failed; a disabled
  // verifier owes no verdict, and stamping one polluted llm-health and told the
  // site a review was pending when none was owed.
  assert.equal(record.verify, undefined)
  assert.equal(record.verifyModel, undefined)
  assert.equal(record.verifyPolicy, undefined)
  assert.equal(record.policy, QUALITY_POLICY_V, 'the record still answers to the current policy')
  assert.equal(qualityOf({ eli5: record }).plainVerify, 'unchecked')
})

test('R6: exact-text stale verdicts and numeric objections stay in provenance, not exports', () => {
  const ai = { policy: QUALITY_POLICY_V, title: 'Title', summary: 'Before.', confidence: 'high', verify: 'passed' }
  ai.verifyHash = artifactHash(ai)
  ai.summary = 'After.'
  const e = { ...entry(), ai, eli5: { text: 'Unchecked promise.', verify: 'flagged', verifyClaims: [{ claim: 'Unlimited access' }] } }
  assert.equal(qualityOf(e).verify, 'stale')
  assert.equal(entryRecord(e).confidence, 'medium')
  assert.ok(!discordText(e).includes('[UNVERIFIED]'), 'no marker travels in Discord copy')
  assert.doesNotMatch(discordText(e), /objected|not current|no current verification/, 'and objections are not pasted into the announcement')
  assert.ok(!generateReleaseNotesMarkdown({ version: '1.0.1' }, [e]).includes('[UNVERIFIED]'), 'release notes carry no marker')
  assert.equal(entryRecord(e).quality.uncertain, true, 'the JSON record still carries the unresolved objection')
  ai.ungrounded = ['999']; ai.valueErrors = ['LIMIT is reversed']; ai.verifyClaims = [{ claim: 'Exact objection' }]
  assert.match(qualityText(e), /999.*LIMIT.*Exact objection/)
})

test('R6/R19: never-checked history is disclosed quietly, a failed check is not', () => {
  // The distinction that matters in public: 7,927 stored ELI5 lines predate the
  // policy, and none of them ever recorded a verdict. Reporting that absence the
  // same way as a failed check put an alarm on every historical row.
  const legacy = { ai: { title: 'Old', summary: 'Old text.', confidence: 'high', migration: 'Update the config.' }, eli5: { text: 'Plain old line.', model: 'vyce/deepseek-v4.1' } }
  const q = qualityOf(legacy)
  assert.equal(q.verify, 'pre-policy')
  assert.equal(q.plainVerify, 'pre-policy')
  assert.equal(q.uncertain, false, 'nothing failed, so nothing is flagged')
  assert.equal(q.demoteActions, false, 'and the shipped action label stays')
  assert.match(qualityNote(legacy), /predates the current verification policy/)
  assert.equal(qualityText(legacy), '', 'no [UNVERIFIED] marker for unchecked history')
  assert.equal(entryRecord({ ...legacy, sha: 'a'.repeat(40) }).breaking, undefined, 'no breaking claim is present here')

  // A current-policy row whose check never ran is not a factual objection: no
  // check failed, so nothing is printed, while the action stays demoted.
  const admitted = { ai: { policy: QUALITY_POLICY_V, manifest: { policy: QUALITY_POLICY_V }, title: 'New', summary: 'New text.', confidence: 'high', breaking: true } }
  const qa = qualityOf(admitted)
  assert.equal(qa.verify, 'unchecked')
  assert.equal(qa.uncertain, false, 'a missing verdict prints no objection')
  assert.equal(qa.demoteActions, true, 'but an unconfirmed action is still demoted')
  assert.equal(qa.confidence, 'medium', 'an unchecked high-confidence row is capped')
  assert.equal(qualityText(admitted), '', 'and nothing is displayed for it')

  // A recorded negative verdict is loud whatever the policy version.
  for (const [status, pattern] of [['flagged', /objected/]]) {
    const bad = { ai: { title: 'T', summary: 'S.', verify: status }, eli5: { text: 'P.', verify: status } }
    assert.equal(qualityOf(bad).uncertain, true)
    assert.equal(qualityOf(bad).demoteActions, true)
    assert.match(qualityText(bad), pattern)
  }
  const pending = { ai: { title: 'T', summary: 'S.', verify: 'unavailable', confidence: 'high', breaking: true }, eli5: { text: 'P.', verify: 'unavailable' } }
  assert.equal(qualityOf(pending).uncertain, false, 'an outage is not a factual objection')
  assert.equal(qualityOf(pending).demoteActions, true, 'pending review still cannot promote an action')
  assert.equal(qualityOf(pending).confidence, 'medium')
  assert.match(qualityNote(pending), /review.*pending/)
  assert.equal(qualityText(pending), '')
  pending.ai.ungrounded = ['INVENTED']
  assert.match(qualityText(pending), /INVENTED/, 'real objections remain visible during an outage')
  assert.equal(qualityStatus({ verify: 'passed', policy: QUALITY_POLICY_V }), 'stale', 'a passed verdict with no bound hash is not current')
  assert.equal(qualityStatus({ verify: 'passed', verifyHash: 'deadbeef', title: 'T' }), 'stale', 'and a hash that no longer matches is stale')
})

test('R6: overlapping objections collapse and long lists are cut to a readable budget', async t => {
  // The verifier reports the same objection as a sentence and again as the quote
  // inside it, which printed a 1,140-character block twice on one card.
  const claims = [
    { claim: 'The title says the bump ships with ad-request update, which the diff does not show.' },
    { claim: 'with ad-request update' },
    { claim: 'The summary claims a publish step that the diff does not demonstrate.' },
    { claim: 'The summary claims a publish step that the diff does not demonstrate, and names files the diff omits.' }
  ]
  const deduped = dedupeClaims(claims)
  assert.equal(deduped.length, 3, 'the quoted duplicate is dropped, distinct objections stay')
  assert.ok(!deduped.some(c => c.claim === 'with ad-request update'), 'the bare quote is the one removed')
  assert.equal(dedupeClaims([{ claim: 'LIMIT' }, { claim: 'The LIMIT constant now defaults to two.' }]).length, 2,
    'a bare identifier objection is not swallowed by a sentence that mentions it')

  const many = { ai: { title: 'T', summary: 'S.', verify: 'flagged', verifyClaims: Array.from({ length: 6 }, (_, i) => ({ claim: ('objection ' + i + ' ') + 'x'.repeat(200) })) } }
  const full = qualityOf(many).warnings.join(' ')
  const shown = qualityText(many, { max: 600 })
  assert.ok(shown.length < full.length, 'the export copy is shorter than the full objection list')
  assert.ok(shown.includes('more objection'), 'and it says how many were left out')
  assert.equal(qualityOf(many).warnings.length, 7, 'the full list stays available to readers who want it')

  const doc = {
    version: 1, repo: 'https://github.com/CodebuffAI/freebuff', generatedAt: '2026-09-30T00:00:00Z',
    headSha: 'f'.repeat(40), counts: { commitsScanned: 1, entries: 1, syncEra: 1, community: 0 },
    entries: [{
      kind: 'sync', sha: 'c'.repeat(40), url: 'https://example.test/c', date: '2026-09-30T09:00:00Z',
      areas: ['CLI'], modelChanges: null, cmdChanges: null, category: 'CLI', significance: 'minor',
      files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: [], removed: [], renamed: [], modified: ['cli/x.ts'] },
      stats: { additions: 1, deletions: 0 }, facts: [], summary: 'Bump.', title: 'Bump.', day: '2026-09-30', month: '2026-09',
      ai: { title: 'Bump.', summary: 'Bump.', verify: 'flagged', confidence: 'low', verifyClaims: Array.from({ length: 6 }, (_, i) => ({ claim: ('objection ' + i + ' ') + 'y'.repeat(300) })) },
      eli5: { text: 'A plain line.' }
    }]
  }
  const dist = await mkdtemp(join(tmpdir(), 'fb-card-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  await buildSite({ changelog: doc, openPrs: [], dist })
  const html = await readFile(join(dist, 'day', '2026-09-30', 'index.html'), 'utf8')
  assert.ok(!html.includes('[UNVERIFIED]'), 'no unverified marker is stamped on the card')
  assert.ok(!html.includes('[LOW CONFIDENCE]'), 'and a low self-rating is not stamped either')
  assert.ok(!html.includes('class="badge lowc"'), 'with no leftover styling for the removed badge')
  assert.equal(entryRecord(doc.entries[0]).confidence, 'low', 'but the rating stays in the machine-readable record')
  assert.ok(html.includes('(7 objections)'), 'the Evidence toggle says how many objections sit behind it')
  const body = html.slice(html.indexOf('<div class="evidence-body">'))
  assert.ok(body.includes('y'.repeat(300)), 'every objection is in the Evidence block, in full')
  assert.ok(body.includes('objection 5'), 'including the ones the card used to leave out')
})

test('R8: a release roll-up is checked against its window, not the bump diff', async t => {
  const mk = (sha, over = {}) => ({
    sha, date: '2026-09-30T00:00:00Z', day: '2026-09-30', kind: 'sync', significance: 'notable', category: 'CLI',
    files: { total: 1, meaningful: 1, added: [], removed: [], modified: ['cli/src/utils/client-environment.ts'] },
    stats: { additions: 4, deletions: 1 }, ...over
  })
  const member = mk('d'.repeat(40), { ai: { title: 'Ad metadata', summary: 'Ad and run requests now carry the terminal descriptor.', verify: 'passed' } })
  const unchecked = mk('e'.repeat(40), { ai: { title: 'Unchecked history', summary: 'An older change with no verdict recorded.' } })
  const flagged = mk('f'.repeat(40), { ai: { title: 'Flagged', summary: 'Its claims were objected to.', verify: 'flagged' } })
  const bump = mk('a'.repeat(40), { version: '0.2.1', files: { total: 1, meaningful: 1, added: [], removed: [], modified: ['package.json'] }, stats: { additions: 1, deletions: 1 } })
  const ctx = collectReleaseContext([member, unchecked, flagged, bump], bump)
  const text = formatReleaseContext(ctx, bump)
  // The window is the roll-up's evidence: a member that was never checked is
  // history to describe, while one a check discredited stays out.
  assert.ok(text.includes('Ad metadata'), 'a verified member is listed')
  assert.ok(text.includes('Unchecked history'), 'never-checked history is not dropped from the window')
  assert.ok(!text.includes('Flagged'), 'a discredited member is still excluded')
  assert.equal(ctx.dropped, 1)
  assert.ok(text.includes('client-environment.ts'), 'and each line names the files that change touched')

  // A roll-up is framed as one, so the verifier is not asked to find shipped
  // features inside a package.json hunk.
  const patch = 'diff --git a/package.json b/package.json\n-  "version": "0.2.0"\n+  "version": "0.2.1"\n'
  const clean = { title: 'Freebuff release 0.2.1', summary: 'This release adds ad metadata.' }
  const rollupPrompt = buildVerifyPrompt(bump, text, clean, [], { rollup: true })
  assert.match(rollupPrompt, /release roll-up/, 'the framing names the row kind')
  assert.match(rollupPrompt, /Release window \(the changes this release shipped\)/)
  assert.match(rollupPrompt, /Ad metadata/, 'the window is the evidence it checks against')
  assert.ok(!/against the diff it describes/.test(rollupPrompt), 'and it is not told to judge the bump diff')
  const plainPrompt = buildVerifyPrompt(bump, patch, clean)
  assert.match(plainPrompt, /against the diff it describes/, 'ordinary rows keep the diff framing')
  assert.ok(!/release roll-up/.test(plainPrompt))

  // End to end: the verifier the writer actually calls sees that window.
  const dir = await temp(t)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    if (/You are checking/.test(p)) {
      seen.push(p)
      // Cover every published sentence, or the verdict is incomplete and the row
      // is flagged with a repair loop instead of passing once.
      return response({ supported: true, issues: [], claims: [{ quote: 'Freebuff release 0.2.1', supported: true }, { quote: 'This release adds ad metadata.', supported: true }] })
    }
    return response({ title: 'Freebuff release 0.2.1', summary: 'This release adds ad metadata.', significance: 'major', confidence: 'high' })
  })
  await summarizeEntry({ entry: bump, patch, relText: text, env, dataDir: dir })
  assert.equal(seen.length, 1, 'the row was verified once')
  assert.match(seen[0], /release roll-up/)
  assert.match(seen[0], /Ad metadata/, 'the member list is in the verifier material')
})

test('release quality: mixed releases carry their window and own hunks into both passes', () => {
  const member = { ...entry(), sha: 'c'.repeat(40), title: 'Older change', summary: 'Earlier terminal behavior changed.' }
  const bump = { ...entry(), freebuffVersion: '0.2.9', files: { meaningful: 17, added: [], removed: [], renamed: [], modified: ['freebuff/cli/release/package.json', 'a.ts'] }, stats: { additions: 1193, deletions: 105 }, structured: { testNames: ['strips terminal escape sequences from command output before it is drawn'] } }
  const hit = getReleaseContextFor([member, bump], bump)
  assert.match(hit.text, /Older change/)
  const p = buildEli5Prompt(bump, [], { releaseCtx: hit.text, patch })
  assert.match(p, /export const LIMIT = 2/)
  const delivered = deliveredEvidence(p)
  assert.match(delivered, /Older change/)
  assert.match(delivered, /export const LIMIT = 2/, 'the roll-up checker must receive nonempty evidence')
  const pure = { ...bump, files: { meaningful: 1, added: [], modified: ['freebuff/cli/release/package.json'] }, stats: { additions: 1, deletions: 1 } }
  assert.match(deliveredEvidence(buildEli5Prompt(pure, [], { releaseCtx: hit.text })), /Older change/, 'a pure bump must not lose its window before the evidence boundary')
  assert.match(deterministicSummary(bump), /Changed test assertions cover.*strips terminal escape/)
  assert.match(deterministicSummary(bump), /not a live rollout confirmation/)
})

test('release quality: a functional release rejects packaging boilerplate without rejecting concrete changes', () => {
  const validate = summaryValidator('major', '', null, { release: true })
  for (const summary of ['Freebuff CLI release 0.2.9 published. New files: `sdk/src/tools/pinned-fetch.ts`.', 'The version field advanced from 0.2.8 to 0.2.9. No other runtime changes are visible.']) {
    assert.equal(releaseBoilerplate(summary), true)
    assert.throws(() => validate({ title: 'Freebuff release', summary }), /Release summary/)
  }
  assert.doesNotThrow(() => validate({ title: 'Safer terminal output', summary: 'Terminal output now strips escape sequences before rendering.' }))
})

test('provider rate limit: invalid settings cannot disable or exceed the provider RPM contract', () => {
  // The cap is the project provider's account limit (VyceAI, 40 RPM). Whatever
  // it is, no configuration may raise it, and none may disable it.
  for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity', '41', '1000']) assert.equal(llmRpm({ CHANGELOG_LLM_RPM: value }), 40)
  assert.equal(llmRpm({ CHANGELOG_LLM_RPM: '30' }), 30)
  assert.equal(llmRpm({ CHANGELOG_LLM_RPM: '1.5' }), 1)
})

test('provider rate limit: a route that states its own rate is bounded by it, not by the 40 RPM contract', () => {
  // A stage can be pointed at a different provider with a different plan (the
  // daily roll-up runs on one at 20/minute). Its number is its ceiling: it must
  // not read as VyceAI's 40, and VyceAI's ceiling must not be applied to it.
  assert.equal(llmRpm({ LLM_RPM: '20', CHANGELOG_LLM_RPM: '40' }), 20)
  assert.equal(llmRpm({ LLM_RPM: '90', CHANGELOG_LLM_RPM: '40' }), 90)
  for (const value of ['', '0', '-1', 'NaN', 'Infinity']) {
    assert.equal(llmRpm({ LLM_RPM: value, CHANGELOG_LLM_RPM: '40' }), 40, `an unusable ${JSON.stringify(value)} falls back to the contract`)
  }
  assert.equal(llmRpm({ LLM_RPM: '1.9' }), 1)
  // The quota numbers beside it: unset or invalid means "no limit of that kind".
  assert.equal(llmCapOf(undefined), Infinity)
  assert.equal(llmCapOf(''), Infinity)
  assert.equal(llmCapOf('0'), Infinity)
  assert.equal(llmCapOf('-3'), Infinity)
  assert.equal(llmCapOf('nope'), Infinity)
  assert.equal(llmCapOf('2500'), 2500)
})

test('provider rate limit: hourly and daily quotas are rolling windows, and an exhausted one names its number', async () => {
  let now = 0
  const waits = []
  const limiter = createLlmRateLimiter({ now: () => now, wait: async ms => { waits.push(ms); now += ms } })
  const hour = { LLM_RPM: '60', LLM_MAX_PER_HOUR: '3' }
  await limiter.reserve(hour); await limiter.reserve(hour); await limiter.reserve(hour)
  assert.deepEqual(waits, [], 'three of three fit in the hour, so the minute window is not what binds')
  now = 3300000 // 55 minutes in: the oldest request is about to age out of the hour
  await limiter.reserve(hour)
  assert.deepEqual(waits, [300010], 'it waited for the hour to roll, not for a fresh minute')

  // A quota whose next slot is further away than any caller wants to sleep
  // throws its own number instead of going quiet for the rest of the window.
  const refuseToWait = async () => { throw new Error('a whole window is not a throttle') }
  const exhausted = createLlmRateLimiter({ now: () => 0, wait: refuseToWait })
  await exhausted.reserve({ LLM_MAX_PER_HOUR: '3' })
  await exhausted.reserve({ LLM_MAX_PER_HOUR: '3' })
  await exhausted.reserve({ LLM_MAX_PER_HOUR: '3' })
  await assert.rejects(exhausted.reserve({ LLM_MAX_PER_HOUR: '3' }), /hourly budget exceeded \(3\/hour/)
  const day = createLlmRateLimiter({ now: () => 0, wait: refuseToWait })
  await day.reserve({ LLM_MAX_PER_DAY: '2' })
  await day.reserve({ LLM_MAX_PER_DAY: '2' })
  await assert.rejects(day.reserve({ LLM_MAX_PER_DAY: '2' }), /daily budget exceeded \(2\/day/)
})

test('provider rate limit: two base URLs are two providers and never spend one window', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ ok: true }))
  const a = { ...env, LLM_API_BASE: 'https://a.test/v1', CHANGELOG_LLM_RPM: '1' }
  const b = { ...env, LLM_API_BASE: 'https://b.test/v1', CHANGELOG_LLM_RPM: '1' }
  await callLlm('first on a', a, 1, x => x)
  // a's minute is spent, but b has its own window.
  await callLlm('first on b', b, 1, x => x)
  await assert.rejects(callLlm('second on a', { ...a, LLM_DEADLINE_AT: Date.now() + 500 }, 1, x => x), /deadline/, 'and a\'s own window still holds its next call')
})

test('provider rate limit: concurrent stages and retries share a rolling minute and throttle pause', async () => {
  const cap = llmRpm({}) // the provider contract, whatever it is
  let now = 0
  const waits = [], starts = []
  const limiter = createLlmRateLimiter({ now: () => now, wait: async ms => { waits.push(ms); now += ms } })
  // One request past the cap: it cannot start in the same rolling minute.
  await Promise.all(Array.from({ length: cap + 1 }, async () => { starts.push(await limiter.reserve({ CHANGELOG_LLM_RPM: '999' })) }))
  assert.deepEqual(waits, [60010])
  starts.sort((a, b) => a - b)
  for (let i = 0; i < starts.length; i++) assert.ok(starts.filter(at => at >= starts[i] && at < starts[i] + 60000).length <= cap)
  assert.equal(now, 60010)
  limiter.deferUntil(now + 120000)
  await limiter.reserve()
  assert.equal(waits.at(-1), 120000)
  assert.equal(now, 180010, 'the pause applies to every worker, not only the 429 caller')
})

test('provider rate limit: expired deadlines do not acquire slots and HTTP-date Retry-After is honored', async () => {
  const limiter = createLlmRateLimiter()
  await assert.rejects(limiter.reserve({ LLM_DEADLINE_AT: Date.now() - 1 }), /deadline/)
  const now = Date.parse('2026-10-01T12:00:00Z')
  assert.equal(retryAfterMs('120', now), 120000)
  assert.equal(retryAfterMs('Thu, 01 Oct 2026 12:02:00 GMT', now), 120000)
  for (const value of [null, '', 'invalid', 'Thu, 01 Oct 2026 11:59:00 GMT']) assert.equal(retryAfterMs(value, now), 0)
})

test('provider rate limit: real request paths cannot give another stage or retry a fresh quota', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ ok: true }) })
  const limited = { ...env, CHANGELOG_LLM_RPM: '1', LLM_DEADLINE_AT: Date.now() + 1000 }
  await callLlm('writer', limited, 1, x => x)
  for (const stage of ['verification', 'plain-English', 'map', 'fuse']) await assert.rejects(callLlm(stage, limited, 1, x => x, { stage }), /deadline/)
  assert.equal(calls, 1)
  resetLlmRateLimiterForTests()
  calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('timeout', { status: 504 }) })
  await assert.rejects(callLlm('writer', limited, 4, x => x, { leanPrompt: 'retry' }), /deadline/)
  assert.equal(calls, 1, 'a retry must acquire a slot in the same rolling window')
})

test('provider rate limit: startup handoffs and exhausted 429 responses pause later calls', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('throttle', { status: 429, headers: { 'retry-after': '120' } }) })
  await assert.rejects(callLlm('writer', { ...env, CHANGELOG_LLM_RPM_WARMUP: '1', LLM_DEADLINE_AT: Date.now() + 1000 }, 1, x => x), /deadline/)
  assert.equal(calls, 0, 'the quiet handoff cannot be bypassed to fit a deadline')
  await assert.rejects(callLlm('writer', env, 4, x => x), /HTTP 429/)
  await assert.rejects(callLlm('reviewer', { ...env, LLM_DEADLINE_AT: Date.now() + 1000 }, 1, x => x), /deadline/)
  assert.equal(calls, 1, 'another stage respects the exhausted request’s provider-wide pause')
})

test('backup route helpers: configuration gate, route-failure classification, served model', () => {
  assert.equal(backupEnvOf({}), null, 'no config means no failover')
  assert.equal(backupEnvOf({ LLM_BACKUP_API_BASE: 'x', LLM_BACKUP_API_KEY: 'k', CHANGELOG_LLM_BACKUP: '0' }), null, 'opt-out wins')
  const b = backupEnvOf({ LLM_API_BASE: 'p', LLM_API_KEY: 'pk', LLM_MODEL: 'm', LLM_BACKUP_API_BASE: 'x', LLM_BACKUP_API_KEY: 'k', LLM_BACKUP_MODEL: 'flash' })
  assert.equal(b.LLM_API_BASE, 'x'); assert.equal(b.LLM_API_KEY, 'k'); assert.equal(b.LLM_MODEL, 'flash'); assert.equal(b.LLM_ROUTE, 'backup')
  assert.equal(backupEnvOf({ LLM_BACKUP_API_BASE: 'x', LLM_BACKUP_API_KEY: 'k' }).LLM_MODEL, undefined, 'without a backup model the configured one rides along')
  for (const msg of ['LLM HTTP 504: x', 'fetch failed', 'socket hang up', 'The operation was aborted due to timeout', 'LLM HTTP 429: retry-after 120s exceeds the in-call wait budget', 'LLM answered from model memory on every ask (deterministic content failure): The latest Claude Opus model I know about is Claude Opus 4.1']) assert.equal(isRouteFailure(new Error(msg)), true, msg)
  for (const msg of ['LLM HTTP 401: bad key', 'LLM HTTP 400: bad request', 'LLM output missing title', 'LLM returned no JSON', 'LLM cycle deadline exceeded', 'LLM entry request budget exceeded', 'LLM refused the request on every ask (deterministic content failure): I cannot share instructions']) assert.equal(isRouteFailure(new Error(msg)), false, msg)
  assert.equal(servedModelOf([{ stage: 'generation', model: 'flash', route: 'backup', outcome: 'validated' }], 'primary'), 'flash', 'the model that actually wrote wins')
  assert.equal(servedModelOf([{ stage: 'generation', model: 'primary', outcome: 'validated' }, { stage: 'verification', model: 'flash', route: 'backup', outcome: 'validated' }], 'primary'), 'primary', 'a backup verifier never claims the writer')
  assert.equal(servedModelOf([{ stage: 'generation', model: 'strong', outcome: 'validated' }], 'flash'), 'strong', 'the last successful write wins after escalation')
  assert.equal(servedModelOf([], 'primary'), 'primary')
})

test('backup route: a primary gateway failure fails over once with the backup identity', async t => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init.body))
    seen.push({ url: String(url), model: body.model, auth: init.headers.authorization })
    if (String(url).includes('primary.test')) return new Response('gateway timeout', { status: 504 })
    return response({ ok: true })
  })
  const be = { ...env, LLM_API_BASE: 'https://primary.test/v1', LLM_BACKUP_API_BASE: 'https://backup.test/v1', LLM_BACKUP_API_KEY: 'backup-key', LLM_BACKUP_MODEL: 'deepseek-v4.1-flash' }
  const out = await callLlm('prompt', be, 4, x => x, { gatewayRetries: 0 })
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(seen.map(s => s.url), ['https://primary.test/v1/chat/completions', 'https://backup.test/v1/chat/completions'])
  assert.equal(seen[1].model, 'deepseek-v4.1-flash', 'the backup model serves the failover call')
  assert.equal(seen[1].auth, 'Bearer backup-key', 'the backup key never mixes with the primary route')
})

test('backup route: auth failures stay on the primary; opt-out disables failover', async t => {
  const seen = []
  let status = 401
  t.mock.method(globalThis, 'fetch', async url => { seen.push(String(url)); return new Response(status === 401 ? 'bad key' : 'gateway timeout', { status }) })
  const be = { ...env, LLM_API_BASE: 'https://primary.test/v1', LLM_BACKUP_API_BASE: 'https://backup.test/v1', LLM_BACKUP_API_KEY: 'backup-key' }
  await assert.rejects(callLlm('prompt', be, 1, x => x), /HTTP 401/)
  assert.deepEqual(seen, ['https://primary.test/v1/chat/completions'], 'a broken key must surface on the route that owns it')
  seen.length = 0
  status = 504
  await assert.rejects(callLlm('prompt', { ...be, CHANGELOG_LLM_BACKUP: '0' }, 4, x => x, { gatewayRetries: 0 }), /HTTP 504/)
  assert.deepEqual(seen, ['https://primary.test/v1/chat/completions'], 'opt-out never reaches the backup')
})

test('backup route: never loops, and a double failure names both routes', async t => {
  let primary = 0, backup = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('primary.test')) { primary++; return new Response('x', { status: 504 }) }
    backup++; return new Response('y', { status: 504 })
  })
  const be = { ...env, LLM_API_BASE: 'https://primary.test/v1', LLM_BACKUP_API_BASE: 'https://backup.test/v1', LLM_BACKUP_API_KEY: 'backup-key', LLM_BACKUP_MODEL: 'deepseek-v4.1-flash' }
  await assert.rejects(callLlm('prompt', be, 4, x => x, { gatewayRetries: 0 }), /LLM HTTP 504; backup route: LLM HTTP 504/)
  assert.equal(primary, 1, 'one primary ask')
  assert.equal(backup, 1, 'exactly one failover, never a second')
})

test('backup route: provenance records which route served each request and the writing model', async t => {
  const dir = await temp(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('primary.test')) throw new Error('fetch failed')
    const p = JSON.parse(String(init.body)).messages.at(-1).content
    if (/You are checking/.test(p)) return response({ supported: true, issues: [], claims: [
      { quote: 'Limit capped', supported: true },
      { quote: 'Caps the limit to prevent runaway requests.', supported: true }
    ] })
    return response({ title: 'Limit capped', summary: 'Caps the limit to prevent runaway requests.', significance: 'minor', confidence: 'high' })
  })
  const be = { ...env, LLM_API_BASE: 'https://primary.test/v1', LLM_BACKUP_API_BASE: 'https://backup.test/v1', LLM_BACKUP_API_KEY: 'backup-key', LLM_BACKUP_MODEL: 'deepseek-v4.1-flash' }
  const { record } = await summarizeEntry({ entry: entry(), patch, env: be, dataDir: dir })
  assert.equal(record.model, 'deepseek-v4.1-flash', 'the failover write is attributed to the model that wrote it')
  assert.equal(record.verify, 'passed', 'the verifier failed over too')
  assert.ok(record.requests.some(r => r.route === 'primary' && r.outcome === 'transport-error'), 'failed primary attempts stay visible')
  assert.ok(record.requests.some(r => r.route === 'backup' && r.outcome === 'validated' && r.stage === 'verification'), 'the serving backup call is recorded')
  assert.ok(calls.filter(u => u.includes('backup.test')).length >= 2, 'writer and verifier each failed over')
})

test('release regression: unchanged packaging fields cannot satisfy a functional roll-up', () => {
  const summary = 'The version literal in freebuff/cli/release/package.json moved from 0.2.10 to 0.2.11, marking publication of the Freebuff CLI 0.2.11 release line. All packaging fields (bin, scripts, files, os, cpu, engines, prepack/postpack) remain unchanged from the prior release.'
  assert.equal(releaseBoilerplate(summary), true)
  const validate = summaryValidator('notable', '', null, { release: true })
  assert.throws(() => validate({ title: 'Freebuff release', summary }), /Release summary/)
  assert.throws(() => validate({ title: 'Freebuff release', summary, changes: [{ area: 'packaging', what: 'All packaging fields remain unchanged.' }] }), /Release summary/)
  assert.doesNotThrow(() => validate({ title: 'Deferred updates', summary: 'The launcher adopts staged updates left behind when a terminal closes.' }))
})

test('release regression: sparse scope does not authorize reliability or configuration promises', () => {
  for (const text of ['The program now starts more reliably.', 'It picks up configuration values more consistently.']) {
    assert.throws(() => normalizeEli5(text, ELI5_ROLLUP_MAX_CHARS, { allow: 'CLI changes across 4 files.' }), /marketing language/)
  }
  assert.equal(normalizeEli5('The program now starts more reliably.', ELI5_ROLLUP_MAX_CHARS, { allow: 'The program now starts more reliably.' }), 'The program now starts more reliably.')
})

test('release regression: both writers and reviewers receive member source, not unchanged package guides', async () => {
  const member = { ...entry(), sha: 'c'.repeat(40), ai: { title: 'Unchecked launcher', summary: 'Guaranteed reliability.', verify: 'unavailable' }, files: { meaningful: 1, added: [], modified: ['cli/launcher.js'], removed: [], renamed: [] }, stats: { additions: 1, deletions: 1 } }
  const bump = { ...entry(), freebuffVersion: '0.2.11', files: { meaningful: 1, modified: ['freebuff/cli/release/package.json'] }, stats: { additions: 1, deletions: 1 } }
  const hit = getReleaseContextFor([member, bump], bump)
  const memberPatch = 'diff --git a/cli/launcher.js b/cli/launcher.js\n+await adoptOrphanedStagedUpdates()\n'
  const releaseEvidence = await gatherReleaseEvidence(hit, [member, bump], async () => memberPatch)
  const context = { releaseEvidence, subsystemDocs: [{ path: 'README.md', content: 'Background claim: unlimited models.' }] }
  for (const prompt of [buildPrompt(bump, patch, { ...context, releaseCtx: hit.text }), buildEli5Prompt(bump, [], { ...context, releaseCtx: hit.text })]) {
    const material = deliveredEvidence(prompt)
    assert.match(material, /adoptOrphanedStagedUpdates/)
    assert.match(material, /scope only; behavior requires source evidence/)
    assert.doesNotMatch(material, /Guaranteed reliability|unlimited models/)
  }
  assert.match(await gatherReleaseEvidence(hit, [member, bump], async () => ''), /partial evidence/)
  assert.match(await gatherReleaseEvidence(hit, [member, bump], async () => memberPatch, { maxChars: 50 }), /partial evidence/)
  const flagged = { ...member, ai: { ...member.ai, verify: 'flagged', summary: 'Rejected unlimited access claim.' } }
  const flaggedHit = getReleaseContextFor([flagged, bump], bump)
  assert.equal(flaggedHit.ctx.items.length, 0, 'rejected prose is excluded')
  const source = await gatherReleaseEvidence(flaggedHit, [flagged, bump], async () => memberPatch)
  assert.match(source, /adoptOrphanedStagedUpdates/, 'rejecting prose must not erase the underlying change')
  assert.doesNotMatch(source, /Rejected unlimited access/)
})

test('completion: text, exact-text review and complete evidence are separate requirements', () => {
  const e = entry()
  assert.deepEqual(generationState(e), { status: 'missing', missing: ['summary', 'plain-English'] })
  e.ai = { policy: 1, title: 'Limit changed', summary: 'The internal limit changed.', verify: 'unavailable' }
  e.eli5 = { policy: 1, text: 'An internal limit changed.', verify: 'unavailable' }
  assert.equal(generationState(e).status, 'review-pending')
  e.ai.verify = e.eli5.verify = 'passed'
  e.ai.verifyHash = artifactHash(e.ai); e.eli5.verifyHash = artifactHash(e.eli5)
  assert.equal(generationState(e).status, 'complete')
  e.ai.manifest = { partial: true }
  assert.equal(generationState(e).status, 'needs-repair')
  delete e.ai.manifest
  e.eli5.text = 'Invented replacement.'
  assert.equal(generationState(e).status, 'needs-repair', 'a stale plain-English verdict is not completion')
  assert.equal(generationState({ ...e, noise: true }).status, 'not-required')
})

test('regeneration completion: a deliberately disabled verifier is not a failed repair', () => {
  const fresh = {
    ...entry(),
    ai: { policy: QUALITY_POLICY_V, title: 'Limit changed', summary: 'The internal limit changed.', manifest: { policy: QUALITY_POLICY_V } },
    eli5: { policy: QUALITY_POLICY_V, text: 'An internal limit changed.', manifest: { policy: QUALITY_POLICY_V } }
  }
  // Verifier off: no verdict was requested, so this is the finished state.
  assert.equal(generationState(fresh).status, 'review-pending')
  assert.deepEqual(regenUnfinished([fresh], { verify: false }), [])
  // Verifier on: the same row still owes its exact-text read.
  assert.deepEqual(regenUnfinished([fresh], { verify: true }), [fresh])
  // Real defects fail the run either way.
  const partialEvidence = { ...fresh, ai: { ...fresh.ai, manifest: { policy: QUALITY_POLICY_V, partial: true } } }
  const noText = { ...fresh, ai: { ...fresh.ai, summary: '' } }
  assert.deepEqual(regenUnfinished([partialEvidence, noText], { verify: false }), [partialEvidence, noText])
})

test('verification: a 504 takes one different framing, preserving all evidence and coverage', async t => {
  const clean = { title: 'Limit changed', summary: 'The limit changed.', audience: 'maintainers', userVisible: false }
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    seen.push(p)
    if (seen.length === 1) return new Response('gateway timeout', { status: 504 })
    return response({ supported: true, issues: [], claims: [clean.title, clean.summary, clean.audience, 'userVisible: false'].map(quote => ({ quote, supported: true })) })
  })
  assert.equal((await verifySummary(entry(), patch, clean, env)).supported, true)
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
  assert.ok(seen[1].length < seen[0].length)
  assert.match(seen[1], /export const LIMIT = 2/)
  assert.match(seen[1], /userVisible/)
})

test('verification: release context-key changes cannot strand the shipped artifact or resurrect old prose', async t => {
  const dir = await temp(t)
  const e = { ...entry(), freebuffVersion: '0.2.9', enrichment: { policy: 1 } }
  const material = 'Updates included in this release: original source evidence\n' + patch
  const record = { model: 'writer', v: PROMPT_V, policy: 1, title: 'Internal limit updated', summary: 'The limit changed.', verify: 'unavailable', verifyPolicy: VERIFY_POLICY_V, evidenceBundle: { material, hash: shortHash(material) }, rollup: RELEASE_ROLLUP_V - 1, at: '2020-01-01T00:00:00Z' }
  e.ai = { ...record }
  const oldKey = cacheKey(e.sha, patch, 'old release window', RELEASE_ROLLUP_V - 1)
  const unrelated = { ...record, title: 'Discarded prose' }
  await writeJson(join(dir, 'ai-summaries.json'), { [cacheKey(e.sha, patch, 'different window', 1)]: unrelated, [oldKey]: record })
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    seen.push(p)
    assert.match(p, /You are checking a release roll-up/)
    assert.match(p, /original source evidence/)
    assert.doesNotMatch(p, /Discarded prose/)
    return response({ supported: true, issues: [], claims: [record.title, record.summary].map(quote => ({ quote, supported: true })) })
  })
  await enrichWithLlm([e], async () => patch, dir, { ...env, CHANGELOG_LLM_HEAL: '0', CHANGELOG_LLM_LIMIT: '2' })
  assert.equal(seen.length, 1)
  assert.equal(e.ai.title, record.title)
  assert.equal(e.ai.verify, 'passed')
})

test('verification: corrupted original evidence cannot authorize a changed-key verdict', async t => {
  const dir = await temp(t)
  const e = { ...entry(), enrichment: { policy: 1 }, ai: { model: 'writer', v: PROMPT_V, title: 'Internal limit updated', summary: 'The limit changed.', verify: 'unavailable', verifyPolicy: VERIFY_POLICY_V, at: '2020-01-01T00:00:00Z', evidenceBundle: { material: patch, hash: 'corrupt' } } }
  await writeJson(join(dir, 'ai-summaries.json'), { [cacheKey(e.sha, patch, 'old context', 1)]: e.ai })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected provider call') })
  await enrichWithLlm([e], async () => patch, dir, { ...env, CHANGELOG_LLM_HEAL: '0' })
  assert.equal(calls, 0)
  assert.equal(e.ai.verify, 'unavailable')
})

test('reader disclosure: a pending check is one quiet note, not duplicated objections', () => {
  const e = { ...entry(), files: { added: [], modified: ['a.ts'], removed: [], renamed: [], total: 1 }, stats: { additions: 1, deletions: 1 }, ai: { title: 'Internal limit updated', summary: 'The limit changed.', evidence: 'a.ts', verify: 'unavailable' } }
  const html = entryCard(e)
  assert.doesNotMatch(html, /verifier check could not run|claims are unverified|\[LOW CONFIDENCE\]|class="badge lowc"|objections/)
  assert.equal((html.match(/Automated review is pending/g) || []).length, 1)
  assert.equal(entryRecord(e).quality.reviewPending, true)
  e.ai.verify = 'flagged'; e.ai.verifyClaims = [{ claim: 'Unsupported limit promise' }]
  assert.match(entryCard(e), /Unsupported limit promise/)
})

test('release evidence: a verifier outage uses mechanical member facts, never unchecked AI prose', () => {
  const member = { ...entry(), title: 'Source changed', summary: 'File updated.', files: { total: 1, meaningful: 1, added: [], modified: ['a.ts'], removed: [], renamed: [] }, stats: { additions: 1, deletions: 1 }, ai: { title: 'Unlimited access', summary: 'Everyone gets unlimited access.', verify: 'unavailable' } }
  const bump = { ...entry(), sha: 'd'.repeat(40), freebuffVersion: '0.2.9' }
  const ctx = collectReleaseContext([member, bump], bump)
  const text = formatReleaseContext(ctx, bump)
  assert.equal(ctx.dropped, 0)
  assert.match(text, /Source changed/)
  assert.doesNotMatch(text, /unlimited/i)
})

test('plain-English repair: replacement ships only after an exact-text passing check', async t => {
  const dir = await temp(t)
  let checks = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    if (/You are checking/.test(p)) {
      if (++checks === 1) return response({ supported: false, issues: ['Unlimited access is unsupported'], claims: [] })
      return response({ supported: true, issues: [], claims: [{ quote: 'The internal limit changed.', supported: true }] })
    }
    return response({ eli5: /A reviewer found/.test(p) ? 'The internal limit changed.' : 'Everyone gets unlimited access.' })
  })
  const { record } = await explainEntry({ entry: entry(), patch, env, dataDir: dir })
  assert.equal(record.text, 'The internal limit changed.')
  assert.equal(record.verify, 'passed')
  assert.equal(record.verifyHash, artifactHash({ text: record.text }))
})

test('plain-English retry: malformed answers spend verdict tries and a roll-up retains its framing', async t => {
  const dir = await temp(t)
  const e = { ...entry(), freebuffVersion: '0.2.9', enrichment: { policy: 1 }, ai: { model: 'writer', v: PROMPT_V, title: 'Internal limit updated', summary: 'The limit changed.' } }
  const plain = { model: 'writer', v: ELI5_V, policy: 1, text: 'The internal limit changed.', verify: 'unavailable', rollup: RELEASE_ROLLUP_V, src: shortHash(eli5Source(e)), at: '2020-01-01T00:00:00Z', evidenceBundle: { material: patch, hash: shortHash(patch) } }
  e.eli5 = plain
  await writeJson(join(dir, 'ai-summaries.json'), { [eli5Key(e.sha, eli5Source(e))]: plain })
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push(JSON.parse(init.body).messages.at(-1).content)
    return response({ supported: true })
  })
  await enrichEli5([e], dir, env, { getPatch: async () => patch })
  assert.ok(seen.length > 0)
  assert.ok(seen.every(p => /checking a release roll-up/.test(p)))
  assert.equal(e.eli5.verifyTries, 1)
  assert.equal(e.eli5.verifyErrors, undefined)
  assert.match(e.eli5.verifyError, /verifier output/)
})

test('R12/R20: instruction examples and rejected replies cannot authorize names', () => {
  const p = buildPrompt(entry(), patch, { fullFiles: [{ path: 'a.ts', lines: 1, content: 'const SEEN_TOKEN = 2' }] })
  const material = deliveredEvidence(p + '\n\nPrevious output was rejected: BAD_TOKEN\nPrevious output: BAD_TOKEN')
  assert.ok(material.includes('SEEN_TOKEN'))
  assert.ok(material.includes('LIMIT'))
  assert.ok(!material.includes('BAD_TOKEN'))
  assert.ok(!material.includes('FREEBUFF_DEEPSEEK_'))
  const pr = { number: 1, title: 'Title', body: 'Before', comments: [{ body: 'old' }] }
  assert.notEqual(contextFingerprint(pr, ''), contextFingerprint({ ...pr, comments: [{ body: 'new' }] }, ''))
  assert.notEqual(prSummaryKey(pr, patch), prSummaryKey({ ...pr, body: 'After' }, patch))
  assert.notEqual(cacheKey('sha', patch, '', 0, { model: 'a' }), cacheKey('sha', patch, '', 0, { model: 'b' }))
})

test('R5/R13/R17: same-version corrections and event merges are commutative/idempotent', () => {
  const old = { ...entry(), ai: { v: PROMPT_V, title: 'Old', summary: 'Old.', at: '2026-09-29T00:00:00Z' } }
  const newer = { ...entry(), ai: { v: PROMPT_V, title: 'Corrected', summary: 'Corrected.', at: '2026-09-30T00:00:00Z' } }
  const a = { generatedAt: '2026-09-30T01:00:00Z', headSha: 'new-head', entries: [old] }
  const b = { generatedAt: '2026-09-29T01:00:00Z', headSha: 'old-head', entries: [newer] }
  assert.deepEqual(mergeChangelog(a, b), mergeChangelog(b, a))
  assert.equal(mergeChangelog(a, b).entries[0].ai.title, 'Corrected')
  assert.equal(a.entries[0].ai.title, 'Old', 'input snapshots are not mutated')
  const p = { fetchedAt: '2026-09-29', listComplete: true, total: 2, prs: [{ number: 1 }, { number: 2 }] }
  const empty = { fetchedAt: '2026-09-30', listComplete: true, total: 0, prs: [] }
  assert.deepEqual(mergeOpenPrs(p, empty).prs, [])
  assert.deepEqual(mergeOpenPrs(p, empty), mergeOpenPrs(empty, p))
  const x = { events: { a: { day: '2026-09-30', stats: { calls: 2 } } }, days: { '2026-09-30': { calls: 2 } } }
  const y = { events: { b: { day: '2026-09-30', stats: { calls: 3 } } }, days: { '2026-09-30': { calls: 3 } } }
  const merged = mergeHealth(x, y)
  assert.equal(merged.days['2026-09-30'].calls, 5)
  assert.deepEqual(merged, mergeHealth(y, x))
  assert.deepEqual(merged, mergeHealth(merged, x))
})

test('R13: closure alone is not shipped PR intent', () => {
  const p = { number: 9, paths: ['a.ts', 'b.ts'], updated: entry().date }
  const { doc } = rememberClosedPrs([p], [])
  const e = { ...entry(), files: { modified: p.paths } }
  assert.equal(doc.prs[0].closureState, 'unknown')
  assert.equal(matchPrByPaths(e, { prsByNum: new Map([[9, doc.prs[0]]]) }), null)
  assert.equal(matchPrByPaths(e, { prsByNum: new Map([[9, { ...doc.prs[0], merged: true }]]) }).pr.number, 9)
})

test('R13: authoritative refresh clears stale markers and empty discussion survives merge', () => {
  const a = { fetchedAt: '2026-09-29', prs: [{ number: 1, updated: 'revision', hasDiff: true, stalePreview: true, commentsList: [{ body: 'old' }] }] }
  const b = { fetchedAt: '2026-09-30', prs: [{ number: 1, updated: 'revision', hasDiff: true, commentsList: [] }] }
  const merged = mergeOpenPrs(a, b)
  assert.equal(merged.prs[0].stalePreview, undefined)
  assert.deepEqual(merged.prs[0].commentsList, [])
})

test('R5: PR preview versions are not pruned using summary prompt versions', async t => {
  const dir = await temp(t)
  const path = join(dir, 'pr-summaries.json')
  await persistMerged({ [path]: { '1:v2:hash': { title: 'Proposal', summary: 'Proposed.', v: 2 } } })
  assert.equal(JSON.parse(await readFile(path, 'utf8'))['1:v2:hash'].title, 'Proposal')
})

test('R14: path-colliding constants and fact removal are authoritative', async () => {
  const p = patch + '\ndiff --git a/b.ts b/b.ts\n-export const LIMIT = 3\n+export const LIMIT = 4\n'
  assert.deepEqual(extractStructuredFacts(p).constants.map(c => [c.path, c.from, c.to]), [['a.ts', '1', '2'], ['b.ts', '3', '4']])
  const e = { ...entry(), structured: extractStructuredFacts(p) }
  assert.deepEqual((await gatherEntryContext(e, '')).structured.constants, [])
})

test('R10: offline audit records missing rows, checkpoints, and a failing gate without fetch', async t => {
  const dir = await temp(t)
  await writeJson(join(dir, 'eval/golden.json'), { rows: [{ sha: entry().sha }, { sha: 'missing' }] })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('offline audit must not fetch') })
  const report = await runEval([entry()], dir, env)
  assert.equal(report.gate.passed, false)
  assert.equal(report.golden.expected, 2)
  assert.equal(report.golden.skipped, 2)
  const files = await readdir(join(dir, 'eval/results'))
  const saved = JSON.parse(await readFile(join(dir, 'eval/results', files[0]), 'utf8'))
  assert.equal(saved.status, 'complete')
  assert.equal(saved.rows.length, 2)
  await writeJson(join(dir, 'eval/results/future.json'), { at: '2099-01-01', status: 'partial' })
  assert.equal((await latestResult(join(dir, 'eval/results'))).at, report.at)
})

test('R11/R16: durable errors, concurrent atomic checkpoints, and lock exclusion', async t => {
  const cache = { key: { error: 'bad', attempts: 2, at: '2020-01-01' } }
  pruneExpiredErrors(cache)
  assert.equal(cache.key.attempts, 2)
  const dir = await temp(t)
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJson(join(dir, 'state.json'), { i })))
  assert.equal(typeof JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).i, 'number')
  assert.ok(!(await readdir(dir)).some(p => p.endsWith('.tmp')))
  let release, started
  const ready = new Promise(r => { started = r })
  const hold = new Promise(r => { release = r })
  const owner = withLock(join(dir, 'lock'), async () => { started(); await hold })
  await ready
  const contender = await withLock(join(dir, 'lock'), () => assert.fail('lock stolen'))
  assert.equal(contender.acquired, false)
  release(); await owner
})

test('R7/R17: deadlines and empty budgets send no requests and do not inflate call counts', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('budgeted request sent'))
  const before = llmCallCount()
  await assert.rejects(callLlm('prompt', { ...env, LLM_CYCLE_BUDGET: { remaining: 0 } }), /budget/)
  await assert.rejects(callLlm('prompt', { ...env, LLM_DEADLINE_AT: Date.now() - 1 }), /deadline/)
  assert.equal(llmCallCount(), before)
  await assert.rejects(withDeadline(-1, () => git(['--version'], '.')), /deadline/)
})

test('R7: deployed probe detects stale data and wrong uploaded heads', async () => {
  const now = Date.parse('2026-09-30T01:00:00Z')
  const fetchImpl = async () => new Response(JSON.stringify({ generatedAt: '2026-09-30T00:59:00Z', headSha: 'head' }))
  assert.equal((await checkDeployedHead('https://example.invalid', 'head', { fetchImpl, now })).ageMs, 60000)
  await assert.rejects(checkDeployedHead('https://example.invalid', 'wrong', { fetchImpl, now }), /differs/)
  await assert.rejects(checkDeployedHead('https://example.invalid', 'head', { fetchImpl, now: now + 600000 }), /stale/)
})
