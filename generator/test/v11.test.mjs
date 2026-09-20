// generator/test/v11.test.mjs - tests for the audit-hardening pass (prompt v11):
// bounded grounding with number fidelity, the moved-code input prune, the fuse
// digest, chunk-prompt domain context, corpus alignment and the roll-up drop.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pruneKnownInputs, hasStructuredFacts } from '../lib/analyze.mjs'
import {
  buildDiffDigest, buildChunkPrompt, buildFusePrompt, groundingCorpus,
  ungroundedIdentifiers, validateLlmOut, gatherEntryContext, splitPatchByFile
} from '../lib/llm.mjs'

const sha = (c) => c.repeat(40)

test('grounding: backticked calls and separator-formatted numbers are not typos', () => {
  // Live-corpus shapes found while smoke-testing v11 against published rows:
  // `foo()` used to trim to `foo(` (never found), and a summary saying 12500
  // for a diff that writes 12_500 is a format choice, not an invention.
  assert.deepEqual(ungroundedIdentifiers('Adds `runDotenvIsolationSmoke()` to the release smoke test.', 'calls runDotenvIsolationSmoke() nightly'), [])
  assert.deepEqual(ungroundedIdentifiers('Billed at 12500.', 'price_cents = 12_500'), [])
  assert.deepEqual(ungroundedIdentifiers('Billed at 12500.', 'price_cents = 12_501'), ['12500'], 'a different number is still a wrong number')
  assert.deepEqual(ungroundedIdentifiers('Adds `runMissingSmoke()`.', 'nothing here'), ['runMissingSmoke()'])
})

test('pruneKnownInputs: names that exist at the base rev are not new inputs; lookups fail open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-prune-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  // The base tree already carries the old names (they merely moved in the
  // snapshot under review); the brand-new ones appear nowhere in it.
  await writeFile(join(dir, 'src.ts'), 'const v = process.env.OLD_RELOCATED_VAR\n// --old-flag was parsed once\ncheck("checks the old behavior", 1)\n')
  g('add', '.')
  g('commit', '-qm', 'base')

  const structured = {
    constants: [{ name: 'LIMIT', from: '1', to: '2' }],
    envVars: ['OLD_RELOCATED_VAR', 'BRAND_NEW_VAR'],
    flags: ['--old-flag', '--brand-new-flag'],
    exportsAdded: [], exportsRemoved: [],
    testNames: ['asserts a brand new behavior', 'checks the old behavior']
  }
  const out = await pruneKnownInputs(dir, 'HEAD', structured)
  assert.deepEqual(out.envVars, ['BRAND_NEW_VAR'], 'a relocated read is not a new input')
  assert.deepEqual(out.flags, ['--brand-new-flag'])
  assert.deepEqual(out.testNames, ['asserts a brand new behavior'], 'a moved test title is not a new test')
  assert.deepEqual(out.constants, structured.constants, 'only the new-input lists are pruned')

  // No repo, no base: unchanged (the eval path may lack a worktree).
  assert.equal(await pruneKnownInputs(null, null, structured), structured)
  assert.equal(await pruneKnownInputs(dir, null, structured), structured)
  assert.equal(await pruneKnownInputs(dir, 'HEAD', null), null)
  // A broken rev fails open: git grep errors out and every claim survives.
  const broken = await pruneKnownInputs(dir, 'no-such-rev', structured)
  assert.deepEqual(broken.envVars, structured.envVars)
})

test('buildDiffDigest: per-file line counts and sample added lines, byte-bounded', () => {
  const patch = [
    'diff --git a/sdk/src/a.ts b/sdk/src/a.ts',
    '@@ -1,2 +1,4 @@',
    '+export const TRUNCATE_AT_USER_TURN = 5',
    '+x = 2',
    ' context line',
    '-old removed line here',
    '+++ b/sdk/src/a.ts',
    'diff --git a/cli/src/b.tsx b/cli/src/b.tsx',
    '@@ -1 +1,2 @@',
    '+import { x } from "y"',
    '+export function renderPicker () {}'
  ].join('\n')
  const digest = buildDiffDigest(patch)
  assert.match(digest, /- sdk\/src\/a\.ts \(\+2\/-1\)/)
  assert.match(digest, /TRUNCATE_AT_USER_TURN/)
  assert.doesNotMatch(digest, /x = 2/, 'lines under the sample floor are not quoted')
  assert.doesNotMatch(digest, /import \{ x \}/, 'import noise never samples')
  assert.match(digest, /cli\/src\/b\.tsx \(\+2\/-0\)/)
  assert.match(digest, /renderPicker/)
  assert.equal(splitPatchByFile(patch).length, 2)
  // The budget trims with a marked tail instead of growing without bound.
  const many = Array.from({ length: 400 }, (_, i) => `diff --git a/f${i}/name.ts b/f${i}/name.ts\n+const LONG_ENOUGH_SAMPLE_LINE_${i} = "${'x'.repeat(100)}"\n`).join('')
  const big = buildDiffDigest(many, { maxBytes: 2000 })
  assert.ok(big.length < 4000, `digest stays small (${big.length})`)
  assert.match(big, /digest truncated; \d+ more files/)
})

test('buildChunkPrompt: the map reader gets the lexicon, the architecture map and the structured facts', () => {
  const structured = {
    constants: [{ name: 'PLACEMENT_DAILY_CAP_CENTS', from: '100', to: '500' }],
    envVars: ['FREEBUFF_NEW_GATE'], flags: [], exportsAdded: [], exportsRemoved: [], testNames: []
  }
  const prompt = buildChunkPrompt({ sha: sha('a'), summary: 'Cap work.' }, 'diff --git a/x.ts b/x.ts\n+const a = 1', { index: 1, total: 3, files: ['x.ts'], structured })
  assert.match(prompt, /summarize part 2 of 3/, 'the chunk detector phrase survives')
  assert.match(prompt, /Conversions API/, 'the domain lexicon rides along')
  assert.match(prompt, /Monorepo Architecture Context/, 'the architecture map rides along')
  assert.match(prompt, /PLACEMENT_DAILY_CAP_CENTS: 100 -> 500/, 'structured facts ride along')
  assert.match(prompt, /appear verbatim/, 'chunks are told the identifier rule')
})

test('buildFusePrompt: the digest lands after the drafts and never smuggles a raw diff', () => {
  const entry = { sha: sha('a'), date: '2026-09-19T10:00:00Z', areas: ['CLI'], summary: 'x.', files: { added: [], modified: ['a.ts'], removed: [] } }
  const drafts = [{ index: 0, files: ['a.ts'], summary: 'Draft one.', changes: [] }]
  const noDigest = buildFusePrompt(entry, drafts, {})
  assert.doesNotMatch(noDigest, /File-level digest/, 'no digest argument: byte-identical ask to before')
  const withDigest = buildFusePrompt(entry, drafts, {}, '- a.ts (+9/-1) | added lines include: export const TRUNCATE_AT = 5')
  assert.match(withDigest, /File-level digest/)
  assert.match(withDigest, /TRUNCATE_AT = 5/)
  assert.match(withDigest, /digest decides/, 'the fuse is told how to referee draft conflicts')
  assert.doesNotMatch(withDigest, /```diff/, 'the digest is a table, not the diff re-embedded')
})

test('groundingCorpus: everything the prompt shows is checkable, caution lines are not', () => {
  const corpus = groundingCorpus({ files: {} }, 'patch text', {
    sequence: { earlier: [{ title: 'Wires the OFF_PEAK_GATE', summary: 'Reads siblingConst.' }], later: [] },
    fileHistory: [{ sha: 'abcd1234', overlap: ['a.ts'], title: 'Introduced RETRY_BUDGET', summary: 'Sets retry policy.' }],
    releaseCtx: '- 2026-09-10 Real item: verified work.\n- 2026-09-11 Cautioned item [caution: review flagged its claims]: cites INVENTED_NAME.'
  })
  assert.match(corpus, /OFF_PEAK_GATE/, 'a name copied from a sibling title is not invented')
  assert.match(corpus, /RETRY_BUDGET/, 'lineage titles ground too')
  assert.match(corpus, /Real item/)
  assert.doesNotMatch(corpus, /INVENTED_NAME/, 'a caution-marked line cannot launder its names into the corpus')
})

test('validateLlmOut: an ungrounded row cannot self-rate confidence high', () => {
  const ok = validateLlmOut({ title: 'Gate added', summary: 'Reads ALPHA now.', confidence: 'high' }, 'minor', { corpus: 'ALPHA here', onUngrounded: 'flag' })
  assert.equal(ok.confidence, 'high', 'a clean row keeps its rating')
  const cap = validateLlmOut({ title: 'Gate added', summary: 'Reads CODEBUFF_INVENTED now.', confidence: 'high' }, 'minor', { corpus: 'sdk/src/a.ts', onUngrounded: 'flag' })
  assert.deepEqual(cap.ungrounded, ['CODEBUFF_INVENTED'])
  assert.equal(cap.confidence, 'medium', 'one notch down, never up')
  const low = validateLlmOut({ title: 'Gate added', summary: 'Reads CODEBUFF_INVENTED now.', confidence: 'low' }, 'minor', { corpus: 'sdk/src/a.ts', onUngrounded: 'flag' })
  assert.equal(low.confidence, 'low', 'low is not rounded up')
})

test('gatherEntryContext: the fuller structured extraction wins, stored narrow facts no longer block it', async () => {
  const fullPatch = [
    'diff --git a/cli/src/a.ts b/cli/src/a.ts',
    '+export const ALPHA = 2',
    '-export const ALPHA = 1',
    '+const v = process.env.BRAND_NEW_VAR',
    "diff --git a/cli/src/__tests__/a.test.ts b/cli/src/__tests__/a.test.ts",
    "+  it('caps the run at the daily session ceiling', () => {})"
  ].join('\n')
  const promptPatch = 'diff --git a/cli/src/a.ts b/cli/src/a.ts\n+export const ALPHA = 2\n-export const ALPHA = 1\n+const v = process.env.BRAND_NEW_VAR\n'
  // A row that stored exactly one fact at analyze time (no test names: the
  // analyze patch excludes tests by design) must still get the full-diff set.
  const e = {
    sha: sha('b'), date: '2026-09-19T10:00:00Z', areas: ['CLI'],
    files: { added: [], modified: ['cli/src/a.ts'] },
    structured: { constants: [{ name: 'ALPHA', from: '0', to: '1' }], envVars: [], flags: [], exportsAdded: [], exportsRemoved: [], testNames: [] }
  }
  const ctx = await gatherEntryContext(e, promptPatch, { fullPatch })
  assert.ok(hasStructuredFacts(ctx.structured))
  assert.deepEqual(ctx.structured.testNames, ['caps the run at the daily session ceiling'], 'test titles arrive from the full patch')
  assert.deepEqual(ctx.structured.envVars, ['BRAND_NEW_VAR'])
  assert.deepEqual(ctx.structured.constants, [{ name: 'ALPHA', from: '1', to: '2' }], 'the fuller extraction replaces the stored one')
  // Nothing richer available (no diff text at all): the stored set is kept.
  const ctx2 = await gatherEntryContext(e, '', {})
  assert.deepEqual(ctx2.structured.constants, [{ name: 'ALPHA', from: '0', to: '1' }])
})
