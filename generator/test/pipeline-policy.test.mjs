import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  enrichWithLlm, enrichEli5, enrichOpenPrs, validateVerifyOut, verifySummary,
  summarizeEntry, explainEntry, deliveredEvidence, buildPrompt, cacheKey,
  contextFingerprint, callLlm, llmCallCount, PROMPT_V, DEFAULT_VERIFY_MODEL,
  LLM_CONTEXT_TOKENS, rememberClosedPrs, matchPrByPaths, prSummaryKey,
  pruneExpiredErrors, gatherEntryContext
} from '../lib/llm.mjs'
import { artifactHash, qualityOf, qualityText, qualityNote, qualityStatus, dedupeClaims, QUALITY_POLICY_V } from '../lib/quality.mjs'
import { mergeChangelog, mergeOpenPrs, mergeHealth, persistMerged } from '../lib/mergedata.mjs'
import { runEval, latestResult } from '../lib/eval.mjs'
import { writeJson, withLock, withDeadline, git } from '../lib/util.mjs'
import { checkDeployedHead } from '../lib/sync.mjs'
import { entryRecord, discordText, generateReleaseNotesMarkdown, buildSite } from '../lib/site.mjs'
import { extractStructuredFacts } from '../lib/analyze.mjs'

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
  let checks = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    if (/You are checking/.test(p)) {
      if (++checks === 1) return response({ supported: false, issues: ['Original claim lacks support'], claims: [] })
      throw new Error('verifier offline')
    }
    return response({ title: /A reviewer/.test(p) ? 'Replacement title' : 'Limit changed', summary: 'The internal limit changed.', confidence: 'high' })
  })
  const { record } = await summarizeEntry({ entry: entry(), patch, env })
  assert.equal(record.title, 'Limit changed')
  assert.equal(record.verify, 'flagged')
  assert.match(record.verifyClaims[0].claim, /Original claim/)
  assert.notEqual(record.confidence, 'high')
})

test('R4: invented plain-English promises receive a semantic objection', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const p = JSON.parse(init.body).messages.at(-1).content
    return response(/You are checking/.test(p) ? { supported: false, issues: ['Unlimited free access is not in the evidence.'], claims: [] } : { eli5: 'Everyone gets unlimited free access and guaranteed preservation of their work.' })
  })
  const { record } = await explainEntry({ entry: entry(), patch, env })
  assert.equal(record.verify, 'flagged')
  assert.ok(qualityText({ eli5: record }).includes('Unlimited free access'))
  assert.equal(record.verifyHash, undefined)
})

test('R6: exact-text stale verdicts and numeric objections survive exports', () => {
  const ai = { policy: QUALITY_POLICY_V, title: 'Title', summary: 'Before.', confidence: 'high', verify: 'passed' }
  ai.verifyHash = artifactHash(ai)
  ai.summary = 'After.'
  const e = { ...entry(), ai, eli5: { text: 'Unchecked promise.', verify: 'flagged', verifyClaims: [{ claim: 'Unlimited access' }] } }
  assert.equal(qualityOf(e).verify, 'stale')
  assert.equal(entryRecord(e).confidence, 'medium')
  assert.ok(discordText(e).includes('[UNVERIFIED]'))
  assert.ok(generateReleaseNotesMarkdown({ version: '1.0.1' }, [e]).includes('[UNVERIFIED]'))
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

  // A current-policy row whose check never ran is a real gap.
  const admitted = { ai: { policy: QUALITY_POLICY_V, manifest: { policy: QUALITY_POLICY_V }, title: 'New', summary: 'New text.', confidence: 'high', breaking: true } }
  const qa = qualityOf(admitted)
  assert.equal(qa.verify, 'unchecked')
  assert.equal(qa.uncertain, true)
  assert.equal(qa.demoteActions, true)
  assert.equal(qa.confidence, 'medium', 'an unchecked high-confidence row is capped')
  assert.match(qualityText(admitted), /no current verification/)

  // A recorded negative verdict is loud whatever the policy version.
  for (const [status, pattern] of [['flagged', /objected/], ['unavailable', /could not run/]]) {
    const bad = { ai: { title: 'T', summary: 'S.', verify: status }, eli5: { text: 'P.', verify: status } }
    assert.equal(qualityOf(bad).uncertain, true)
    assert.equal(qualityOf(bad).demoteActions, true)
    assert.match(qualityText(bad), pattern)
  }
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
      ai: { title: 'Bump.', summary: 'Bump.', verify: 'flagged', verifyClaims: Array.from({ length: 6 }, (_, i) => ({ claim: ('objection ' + i + ' ') + 'y'.repeat(300) })) },
      eli5: { text: 'A plain line.' }
    }]
  }
  const dist = await mkdtemp(join(tmpdir(), 'fb-card-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  await buildSite({ changelog: doc, openPrs: [], dist })
  const html = await readFile(join(dist, 'day', '2026-09-30', 'index.html'), 'utf8')
  assert.ok(!html.includes('Unverified claims'), 'objections are not printed above the fold')
  assert.ok(html.includes('class="badge lowc"'), 'the badge still signals the entry to a reader')
  assert.ok(html.includes('(7 objections)'), 'and the Evidence toggle says how many are behind it')
  const body = html.slice(html.indexOf('<div class="evidence-body">'))
  assert.ok(body.includes('y'.repeat(300)), 'every objection is in the Evidence block, in full')
  assert.ok(body.includes('objection 5'), 'including the ones the card used to leave out')
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
