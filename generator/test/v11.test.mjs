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
  buildDiffDigest, buildChunkPrompt, buildFusePrompt, buildPrompt, groundingCorpus,
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
  // A computed percentage is a derived share, not a copied literal, so it must
  // not be flagged even though the corpus never spells the number out.
  assert.deepEqual(ungroundedIdentifiers('Internal work is 51% of the total.', 'nothing here'), [], 'a percentage is not an invented number')
  assert.deepEqual(ungroundedIdentifiers('Raised the cap to 50 %.', 'nothing here'), [], 'percentage with a space is exempt too')
  assert.deepEqual(ungroundedIdentifiers('Raised the cap to 500.', 'nothing here'), ['500'], 'a bare number is still checked')
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
  const corpus = groundingCorpus({ sha: 'cafe0000aaaa1111bbbb2222cccc3333dddd4444', files: {} }, 'patch text', {
    sequence: { earlier: [{ sha: '90462035aaaa', title: 'Wires the OFF_PEAK_GATE', summary: 'Reads siblingConst.' }], later: [] },
    fileHistory: [{ sha: 'abcd1234ffff9999eeee8888dddd7777cccc6666', date: '2026-09-14', overlap: ['a.ts'], title: 'Introduced RETRY_BUDGET', summary: 'Sets retry policy.' }],
    releaseCtx: '- 2026-09-10 Real item: verified work.\n- 2026-09-11 Cautioned item [caution: review flagged its claims]: cites INVENTED_NAME.',
    prMeta: { number: 7, title: 'T', comments: [{ author: 'reviewerLogin', body: 'Looks right.', path: 'a.ts' }] }
  })
  assert.match(corpus, /OFF_PEAK_GATE/, 'a name copied from a sibling title is not invented')
  assert.match(corpus, /RETRY_BUDGET/, 'lineage titles ground too')
  assert.match(corpus, /abcd1234ffff9999/, 'the lineage lines print the full sha, so it grounds')
  assert.match(corpus, /2026-09-14/, 'and the date they print beside it')
  assert.match(corpus, /Real item/)
  assert.doesNotMatch(corpus, /INVENTED_NAME/, 'a caution-marked line cannot launder its names into the corpus')
  // The sequence lines print `[9046203]` and the review lines print `@login`:
  // citing either is a faithful copy of the prompt (ba9141ce's class), so the
  // corpus has to vouch for every form the prompt shows.
  assert.match(corpus, /90462035/, 'a sibling short sha grounds')
  assert.match(corpus, /cafe0000/, "the row's own short sha grounds")
  assert.match(corpus, /reviewerLogin/, 'a review author grounds')
  // Bare digit runs are claims checked against the corpus (a sibling sha in
  // brackets is exactly that), and a camelCase login leaks through the prose
  // name arm; both were flagged as inventions before the corpus learned them.
  assert.deepEqual(ungroundedIdentifiers('Follows [90462035]; @reviewerLogin signed off on `cafe0000`.', corpus), [], 'prompt-copied shas and logins are not inventions')
  assert.deepEqual(ungroundedIdentifiers('Follows `deadbeef1234`.', corpus), ['deadbeef1234'], 'a sha the prompt never showed is still an invention')
  assert.deepEqual(ungroundedIdentifiers('Follows `90462035737c`.', corpus), [], 'digit-leading hex reads as a version string and is exempt')
  assert.deepEqual(ungroundedIdentifiers('Landed after [abcd1234ffff9999eeee8888dddd7777cccc6666] on 2026-09-14.', corpus), [], 'a lineage sha and date copied from the prompt are grounded')
})

// The invariant behind four shipped bugs (PR number, review logins and line
// numbers, sequence shas, lineage dates): a prompt that shows the model an
// identifier the corpus cannot vouch for turns the model's faithful copy into
// an "invented" claim. Each was caught by hand-auditing one prompt edit at a
// time; this checks the property mechanically. Every data token the prompt
// adds over the instruction skeleton must pass the REAL checker against the
// REAL corpus -- if a future edit prints something new without grounding it,
// this fails before a reader ever sees a false "unverified" badge. Prompts
// that embed the text being validated (verify/fuse/eli5 output) are out of
// scope on purpose: their claims are the product under test.
test('prompt-coverage invariant: every data token buildPrompt prints is checkable in the corpus', () => {
  const patch = [
    'diff --git a/sdk/src/a.ts b/sdk/src/a.ts',
    '-export const ALPHA_GATE = 300',
    '+export const ALPHA_GATE = 500',
    'diff --git a/sdk/src/a.test.ts b/sdk/src/a.test.ts',
    "+  it('caps the run at 500', () => {})"
  ].join('\n')
  const entry = {
    sha: sha('a'), date: '2026-09-28', day: '2026-09-28', category: 'SDK', significance: 'notable',
    areas: ['SDK'], stats: { additions: 692, deletions: 12 },
    summary: 'Raises FREEBUFF_GATE_MAX from 300 to 500 because the trial filled.',
    messageTitle: 'feat: raise the gate', messageBody: 'The trial filled early.',
    files: {
      added: ['sdk/src/new.ts'], modified: ['sdk/src/a.ts'], removed: ['sdk/src/old.ts'],
      renamed: [{ from: 'sdk/src/x.ts', to: 'sdk/src/y.ts' }], tests: ['sdk/src/a.test.ts'], churned: ['bun.lock']
    },
    facts: ['Alpha fact with 500 sessions.'],
    modelChanges: {
      added: ['Muse Spark 1.3'], removed: ['Muse Spark 1.2'],
      tables: {
        'Muse Spark 1.3': { after: ['Muse Spark 1.3', 'Paid plans', '1M context'] },
        'Muse Spark 1.2': { before: ['Muse Spark 1.2', 'Full access'] }
      }
    },
    cmdChanges: { added: ['/byok'], removed: ['/old'] },
    version: '0.1.4',
    structured: { constants: [{ name: 'FREEBUFF_GATE_MAX', from: '300', to: '500' }], envVars: [], flags: [], exportsAdded: [], exportsRemoved: [], testNames: ['caps the run at 500'] }
  }
  const ctx = {
    glossary: 'Freebuff glossary (use these plain-English meanings; never redefine a term differently):\n- gate: a limit.',
    prMeta: {
      number: 1259, title: 'Raise the gate cap', body: 'The trial filled.', matched: 'files', confidence: 0.82,
      comments: [{ author: 'reviewerLogin', body: 'Looks right.', path: 'sdk/src/a.ts', line: 42 }]
    },
    sequence: {
      earlier: [{ sha: '90462035aaaa1111bbbb2222cccc3333dddd4444', title: 'Earlier sibling title', summary: 'Earlier sibling summary.' }],
      later: [{ sha: '88887777bbbb2222cccc3333dddd4444eeee5555', title: 'Later sibling title', summary: 'Later sibling summary.', category: 'CLI' }]
    },
    fileHistory: [{ sha: 'abcd1234ffff9999eeee8888dddd7777cccc6666', date: '2026-09-14', overlap: ['sdk/src/a.ts'], title: 'Introduced RETRY_BUDGET', summary: 'Sets retry policy.' }],
    consumers: [{ path: 'sdk/src/consumer.ts', excerpt: 'reads ALPHA_GATE' }],
    changedTests: [{ path: 'sdk/src/a.test.ts', added: '+  it caps', titles: ['caps the run at 500'] }],
    subsystemDocs: [{ path: 'docs/guide.md', content: 'How the gate works.' }],
    exportOutlines: [{ path: 'sdk/src/a.ts', outline: 'export const ALPHA_GATE' }],
    fullFiles: [{ path: 'sdk/src/small.ts', content: 'const gate = 1', lines: 1 }],
    releaseCtx: '- 2026-09-10 Real item: shipped work.'
  }
  const corpus = groundingCorpus(entry, patch, ctx)
  const prompt = buildPrompt(entry, patch, ctx)
  // The fixture must really render every section, or the check below passes
  // vacuously on a prompt that never showed the tokens at all.
  for (const anchor of ['PR #1259', '@reviewerLogin', '[90462035]', 'abcd1234ffff9999', 'Model rows', 'Slash commands: +/byok', 'Version bump: 0.1.4', 'FREEBUFF_GATE_MAX', 'Earlier sibling title', 'Recent commit lineage']) {
    assert.ok(prompt.includes(anchor), `fixture renders: ${anchor}`)
  }
  // The instruction skeleton is identical in both prompts, so its tokens (the
  // lexicon, the architecture map, the examples) cancel out; what remains is
  // exactly the data this row's prompt added over it.
  const bare = buildPrompt({ files: {}, summary: '' }, patch, {})
  const allowed = ungroundedIdentifiers(bare, corpus)
  const bad = ungroundedIdentifiers(prompt, corpus).filter(t => !allowed.includes(t))
  assert.deepEqual(bad, [], 'a token the prompt prints but the corpus cannot vouch for is the ba9141ce class')
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

// Every case here shipped a junk "unverified" badge on a correct row: the badge
// demotes confidence high->medium, drops the row from release roll-up windows
// and parks its plain-English line. All four were reproduced against published
// entries before the checker was fixed.
test('grounding false positives: header figures, case, hyphenated English, ordinals', () => {
  const entry = {
    title: 'x', summary: 'Analysis notes.', date: '2026-09-20T00:00:00Z', day: '2026-09-20',
    areas: ['CLI'], category: 'Commands', significance: 'minor',
    stats: { additions: 692, deletions: 0 },
    files: { modified: ['cli/src/a.ts'] }
  }
  const corpus = groundingCorpus(entry, 'diff --git a/cli/src/a.ts b/cli/src/a.ts\n+x', {})
  // The prompt prints `Stats: +692 / -0`, `Date:`, `Areas:`, `Category:` and
  // `Commit nature:`; every line it shows has to be checkable here.
  assert.ok(corpus.includes('692'), 'stats reach the corpus')
  assert.ok(corpus.includes('2026-09-20'), 'the date does too')
  assert.ok(corpus.includes('Commands'), 'so does the category')
  assert.deepEqual(ungroundedIdentifiers('Touches 692 lines across the repo.', corpus), [], 'a cited figure from the header is not an invention')
  // Case is not a claim: the corpus spells the tree `cli/`.
  assert.deepEqual(ungroundedIdentifiers('The `CLI` now skips the gate.', corpus), [], 'a backticked case variant grounds')
  // Hyphenated English glued to a backticked head, or an ordinal suffix: these
  // were read as CLI flags by the prose flag arm.
  assert.deepEqual(ungroundedIdentifiers('Uses `AsyncLocalStorage`-backed storage now.', 'const store = new AsyncLocalStorage()'), [])
  assert.deepEqual(ungroundedIdentifiers('Adds a `runtime`-aware loader.', 'const runtime = 1'), [])
  assert.deepEqual(ungroundedIdentifiers('Slices history up to the (N+1)-th user turn.', 'keepUserTurn exists'), [])
  // ...while a real flag outside backticks is still checked.
  assert.deepEqual(ungroundedIdentifiers('Pass --invented-flag to enable.', 'nothing here'), ['--invented-flag'])
})
