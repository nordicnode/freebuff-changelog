import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractStructuredFacts, hasStructuredFacts, formatStructuredFacts, structuredFactsText,
  extractCommentFacts, diffPartPriority, prioritizeDiffParts
} from '../lib/analyze.mjs'
import {
  validateLlmOut, ungroundedIdentifiers, nestedObjectPaths, groundingCorpus, buildPrompt, buildEli5Prompt, isMultiTopic, gaveUp,
  wantsStrongModel, modelFor, formatGlossary, matchPrByPaths, findPrMeta, rememberClosedPrs, diffPaths,
  budgetPatch, structuredFactsCited, PROMPT_V
} from '../lib/llm.mjs'
import { whyVisible, mustMentionFor, scoreRow, aggregate, validateJudgeOut, formatEvalReport } from '../lib/eval.mjs'
import * as llm from '../lib/llm.mjs'

const awaitImport = () => llm
const sha = (c) => c.repeat(40)

const PATCH = `diff --git a/common/src/constants/limits.ts b/common/src/constants/limits.ts
--- a/common/src/constants/limits.ts
+++ b/common/src/constants/limits.ts
@@ -1,6 +1,8 @@
-export const FREEBUFF_LIMITED_OFFER_MAX_SESSIONS = 300
+export const FREEBUFF_LIMITED_OFFER_MAX_SESSIONS = 500
 export const UNCHANGED = 1
-export const REMOVED_EXPORT = 2
+export function newHelper () {}
+const trusted = process.env.CODEBUFF_TRUSTED_AGENT_PUBLISHERS || ''
+const flag = '--trust-agent-dirs'
+// Staff accounts only.
+/**
+ * @param limit Daily cap in cents for advertisers.
+ */
diff --git a/cli/src/__tests__/limits.test.ts b/cli/src/__tests__/limits.test.ts
--- a/cli/src/__tests__/limits.test.ts
+++ b/cli/src/__tests__/limits.test.ts
@@ -1,3 +1,6 @@
+describe('limited offer', () => {
+  it('admits at most five hundred sessions', () => {})
+  test('refuses a second session for the same user', () => {})
+})
+const TEST_ONLY_CONST = 1
+const x = process.env.ONLY_IN_TESTS
`

test('extractStructuredFacts: constants old->new, env vars, flags, exports, test titles; test-file code ignored', () => {
  const s = extractStructuredFacts(PATCH)
  assert.deepEqual(s.constants, [{ name: 'FREEBUFF_LIMITED_OFFER_MAX_SESSIONS', from: '300', to: '500' }])
  assert.deepEqual(s.envVars, ['CODEBUFF_TRUSTED_AGENT_PUBLISHERS'], 'env read inside a test file is not a new input')
  assert.deepEqual(s.flags, ['--trust-agent-dirs'])
  assert.deepEqual(s.exportsAdded, ['newHelper'])
  assert.deepEqual(s.exportsRemoved, ['REMOVED_EXPORT'])
  assert.deepEqual(s.testNames, ['limited offer', 'admits at most five hundred sessions', 'refuses a second session for the same user'])
  assert.ok(hasStructuredFacts(s))
  assert.equal(hasStructuredFacts(extractStructuredFacts('')), false)
  const lines = formatStructuredFacts(s)
  assert.match(lines.join('\n'), /FREEBUFF_LIMITED_OFFER_MAX_SESSIONS: 300 -> 500/)
  assert.match(lines.join('\n'), /Behavior asserted by new tests/)
  assert.ok(structuredFactsText(s).includes('--trust-agent-dirs'))
  assert.equal(structuredFactsCited(s, 'raised FREEBUFF_LIMITED_OFFER_MAX_SESSIONS to 500'), true)
  assert.equal(structuredFactsCited(s, 'nothing named'), false)
  assert.equal(structuredFactsCited(null, 'x'), null)
})

test('extractStructuredFacts: doc mentions, subprocess flags and multi-line openers are not facts', () => {
  const patch = `diff --git a/docs/cli.md b/docs/cli.md
+Set CODEBUFF_API_KEY and pass --agent to pick one.
+export const IN_DOCS = 1
diff --git a/cli/src/a.ts b/cli/src/a.ts
+await git(['rev-parse', '--verify', '--quiet', ref])
+const args = ['npm', 'install', '--force']
-export const LIST = [
+export const LIST = [] as const
+const opt = program.option('--trust-agents', 'x')
`
  const s = extractStructuredFacts(patch)
  assert.deepEqual(s.envVars, [], 'docs do not introduce env vars')
  assert.deepEqual(s.flags, ['--trust-agents'], 'git/npm arguments are not our flags; docs are not code')
  assert.deepEqual(s.constants, [], 'an opening bracket is not a value')
  assert.deepEqual(s.exportsAdded, [], 'exports in docs are prose')
})

test('gaveUp only judges sync rows; hype regex is a stateless predicate', () => {
  assert.equal(gaveUp({ kind: 'community', title: 'Fix the thing', ai: { title: 'Fix the thing' } }), false)
  assert.equal(gaveUp({ kind: 'sync', title: 'CLI update: env', ai: { title: 'CLI update: env' } }), true)
  const { ELI5_HYPE_ROLLUP_RE } = awaitImport()
  assert.equal(ELI5_HYPE_ROLLUP_RE.global, false)
  assert.equal(ELI5_HYPE_ROLLUP_RE.test('smarter'), true)
  assert.equal(ELI5_HYPE_ROLLUP_RE.test('smarter'), true, 'second call must not be poisoned by lastIndex')
})

test('ungroundedIdentifiers: a path inside a URL is not a claimed file', () => {
  assert.deepEqual(ungroundedIdentifiers('See https://github.com/x/y/blob/main/docs/a.md for context.', 'nothing'), [])
})

test('ungroundedIdentifiers: a dotted name is grounded by the object literal that nests it', () => {
  // The shape this comes from: `page.url` is a real property chain the diff
  // writes as `page: { url: page }`, so the dotted string never appears in the
  // corpus verbatim even though the model copied the source faithfully.
  const patch = '+            page: { url: page },\n-            page: { url: `https://freebuff.com${signupPath}` },\nconst signupPath = "/signup"'
  assert.deepEqual(ungroundedIdentifiers('TikTok is told the activation happened on `page.url`.', patch), [], 'nested keys spell out page.url')
  assert.deepEqual(ungroundedIdentifiers('Posts `payload.page.url` as the page.', patch), [], 'a leading segment a reader can infer is tolerated')
  assert.deepEqual(ungroundedIdentifiers('Sends `page.token`.', patch), ['page.token'], 'a path the source does not nest stays flagged')
  const loose = 'const page = 1\nconst o = { url: "x" }'
  assert.deepEqual(ungroundedIdentifiers('Reads `page.url`.', loose), ['page.url'], 'a short tail loose in an unrelated literal cannot ground a made-up path')
  assert.deepEqual([...nestedObjectPaths('page: { user: { id: 1 } }')].sort(), ['page.user', 'page.user.id', 'user.id'])
  assert.deepEqual([...nestedObjectPaths('rows: [ { name: "x" } ]')], ['rows.name'], 'array elements add no segment of their own')
  assert.deepEqual([...nestedObjectPaths('const o = { url: "x" }')], [], 'an unwrapped literal has no chain')
})

test('extractCommentFacts: keeps 20-char sentences and JSDoc tags', () => {
  const facts = extractCommentFacts(PATCH)
  assert.ok(facts.includes('Staff accounts only.'), facts.join(' | '))
  assert.ok(facts.some(f => f.startsWith('limit: Daily cap in cents')), facts.join(' | '))
})

test('diff prioritisation: source before docs before tests before snapshots; budgetPatch cuts the least important first', () => {
  const part = (p, body = 'x') => `diff --git a/${p} b/${p}\n+${body}\n`
  const parts = [part('a/__snapshots__/x.snap', 'S'.repeat(50)), part('README.md'), part('src/a.test.ts'), part('src/a.ts')]
  assert.deepEqual(prioritizeDiffParts(parts).map(p => p.split('\n')[0]), [
    'diff --git a/src/a.ts b/src/a.ts', 'diff --git a/README.md b/README.md', 'diff --git a/src/a.test.ts b/src/a.test.ts', 'diff --git a/a/__snapshots__/x.snap b/a/__snapshots__/x.snap'
  ])
  assert.equal(diffPartPriority(part('dist/bundle.min.js')), 4)
  const out = budgetPatch(parts.join(''), 120, 200)
  assert.ok(out.includes('src/a.ts'), 'the source file survives the budget')
  assert.ok(!out.includes('SSSSSSSS'), 'the snapshot is what gets cut')
})

test('isMultiTopic and the prompt ask for per-topic changes', () => {
  const multi = { areas: ['CLI', 'SDK'], files: { meaningful: 3, added: [], modified: ['a.ts'] }, sha: sha('a'), date: '2026-09-18T00:00:00Z' }
  assert.equal(isMultiTopic(multi), true)
  assert.equal(isMultiTopic({ areas: ['CLI'], files: { meaningful: 3 } }), false)
  assert.equal(isMultiTopic({ areas: ['CLI'], files: { meaningful: 9 } }), true)
  const p = buildPrompt(multi, 'diff --git a/a.ts b/a.ts', {})
  assert.match(p, /"changes": \[/)
  assert.match(p, /several changes/)
  assert.match(p, /"confidence"/)
  assert.match(p, /"unknowns"/)
  const single = buildPrompt({ ...multi, areas: ['CLI'] }, 'diff', {})
  assert.doesNotMatch(single, /"changes": \[/)
})

test('buildPrompt injects structured facts, PR review discussion and the glossary', () => {
  const e = { sha: sha('a'), date: '2026-09-18T00:00:00Z', areas: ['CLI'], files: { added: [], modified: ['a.ts'] }, structured: extractStructuredFacts(PATCH) }
  const prMeta = { number: 9, title: 'Raise the cap', body: 'Because the trial filled in an hour.', comments: [{ author: 'rev', path: 'a.ts', line: 3, body: 'Why 500 and not 400?' }], matched: 'files', confidence: 0.8 }
  const glossary = formatGlossary({ 'limited offer': 'A capped free trial.' })
  const p = buildPrompt(e, 'diff', { prMeta, glossary })
  assert.match(p, /Structured facts/)
  assert.match(p, /300 -> 500/)
  assert.match(p, /Review discussion:/)
  assert.match(p, /@rev on a\.ts:3: Why 500/)
  assert.match(p, /matched to this snapshot by its touched files, confidence 80%/)
  assert.match(p, /Freebuff glossary/)
  assert.match(p, /- limited offer: A capped free trial\./)
  const eli5 = buildEli5Prompt({ ...e, ai: { title: 't', summary: 's', migration: 'Set the new variable.', unknowns: 'Who reads the cap.', newEnvVars: ['CODEBUFF_X'] } }, [], { prMeta, glossary, structured: e.structured })
  assert.match(eli5, /Freebuff glossary/)
  assert.match(eli5, /Migration the technical pass recorded/)
  assert.match(eli5, /do not fill this gap with a guess/)
  assert.match(eli5, /Values that changed: FREEBUFF_LIMITED_OFFER_MAX_SESSIONS 300 -> 500/)
  assert.match(eli5, /Review discussion:/)
  assert.equal(formatGlossary({ empty: '', ok: 'x' }).includes('empty'), false, 'empty definitions are never injected')
})

test('validateLlmOut: structured fields cleaned and grounded', () => {
  const corpus = groundingCorpus({ files: { added: ['sdk/src/trust.ts'] }, structured: extractStructuredFacts(PATCH) }, PATCH, {})
  const out = validateLlmOut({
    title: 'Trust gate', summary: 'Adds a gate.', significance: 'notable',
    userVisible: true, breaking: 'yes', migration: 'none', unknowns: 'null', confidence: 'Low',
    newEnvVars: ['CODEBUFF_TRUSTED_AGENT_PUBLISHERS', 'not-a-var'], newFlags: ['trust-agent-dirs'],
    changes: [{ area: 'SDK', what: 'Gate remote agents.', files: ['sdk/src/trust.ts'] }, { what: '' }]
  }, 'minor', { corpus, onUngrounded: 'flag' })
  assert.equal(out.userVisible, true)
  assert.equal(out.breaking, undefined, 'only literal true counts')
  assert.equal(out.migration, undefined)
  assert.equal(out.unknowns, undefined)
  assert.equal(out.confidence, 'low')
  assert.deepEqual(out.newEnvVars, ['CODEBUFF_TRUSTED_AGENT_PUBLISHERS'])
  assert.deepEqual(out.newFlags, ['--trust-agent-dirs'])
  assert.equal(out.changes.length, 1)
  assert.equal(out.ungrounded, undefined)
  const bad = validateLlmOut({ title: 'T', summary: 'S.', newEnvVars: ['CODEBUFF_INVENTED'], breaking: true, migration: 'Set CODEBUFF_INVENTED before upgrading.' }, 'minor', { corpus, onUngrounded: 'flag' })
  assert.deepEqual(bad.ungrounded, ['CODEBUFF_INVENTED'])
  assert.equal(bad.breaking, true)
  assert.match(bad.migration, /before upgrading/)
})

test('ungroundedIdentifiers: paths in prose evidence are checked against the corpus', () => {
  const corpus = 'sdk/src/trust.ts\ncommon/src/x.ts'
  assert.deepEqual(ungroundedIdentifiers('New file sdk/src/trust.ts and web/src/app/page.tsx.', corpus), ['web/src/app/page.tsx'])
  assert.deepEqual(ungroundedIdentifiers('touches src/x.ts', corpus), [], 'a suffix of a listed path is accepted')
})

test('gaveUp, wantsStrongModel and modelFor', () => {
  assert.equal(gaveUp({ kind: 'sync', title: 'CLI update: env', ai: { title: 'CLI update: env' } }), true)
  assert.equal(gaveUp({ kind: 'sync', title: 'CLI update: env', ai: { title: 'Real title' } }), false)
  const env = { LLM_MODEL: 'cheap', LLM_MODEL_MAJOR: 'strong' }
  assert.equal(modelFor({ significance: 'minor', files: {} }, env), 'cheap')
  assert.equal(modelFor({ significance: 'major', files: {} }, env), 'strong')
  assert.equal(modelFor({ significance: 'minor', files: {} }, env, 'release window'), 'strong')
  assert.equal(modelFor({ significance: 'minor', modelChanges: { added: ['X'] }, files: {} }, env), 'strong')
  assert.equal(modelFor({ significance: 'minor', files: { modified: ['cli/src/utils/auth.ts'] } }, env), 'strong', 'security hint')
  assert.equal(modelFor({ significance: 'major', files: {} }, { LLM_MODEL: 'cheap' }), 'cheap', 'no strong model configured')
  assert.equal(wantsStrongModel({ areas: ['CLI', 'SDK'], files: { meaningful: 2 } }), true, 'multi-topic rows are heavy')
})

test('matchPrByPaths: a sync commit finds its squashed PR by touched files, conservatively', () => {
  const pr = { number: 42, title: 'Trust gate', paths: ['sdk/src/trust.ts', 'sdk/src/impl/database.ts', 'sdk/src/run.ts'], updated: '2026-09-17T10:00:00Z', comments: [{ author: 'a', body: 'why' }] }
  const other = { number: 43, title: 'Other', paths: ['web/src/a.tsx', 'web/src/b.tsx'], updated: '2026-09-17T10:00:00Z' }
  const prIndex = { prsByNum: new Map([[42, pr], [43, other]]), prsBySha: new Map() }
  const e = { kind: 'sync', sha: sha('a'), date: '2026-09-18T01:00:00Z', files: { added: ['sdk/src/trust.ts'], modified: ['sdk/src/impl/database.ts', 'sdk/src/run.ts', 'cli/src/x.ts'] } }
  const m = matchPrByPaths(e, prIndex)
  assert.equal(m.pr.number, 42)
  assert.ok(m.confidence >= 0.7 && m.confidence <= 1, String(m.confidence))
  const meta = findPrMeta(e, prIndex)
  assert.equal(meta.number, 42)
  assert.equal(meta.matched, 'files')
  assert.equal(meta.comments.length, 1)
  assert.equal(matchPrByPaths({ ...e, files: { added: ['sdk/src/trust.ts'], modified: [] } }, prIndex), null, 'one shared file is not enough')
  assert.equal(matchPrByPaths({ ...e, date: '2026-11-01T00:00:00Z' }, prIndex), null, 'outside the time window')
  assert.equal(findPrMeta({ ...e, kind: 'community' }, prIndex), null, 'community commits carry their own PR number and never guess')
})

test('rememberClosedPrs keeps review comments and preview paths; diffPaths parses headers', () => {
  const preview = 'diff --git a/sdk/src/a.ts b/sdk/src/a.ts\n+x\ndiff --git a/sdk/src/b.ts b/sdk/src/b.ts\n+y\n'
  assert.deepEqual(diffPaths(preview), ['sdk/src/a.ts', 'sdk/src/b.ts'])
  const prev = [{ number: 1, title: 'A', updated: '2026-09-17T00:00:00Z', commentsList: [{ author: 'r', body: 'Looks fine.', path: 'sdk/src/a.ts', line: 2, isReview: true }, { author: 'x', body: '' }] }]
  const { doc } = rememberClosedPrs(prev, [], { prs: [] }, '2026-09-18T00:00:00Z', { pathsOf: () => diffPaths(preview) })
  assert.deepEqual(doc.prs[0].paths, ['sdk/src/a.ts', 'sdk/src/b.ts'])
  assert.deepEqual(doc.prs[0].comments, [{ author: 'r', body: 'Looks fine.', path: 'sdk/src/a.ts', line: 2, isReview: true }])
  assert.equal(doc.prs[0].updated, '2026-09-17T00:00:00Z')
})

test('eval: why detection, must-mention, row scoring, aggregation, judge validation, report', () => {
  assert.equal(whyVisible('Raised the cap because the trial filled in an hour.'), true)
  assert.equal(whyVisible('Raised the cap to 500.'), false)
  const e = { sha: sha('a'), files: { added: ['src/a.ts'], modified: [] }, version: '1.0.5', structured: extractStructuredFacts(PATCH), eli5: { text: 'Plain.' } }
  assert.deepEqual(mustMentionFor(e).slice(0, 2), ['1.0.5', 'FREEBUFF_LIMITED_OFFER_MAX_SESSIONS'])
  const golden = { verified: true, audience: 'end-users', significance: 'notable', mustMention: ['1.0.5', 'FREEBUFF_LIMITED_OFFER_MAX_SESSIONS'] }
  const good = scoreRow(e, { title: 'Cap raised to 500 in 1.0.5', summary: 'FREEBUFF_LIMITED_OFFER_MAX_SESSIONS moves from 300 to 500 because the trial filled.', evidence: 'src/a.ts', audience: 'end-users', significance: 'notable' }, golden)
  assert.equal(good.grounded, true)
  assert.equal(good.pathGrounded, true)
  assert.equal(good.why, true)
  assert.equal(good.mustMention, 1)
  assert.equal(good.audienceAgree, true)
  assert.equal(good.structuredCited, true)
  const noEv = scoreRow(e, { title: 'T', summary: 'S.' }, golden)
  assert.equal(noEv.pathGrounded, null, 'a row citing no paths skipped the check, it did not pass it')
  const bad = scoreRow(e, { title: 'x', summary: 'This makes Freebuff smarter.', evidence: 'web/src/other.tsx', audience: 'advertisers', significance: 'minor', ungrounded: ['zz'] }, golden)
  assert.equal(bad.grounded, false)
  assert.equal(bad.pathGrounded, false)
  assert.equal(bad.hypeFree, false)
  assert.equal(bad.audienceAgree, false)
  const agg = aggregate([good, bad])
  assert.equal(agg.n, 2)
  assert.equal(agg.grounded, 0.5)
  assert.equal(agg.whyRate, 0.5)
  assert.equal(agg.mustMention, 0.5)
  assert.equal(agg.counts.grounded, 2)
  assert.equal(agg.counts.pathGrounded, 2, 'the null row is out of the denominator, not counted as a pass')
  assert.deepEqual(validateJudgeOut({ faithfulness: 5, completeness: '4', clarity: 3.6, issues: ['x'] }), { faithfulness: 5, completeness: 4, clarity: 4, issues: ['x'] })
  assert.throws(() => validateJudgeOut({ faithfulness: 9 }), /missing scores/)
  const report = { promptV: PROMPT_V, model: 'm', golden: { total: 2, verified: 1, evaluated: 2, failed: 0 }, metrics: agg, rows: [good, bad], previous: { promptV: PROMPT_V - 1, at: 'then', metrics: { ...agg, grounded: 1 } } }
  const text = formatEvalReport(report)
  assert.match(text, /grounded\s+50%\s+prev 100%\s+\(-50pt\)/)
  assert.match(text, /rows to look at/)
})
