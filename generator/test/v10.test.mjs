// generator/test/v10.test.mjs - tests for the v10 accuracy pipeline:
// map-reduce chunking, per-claim verifier, grounding v2, PR gate, release caution.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitPatchByFile, chunkPatchGroups, needsChunking,
  buildChunkPrompt, validateChunkOut, buildFusePrompt, summarizeChunked,
  MAP_REDUCE_THRESHOLD_BYTES, MAP_REDUCE_CHUNK_BYTES, MAP_REDUCE_MAX_CHUNKS,
  shouldVerify, validateVerifyOut, buildVerifyPrompt,
  ungroundedIdentifiers, validateGroundedEli5,
  PR_MATCH_STOPLIST_RE, matchPrByPaths, buildPrRelevancePrompt,
  validatePrRelevanceOut, checkPrRelevance,
  collectReleaseContext, formatReleaseContext
} from '../lib/llm.mjs'

const sha = (c) => c.repeat(40)
const filePatch = (path, body) => `diff --git a/${path} b/${path}\n${body}\n`

test('splitPatchByFile + chunkPatchGroups: groups by file, caps giants, bounds calls', () => {
  const a = filePatch('sdk/src/a.ts', '+x\n'.repeat(30000))
  const b = filePatch('cli/src/b.ts', '+y\n')
  const c = filePatch('web/src/c.tsx', '+z\n')
  const patch = a + b + c
  assert.equal(splitPatchByFile(patch).length, 3)
  assert.deepEqual(splitPatchByFile(patch).map(f => f.path), ['sdk/src/a.ts', 'cli/src/b.ts', 'web/src/c.tsx'])
  // Small patch: one chunk.
  assert.equal(chunkPatchGroups(b + c, { targetBytes: 100000 }).length, 1)
  // The giant file is capped at the chunk budget and marked.
  const chunks = chunkPatchGroups(patch, { targetBytes: 40000 })
  assert.ok(chunks.length >= 2)
  assert.match(chunks.join('\n'), /\[file truncated\]/)
  // Call count stays bounded no matter how many files land.
  const many = Array.from({ length: 20 }, (_, i) => filePatch(`sdk/src/f${i}.ts`, '+q\n')).join('')
  assert.ok(chunkPatchGroups(many, { targetBytes: 1000, maxChunks: 4 }).length <= 4)
  assert.equal(chunkPatchGroups('', {}).length, 0)
})

test('needsChunking: threshold with opt-out', () => {
  assert.equal(needsChunking({}, 'x'.repeat(MAP_REDUCE_THRESHOLD_BYTES + 1), {}), true)
  assert.equal(needsChunking({}, 'small', {}), false)
  assert.equal(needsChunking({}, 'x'.repeat(MAP_REDUCE_THRESHOLD_BYTES + 1), { CHANGELOG_LLM_MAPREDUCE: '0' }), false)
  assert.ok(MAP_REDUCE_CHUNK_BYTES <= 100000 && MAP_REDUCE_MAX_CHUNKS <= 6, 'map-reduce stays inside the 270K window')
})

test('validateChunkOut: shape-checked, grounding deferred to the fuse', () => {
  const out = validateChunkOut({ evidence: 'Chunk touches a.ts.', summary: 'Adds a helper.', changes: [{ area: 'SDK', what: 'Adds helper.', files: ['sdk/src/a.ts'] }] })
  assert.equal(out.summary, 'Adds a helper.')
  assert.equal(out.changes.length, 1)
  assert.throws(() => validateChunkOut({ evidence: 'x' }), /missing summary/)
  assert.throws(() => validateChunkOut(null), /not an object/)
})

test('buildFusePrompt: drafts are untrusted, changes required, lists ground', () => {
  const entry = {
    sha: sha('a'), date: '2026-09-18T10:00:00Z', areas: ['SDK', 'CLI'], significance: 'notable',
    summary: 'Big change.', files: { added: [], modified: ['sdk/src/a.ts', 'cli/src/b.ts'], removed: [] }
  }
  const drafts = [
    { index: 0, files: ['sdk/src/a.ts'], evidence: 'Chunk 1.', summary: 'Adds helper.', changes: [] },
    { index: 1, files: ['cli/src/b.ts'], evidence: 'Chunk 2.', summary: 'Wires flag.', changes: [] }
  ]
  const prompt = buildFusePrompt(entry, drafts, {})
  assert.match(prompt, /UNTRUSTED/)
  assert.match(prompt, /"changes":/)
  assert.match(prompt, /sdk\/src\/a\.ts/)
  assert.match(prompt, /Adds helper\./)
  assert.doesNotMatch(prompt, /```diff/, 'the fuse sees drafts, not the full diff again')
})

test('summarizeChunked: maps chunks then fuses, validated on the full corpus', async () => {
  const patch = filePatch('sdk/src/a.ts', '+export const ALPHA = 1') + filePatch('cli/src/b.ts', '+export const BETA = 2')
  const entry = {
    sha: sha('b'), date: '2026-09-18T10:00:00Z', areas: ['SDK', 'CLI'],
    significance: 'notable', summary: 'Two constants.',
    files: { added: [], modified: ['sdk/src/a.ts', 'cli/src/b.ts'], removed: [] },
    structured: { constants: [{ name: 'ALPHA', from: '0', to: '1' }], envVars: [], flags: [], exportsAdded: [], exportsRemoved: [], testNames: [] }
  }
  const seen = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, { body }) => {
    const prompt = JSON.parse(String(body)).messages[0].content
    seen.push(prompt)
    const isChunk = /summarize part \d+ of \d+/.test(prompt)
    const payload = isChunk
      ? { evidence: 'Chunk evidence.', summary: 'Chunk summary of ALPHA work.', changes: [{ area: 'SDK', what: 'Adds ALPHA.', files: ['sdk/src/a.ts'] }] }
      : {
          evidence: 'sdk/src/a.ts and cli/src/b.ts carry the change.',
          title: 'Alpha and beta constants added',
          summary: 'Adds `ALPHA` in sdk/src/a.ts and `BETA` in cli/src/b.ts. Covers two chunks.',
          significance: 'notable', audience: 'maintainers', confidence: 'high',
          changes: [
            { area: 'SDK', what: 'Adds ALPHA.', files: ['sdk/src/a.ts'] },
            { area: 'CLI', what: 'Adds BETA.', files: ['cli/src/b.ts'] }
          ]
        }
    const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => envelope }
  }
  try {
    const { clean, fuse } = await summarizeChunked(entry, patch, {
      promptCtx: { structured: entry.structured }, corpus: patch, sig: 'notable', env: {}
    })
    assert.ok(seen.length >= 2, `expected map + fuse calls, got ${seen.length}`)
    assert.match(fuse, /UNTRUSTED/)
    assert.equal(clean.title, 'Alpha and beta constants added')
    assert.equal(clean.changes.length, 2)
    assert.equal(clean.ungrounded, undefined, 'fuse output grounded on the full patch')
  } finally {
    globalThis.fetch = orig
  }
})

test('shouldVerify: on for what costs most, off with =0, =all covers all', () => {
  const major = { significance: 'major', files: {} }
  const minor = { significance: 'minor', files: {} }
  const cleanMinor = { significance: 'minor' }
  assert.equal(shouldVerify(major, { significance: 'major' }, {}), true, 'major verifies by default')
  assert.equal(shouldVerify(minor, cleanMinor, {}), false, 'clean minor skips by default')
  assert.equal(shouldVerify(minor, cleanMinor, { CHANGELOG_LLM_VERIFY: 'all' }), true)
  assert.equal(shouldVerify(major, { significance: 'major' }, { CHANGELOG_LLM_VERIFY: '0' }), false)
  assert.equal(shouldVerify({ areas: ['CLI', 'SDK'], files: {} }, { significance: 'minor' }, {}), true, 'multi-topic verifies')
  assert.equal(shouldVerify(minor, { significance: 'minor', ungrounded: ['X'] }, {}), true, 'ungrounded verifies')
})

test('validateVerifyOut: per-claim verdicts fail closed', () => {
  const good = validateVerifyOut({ supported: true, issues: [], claims: [{ quote: 'Adds X.', supported: true }] })
  assert.equal(good.supported, true)
  assert.equal(good.claims.length, 1)
  const bad = validateVerifyOut({ supported: true, issues: [], claims: [{ quote: 'Adds X.', supported: false, reason: 'not in diff' }] })
  assert.equal(bad.supported, false, 'an unsupported claim fails even with supported:true')
  const legacy = validateVerifyOut({ supported: false, issues: ['invented name'] })
  assert.equal(legacy.supported, false)
  assert.throws(() => validateVerifyOut(null), /not an object/)
  const prompt = buildVerifyPrompt({ files: {} }, 'diff', { title: 'T', summary: 'S.' })
  assert.match(prompt, /"claims":/)
})

test('grounding v2: bare constants, versions and flags are checked; URLs ignored', () => {
  const corpus = 'ALPHA in sdk/src/a.ts\nshipped 0.0.178\n--trust-agent-dirs flag'
  assert.deepEqual(ungroundedIdentifiers('Raised FREEBUFF_X from 300 to 500.', corpus), ['FREEBUFF_X'])
  assert.deepEqual(ungroundedIdentifiers('Shipped in 0.0.179 today.', corpus), ['0.0.179'])
  assert.deepEqual(ungroundedIdentifiers('Pass --invented-flag to enable.', corpus), ['--invented-flag'])
  assert.deepEqual(ungroundedIdentifiers('Raised ALPHA, shipped 0.0.178 with --trust-agent-dirs.', corpus), [])
  assert.deepEqual(ungroundedIdentifiers('See https://github.com/x/y/blob/main/docs/a.md for context.', 'nothing'), [])
  assert.deepEqual(ungroundedIdentifiers('The CLI is fast and the API works.', corpus), [], 'ordinary prose never flags')
})

test('validateGroundedEli5: leaks park, clean lines pass', () => {
  const corpus = 'sdk/src/a.ts diff text about a helper'
  assert.throws(
    () => validateGroundedEli5({ eli5: 'A helper called FREEBUFF_X is now available to you.' }, 800, { corpus }),
    /not present in the diff/
  )
  const ok = validateGroundedEli5({ eli5: 'A new helper is now available when you code.' }, 800, { corpus })
  assert.match(ok, /helper/)
})

test('PR stop-list: generic-only overlap is not a match', () => {
  const pr = { number: 7, title: 'Docs', paths: ['package.json', 'README.md', 'cli/src/x.ts'], updated: '2026-09-17T10:00:00Z' }
  const prIndex = { prsByNum: new Map([[7, pr]]), prsBySha: new Map() }
  const genericOnly = { kind: 'sync', sha: sha('c'), date: '2026-09-18T01:00:00Z', files: { added: ['package.json'], modified: ['README.md', 'cli/src/other.ts'] } }
  assert.equal(matchPrByPaths(genericOnly, prIndex), null, 'README + manifest overlap proves nothing')
  assert.ok(PR_MATCH_STOPLIST_RE.test('package.json'), 'manifests are generic')
  assert.ok(PR_MATCH_STOPLIST_RE.test('docs/README.md'), 'readmes are generic')
  assert.ok(!PR_MATCH_STOPLIST_RE.test('sdk/src/trust.ts'), 'real sources are not')
})

test('PR relevance gate: shape-checked; failures fail open', async () => {
  const e = { sha: sha('d'), summary: 'Change.', files: { added: ['sdk/src/a.ts'], modified: [] } }
  const prMeta = { number: 9, title: 'Unrelated docs', matched: 'files', confidence: 0.65 }
  const prompt = buildPrRelevancePrompt(e, 'diff', prMeta)
  assert.match(prompt, /"relevant": true\|false/)
  assert.deepEqual(validatePrRelevanceOut({ relevant: true, reason: 'Same files.' }), { relevant: true, reason: 'Same files.' })
  assert.throws(() => validatePrRelevanceOut({ reason: 'x' }), /missing relevant/)
  // Exact matches are never gated: no fetch, same object back.
  const exact = { number: 9, title: 'Docs' }
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = async (...a) => { calls++; return orig(...a) }
  try {
    assert.equal(await checkPrRelevance(e, 'diff', exact, {}), exact)
    assert.equal(calls, 0)
    // A dead gateway fails open: the match is kept, never dropped on error.
    const kept = await checkPrRelevance(e, 'diff', prMeta, { LLM_API_BASE: 'http://127.0.0.1:1', LLM_API_KEY: 'k' })
    assert.equal(kept, prMeta)
  } finally {
    globalThis.fetch = orig
  }
})

test('release caution: unverified members are marked, verified stay clean', () => {
  const bump = { sha: sha('f'), date: '2026-09-18T10:00:00Z', version: '1.0.5', files: { modified: ['package.json'] } }
  const bad = {
    sha: sha('e'), date: '2026-09-17T10:00:00Z', version: null,
    ai: { title: 'Shiny thing', summary: 'Adds `INVENTED_X`.', significance: 'notable', ungrounded: ['INVENTED_X'], verify: 'flagged' },
    files: {}
  }
  const good = {
    sha: sha('a'), date: '2026-09-17T09:00:00Z', version: null,
    ai: { title: 'Solid fix', summary: 'Fixes retry.', significance: 'minor' },
    files: {}
  }
  const ctx = collectReleaseContext([bad, good, bump], bump)
  const text = formatReleaseContext(ctx, bump)
  assert.match(text, /\[caution: unverified identifiers: INVENTED_X; review flagged its claims\]/)
  assert.match(text, /hedged/, 'the roll-up is told how to handle marked items')
  const cleanCtx = collectReleaseContext([good, bump], bump)
  assert.doesNotMatch(formatReleaseContext(cleanCtx, bump), /caution/)
})
