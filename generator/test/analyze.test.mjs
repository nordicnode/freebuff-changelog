// generator/test/analyze.test.mjs — unit tests for the pure extractors
// (node --test, zero dependencies).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractModelTableChanges, extractVersionBump, extractSlashCommandChanges,
  areaOf, isNoiseFile, deterministicSummary, entryTitle, sourceRef, isSyncCommit,
  extractCommentFacts, extractCleanDiff
} from '../lib/analyze.mjs'

const README_PATCH = [
  'diff --git a/README.md b/README.md',
  '@@ -39,7 +39,7 @@',
  ' | **GPT-5.6 Luna**            | Full access             | Strong all-around                              |',
  '-| **Muse Spark 1.3**          | Full access             | Meta\'s agentic coding model; 1M context.               |',
  '+| **Muse Spark 1.2**          | Full access             | Meta\'s agentic coding model; 1M context.               |',
  ' '
].join('\n')

test('model table: detects replacement swap', () => {
  const r = extractModelTableChanges(README_PATCH)
  assert.deepEqual(r.added, ['Muse Spark 1.2'])
  assert.deepEqual(r.removed, ['Muse Spark 1.3'])
})

test('model table: empty when no table rows', () => {
  const r = extractModelTableChanges('diff --git a/README.md b/README.md\n+Some prose line\n')
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
})

test('version bump extractor', () => {
  const patch = '--- a/cli/release/package.json\n+++ b/cli/release/package.json\n@@\n-  "version": "1.0.687",\n+  "version": "1.0.688",\n'
  assert.equal(extractVersionBump(patch), '1.0.688')
  assert.equal(extractVersionBump('no version here'), null)
})

test('slash command extractor', () => {
  const patch = "@@\n+  name: '/undo',\n+  name: 'model',\n-  name: '/compact',\n"
  const r = extractSlashCommandChanges(patch)
  assert.deepEqual(r.added, ['/undo'])
  assert.deepEqual(r.removed, ['/compact'])
})

test('area mapping', () => {
  assert.equal(areaOf('cli/src/app.tsx'), 'CLI')
  assert.equal(areaOf('packages/agent-runtime/src/x.ts'), 'Agent Runtime')
  assert.equal(areaOf('common/src/constants/freebuff-models.ts'), 'Shared/Core')
  assert.equal(areaOf('sdk/src/index.ts'), 'SDK')
  assert.equal(areaOf('docs/foo.md'), 'Docs')
  assert.equal(areaOf('top-level.txt'), 'Repo')
})

test('noise files', () => {
  assert.ok(isNoiseFile('bun.lock'))
  assert.ok(isNoiseFile('assets/ads/logo.svg'))
  assert.ok(!isNoiseFile('README.md'))
  assert.ok(!isNoiseFile('cli/src/app.tsx'))
})

const baseEntry = (over = {}) => ({
  kind: 'sync', date: '2026-09-13T12:00:00Z', areas: ['Shared/Core'],
  stats: { additions: 10, deletions: 5 },
  files: { total: 3, meaningful: 3, added: [], removed: [], renamed: [], modified: ['common/src/x.ts'] },
  facts: [], ...over
})

test('deterministic summary: model replacement', () => {
  const s = deterministicSummary(baseEntry({ modelChanges: { added: ['Muse Spark 1.2'], removed: ['Muse Spark 1.3'] } }))
  assert.match(s, /Muse Spark 1\.2 replaced Muse Spark 1\.3/)
})

test('deterministic summary: release + new files', () => {
  const s = deterministicSummary(baseEntry({ version: '1.0.688', files: { total: 2, meaningful: 2, added: ['cli/src/new.ts'], removed: [], renamed: [], modified: [] } }))
  assert.match(s, /CLI release 1\.0\.688 published/)
  assert.match(s, /New files: `cli\/src\/new\.ts`/)
})

test('deterministic summary: fallback mentions areas and churn', () => {
  const s = deterministicSummary(baseEntry())
  assert.match(s, /Shared\/Core changes across 1 file/)
})

test('entryTitle derives readable headline', () => {
  assert.match(entryTitle(baseEntry({ modelChanges: { added: ['GLM 5.4'], removed: [] } })), /New model: GLM 5\.4/)
  assert.match(entryTitle(baseEntry({ version: '1.0.700' })), /Version 1\.0\.700/)
  assert.match(entryTitle(baseEntry()), /update/)
})

test('sync detection + source sha parse', () => {
  const c = { subject: 'Sync public snapshot from freebuff-private', body: 'Source: CodebuffAI/freebuff-private@' + 'a'.repeat(40) }
  assert.ok(isSyncCommit(c))
  assert.equal(sourceRef(c), 'a'.repeat(40))
  assert.ok(!isSyncCommit({ subject: 'Add thing (#12)' }))
})

test('model table: ignores product tables like Choose your Freebuff', () => {
  const patch = [
    'diff --git a/README.md b/README.md',
    '@@ -8,6 +8,6 @@',
    ' | Product | What it does | Get started |',
    '-| **Freebuff Desktop** | Run agents | link |',
    '+| **Freebuff Desktop** | Run parallel agents locally | link |',
    '-| **Freebuff CLI** | Terminal | link |',
    '+| **Freebuff CLI** | Code in terminal | link |'
  ].join('\n')
  const r = extractModelTableChanges(patch)
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
})

test('model table: description edit yields no self-replacement', () => {
  const patch = [
    'diff --git a/README.md b/README.md',
    '@@ -35,2 +35,2 @@',
    '-| **DeepSeek V4 Pro 08/13** | Full access | Old description |',
    '+| **DeepSeek V4 Pro 08/13** | Full access | New description with extra details |'
  ].join('\n')
  const r = extractModelTableChanges(patch)
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.removed, [])
})

test('slash command: quotes, backticks, and net set diff', () => {
  const patch = [
    "+\tname: '/undo',",
    '+\tname: "/redo",',
    '+\tname: `/compact`,',
    '-\tname: \'/compact\','
  ].join('\n')
  const r = extractSlashCommandChanges(patch)
  assert.deepEqual(r.added.sort(), ['/redo', '/undo'])
  assert.deepEqual(r.removed, [])
})

test('noise files: catches nested and binary lockfiles', () => {
  assert.ok(isNoiseFile('bun.lockb'))
  assert.ok(isNoiseFile('test/bun.lockb'))
  assert.ok(isNoiseFile('web/bun.lock'))
  assert.ok(isNoiseFile('pnpm-lock.yaml'))
  assert.ok(isNoiseFile('.bun-version'))
})

test('extractCommentFacts: only captures added comments and flushes properly', () => {
  const patch = [
    '- // Deprecated model access due to high upstream provider latency.',
    '+ // Re-enabled with new high-throughput fallback endpoints across regions.',
    '+ // Verified under multi-turn stress test with zero token leakage.'
  ].join('\n')
  const facts = extractCommentFacts(patch)
  assert.equal(facts.length, 1)
  assert.ok(facts[0].startsWith('Re-enabled with new high-throughput'))
  assert.ok(!facts[0].includes('Deprecated model access'))
})

test('extractCleanDiff: function is exported and callable', () => {
  assert.equal(typeof extractCleanDiff, 'function')
})


