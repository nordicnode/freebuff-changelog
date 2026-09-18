// generator/test/analyze.test.mjs - unit tests for the pure extractors
// (node --test, zero dependencies).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractModelTableChanges, extractVersionBump, extractSlashCommandChanges, isBumpEntry, versionTrackOf, VERSION_TRACKS,
  commandIdsFromRegistry,
  areaOf, isNoiseFile, deterministicSummary, entryTitle, churnLabel, testLabel, sourceRef, isSyncCommit,
  extractCommentFacts, extractCleanDiff, extractRawDiff, extractFileHeaders, EMPTY_TREE, parseMarkdownTables, catalogFromReadme,
  diffCatalogs, commitNatureOf, analyzeCommunityCommit, analyzeSyncCommit,
  MONOREPO_COMPONENTS, formatArchitectureMap, discoverMonorepoArchitecture,
  findFileHistory, extractFullOrOutlinedFiles, extractSubsystemDocs
} from '../lib/analyze.mjs'
import { toUtc, ymd } from '../lib/util.mjs'

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
  // A terse sentence about money and an acronym breaks its own lowercase runs.
  // Counting runs rather than words threw this away -- and with it the only line
  // in the change that says who the program is for.
  assert.deepEqual(
    extractCommentFacts('+ /** Verified YC companies earn one $1,000 credit only after $1,000 is collected. */'),
    ['Verified YC companies earn one $1,000 credit only after $1,000 is collected.'])
  assert.deepEqual(extractCommentFacts('+ // fooBar\n+ // x = y'), [], 'identifier junk still dies')
})

test('extractCommentFacts: captures surrounding context comments when no additions present', () => {
  const patch = [
    ' /**',
    '  * Bounds for a placements campaign daily cap in cents.',
    '  * Self-serve ceiling for advertiser campaign budgets.',
    '  */',
    ' export const PLACEMENT_DAILY_CAP_MIN_CENTS = 500;',
    '-export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 2500;',
    '+export const PLACEMENT_DAILY_CAP_DEFAULT_CENTS = 10000;'
  ].join('\n')
  const facts = extractCommentFacts(patch)
  assert.ok(facts.length >= 1)
  assert.match(facts[0], /Bounds for a placements campaign/i)
})

test('extractCleanDiff: function is exported and callable', () => {
  assert.equal(typeof extractCleanDiff, 'function')
})

test('catalogFromReadme: header-gated, product rows excluded', () => {
  const text = [
    '| Product | What it does | Get started |',
    '|---|---|---|',
    '| **Freebuff Enterprise** | Custom deployments | link |',
    '',
    '| Model | Access | Best for |',
    '|---|---|---|',
    '| **Muse Spark 1.2** | Full access | Fast |',
    '| **GPT-5.6 Luna** | Full access | Strong |'
  ].join('\n')
  const names = catalogFromReadme(text)
  assert.ok(names.has('Muse Spark 1.2'))
  assert.ok(names.has('GPT-5.6 Luna'))
  assert.ok(!names.has('Freebuff Enterprise'))
})

test('catalogFromReadme: Chinese headers work', () => {
  const text = [
    '| 模型 | 访问范围 | 适用场景 |',
    '|---|---|---|',
    '| **Muse Spark 1.2** | 完整访问 | 快速 |',
    '',
    '| 产品 | 功能 | 开始使用 |',
    '|---|---|---|',
    '| **Freebuff CLI** | 从终端编程 | link |'
  ].join('\n')
  const names = catalogFromReadme(text)
  assert.ok(names.has('Muse Spark 1.2'))
  assert.ok(!names.has('Freebuff CLI'))
})

test('diffCatalogs: description edit yields no changes', () => {
  const before = new Set(['Muse Spark 1.2', 'GPT-5.6 Luna'])
  const after = new Set(['Muse Spark 1.2', 'GPT-5.6 Luna'])
  assert.deepEqual(diffCatalogs(before, after), { added: [], removed: [] })
})

test('diffCatalogs: swap detected as add+remove', () => {
  const before = new Set(['Muse Spark 1.3'])
  const after = new Set(['Muse Spark 1.2'])
  assert.deepEqual(diffCatalogs(before, after), { added: ['Muse Spark 1.2'], removed: ['Muse Spark 1.3'] })
})

test('parseMarkdownTables: groups consecutive pipe lines', () => {
  const text = ['| a | b |', '|---|---|', '| **x** | y |', '', 'prose', '', '| c | d |', '|---|---|'].join('\n')
  const tables = parseMarkdownTables(text)
  assert.equal(tables.length, 2)
  assert.equal(tables[0].length, 3)
})

test('commandIdsFromRegistry: extracts string ids, ignores comments', () => {
  const text = [
    "const ALL_SLASH_COMMANDS: SlashCommand[] = [",
    "  {",
    "    id: 'help',",
    "    label: 'help',",
    "  },",
    "  //   id: 'undo',",
    "  //   label: 'undo',",
    "  {",
    '    id: "plan",',
    "  },",
    "  {",
    "    id: 'agent:gpt-5',",
    "  },",
    "]"
  ].join('\n')
  const ids = commandIdsFromRegistry(text)
  assert.ok(ids.has('help'))
  assert.ok(ids.has('plan'))
  assert.ok(ids.has('agent:gpt-5'))
  assert.ok(!ids.has('undo'))
  assert.equal(ids.size, 3)
})

test('commandIdsFromRegistry: description-only edit yields identical sets', () => {
  const a = "  id: 'help',\n  description: 'old text',"
  const b = "  id: 'help',\n  description: 'new text',"
  assert.deepEqual([...commandIdsFromRegistry(a)], [...commandIdsFromRegistry(b)])
})

// Churn rows are listed rather than dropped, so their description has to be
// true. Before files.churned was captured, the *source* file list was empty for
// these commits and 1,788 lockfile syncs were published as "Merge commit".
test('churnLabel: names the filtered files; only a truly empty diff is a merge', () => {
  const lock = churnLabel({
    files: { total: 1, meaningful: 0, added: [], removed: [], modified: [], churned: ['bun.lock'] },
    stats: { additions: 49, deletions: 55 }
  })
  assert.equal(lock.kind, 'lockfile')
  assert.equal(lock.title, 'Dependency lockfile updated')
  assert.match(lock.summary, /`bun\.lock`/)
  assert.doesNotMatch(lock.summary, /merge/i)

  const assets = churnLabel({
    files: { total: 2, meaningful: 0, churned: ['snapcraft/icons/app.svg', 'cli/assets/logo.svg'] },
    stats: { additions: 1, deletions: 1 }
  })
  assert.equal(assets.kind, 'assets')

  const mixed = churnLabel({
    files: { total: 2, meaningful: 0, churned: ['bun.lock', 'snapcraft/icons/app.svg'] },
    stats: { additions: 3, deletions: 1 }
  })
  assert.equal(mixed.kind, 'other')

  const merge = churnLabel({ files: { total: 0, meaningful: 0, churned: [] }, stats: { additions: 0, deletions: 0 } })
  assert.equal(merge.kind, 'merge')

  // Rows written before churn paths existed: files counted, names unknown. They
  // must not be invented into merges either.
  const legacy = churnLabel({ files: { total: 1, meaningful: 0 }, stats: { additions: 2, deletions: 1 } })
  assert.equal(legacy.kind, 'other')
  assert.doesNotMatch(legacy.summary, /merge/i)
})

// Test-only snapshot commits have empty *source* file lists, so their rows were
// titled "Shared/Core update" and named nothing.
test('testLabel: describes the suite movement the source lists drop', () => {
  const l = testLabel({
    files: { total: 2, meaningful: 0, tests: ['packages/agent-runtime/src/run-agent-step.test.ts', 'cli/src/__tests__/foo.spec.ts'] },
    stats: { additions: 120, deletions: 3 }
  })
  assert.match(l.title, /run-agent-step/)
  assert.match(l.summary, /^Tests only/)
  assert.match(l.summary, /`run-agent-step`/)
  assert.match(l.summary, /\+120\/−3/)

  const bare = testLabel({ files: { total: 1, meaningful: 0 }, stats: { additions: 4, deletions: 1 } })
  assert.equal(bare.title, 'Test suite updated')
  assert.match(bare.summary, /1 file/)
})

// The diff extractor shells out to a real repository, so this builds one: a root
// commit (no parent -- the base has to be the empty tree), a lockfile-only commit
// (empty in the clean form by construction, which is why churn stores the raw
// form), and a size cap that must hold without ever letting git's output through
// the process buffer -- a 67 MB snapshot diff once threw there and killed an
// entire backfill run.
test('diff extraction: root commit, lockfile fallback, bounded output', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-diffrepo-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'bun.lock'), 'x'.repeat(2000))
  g('add', '.')
  g('commit', '-q', '-m', 'root: lockfile only')
  const root = g('rev-parse', 'HEAD').trim()

  assert.equal((await extractCleanDiff(dir, EMPTY_TREE, root)).trim(), '',
    'the clean form drops the lockfile, so a lock-only commit has nothing to show')
  const raw = await extractRawDiff(dir, EMPTY_TREE, root)
  assert.match(raw, /^diff --git a\/bun\.lock/, 'the raw form keeps it: that IS the change')
  assert.doesNotMatch(raw, /diff truncated/, 'a small diff is not marked as cut')

  await writeFile(join(dir, 'big.ts'), Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i}`).join('\n'))
  g('add', '.')
  g('commit', '-q', '-m', 'big')
  const big = g('rev-parse', 'HEAD').trim()
  const capped = await extractCleanDiff(dir, root, big, 5000)
  assert.ok(capped.length <= 5100, `held to the budget, got ${capped.length}`)
  assert.match(capped, /diff truncated: view full diff on GitHub/, 'and it says so')
})

// Every comparison downstream is a string compare or a slice(0,10), and both
// ignore a UTC offset: a commit at 17:25-08:00 is 01:25Z the next day, and it was
// being filed under the author's local calendar day. listCommits normalizes at the
// boundary -- this is that normalizer.
test('toUtc: offsets collapse to Z, UTC and junk pass through', () => {
  assert.equal(toUtc('2025-11-24T17:25:50-08:00'), '2025-11-25T01:25:50.000Z')
  assert.equal(toUtc('2026-09-12T10:00:00Z'), '2026-09-12T10:00:00Z')
  assert.equal(ymd(toUtc('2025-11-24T17:25:50-08:00')), '2025-11-25', 'the day key follows UTC, not the author')
  assert.equal(toUtc(''), '')
  assert.equal(toUtc('not a date'), 'not a date')
})

test('commitNatureOf classifies test-only, docs-only, config-only, churn, release-bump, and production', () => {
  assert.equal(commitNatureOf({ noise: true }), 'churn')
  assert.equal(commitNatureOf({ version: '1.0.688', files: { modified: ['cli/package.json'] } }), 'release-bump')
  assert.equal(commitNatureOf({ files: { added: ['test/unit.test.ts', 'mock/data.json'] } }), 'test-only')
  assert.equal(commitNatureOf({ files: { modified: ['docs/guide.md', 'README.md'] } }), 'docs-only')
  assert.equal(commitNatureOf({ files: { modified: ['.eslintrc.json', 'tsconfig.json'] } }), 'config-only')
  assert.equal(commitNatureOf({ files: { modified: ['cli/src/main.ts', 'test/main.test.ts'] } }), 'production')
})

test('commit messageBody: extracted on community and sync commits, stripping source line', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const repoMeta = { repoUrl: 'https://github.com/CodebuffAI/freebuff', compareUrl: 'https://github.com/CodebuffAI/freebuff/compare' }
  const communityCommit = {
    sha: '1234567890abcdef1234567890abcdef12345678',
    subject: 'fix: improve token handling (#100)',
    body: 'This improves token handling by streaming chunks.\nDetailed explanation here.',
    author: 'alice',
    date: '2026-09-17T12:00:00Z'
  }
  const commEntry = await analyzeCommunityCommit('', communityCommit, null, repoMeta)
  assert.equal(commEntry.messageBody, 'This improves token handling by streaming chunks.\nDetailed explanation here.')

  const dir = await mkdtemp(join(tmpdir(), 'fbweb-syncbody-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  await writeFile(join(dir, 'a.txt'), '1\n')
  g('add', '.')
  g('commit', '-q', '-m', 'root')
  const prevSha = g('rev-parse', 'HEAD').trim()

  await writeFile(join(dir, 'a.txt'), '2\n')
  g('add', '.')
  g('commit', '-q', '-m', 'sync: mirror updates', '-m', 'Source: upstream/freebuff@1234567890abcdef1234567890abcdef12345678\nFix crash on startup when config file is missing.')
  const commitSha = g('rev-parse', 'HEAD').trim()

  const syncCommit = {
    sha: commitSha,
    subject: 'sync: mirror updates',
    body: 'Source: upstream/freebuff@1234567890abcdef1234567890abcdef12345678\nFix crash on startup when config file is missing.',
    author: 'bob',
    date: '2026-09-17T13:00:00Z'
  }
  const syncEntry = await analyzeSyncCommit(dir, syncCommit, prevSha, repoMeta)
  assert.equal(syncEntry.messageBody, 'Fix crash on startup when config file is missing.')
})

test('MONOREPO_COMPONENTS & formatArchitectureMap: contains verified monorepo subsystems', () => {
  assert.ok(Array.isArray(MONOREPO_COMPONENTS))
  assert.ok(MONOREPO_COMPONENTS.length >= 12)
  const prefixes = MONOREPO_COMPONENTS.map(c => c.prefix)
  assert.ok(prefixes.includes('cli/'))
  assert.ok(prefixes.includes('packages/agent-runtime/'))
  assert.ok(prefixes.includes('packages/code-map/'))
  assert.ok(prefixes.includes('packages/llm-providers/'))
  assert.ok(prefixes.includes('common/'))
  assert.ok(prefixes.includes('sdk/'))

  const formatted = formatArchitectureMap(MONOREPO_COMPONENTS)
  assert.match(formatted, /^Freebuff Monorepo Architecture Context:/)
  assert.match(formatted, /- `cli\/`: /)
  assert.match(formatted, /- `packages\/agent-runtime\/`: /)
})

test('discoverMonorepoArchitecture: dynamic discovery of unknown subsystems and packages', async (t) => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  // Case 1: no repoDir returns default MONOREPO_COMPONENTS
  const fallback = await discoverMonorepoArchitecture(null)
  assert.equal(fallback.length, MONOREPO_COMPONENTS.length)

  // Case 2: dynamic git repo with a new top-level dir and a new package
  const dir = await mkdtemp(join(tmpdir(), 'fbweb-arch-test-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')

  // Create known directory
  await mkdir(join(dir, 'cli'), { recursive: true })
  await writeFile(join(dir, 'cli', 'index.ts'), 'export const cli = 1\n')

  // Create new unknown top-level subsystem
  await mkdir(join(dir, 'plugins'), { recursive: true })
  await writeFile(join(dir, 'plugins', 'README.md'), 'Freebuff plugins\n')

  // Create new packages/ subsystem with package.json
  await mkdir(join(dir, 'packages', 'vector-search'), { recursive: true })
  await writeFile(join(dir, 'packages', 'vector-search', 'package.json'), JSON.stringify({
    name: '@freebuff/vector-search',
    description: 'Semantic vector search engine for codebase indexing.'
  }))

  g('add', '.')
  g('commit', '-q', '-m', 'feat: initial monorepo with custom packages')

  const discovered = await discoverMonorepoArchitecture(dir, 'HEAD')
  const discoveredPrefixes = discovered.map(c => c.prefix)

  assert.ok(discoveredPrefixes.includes('cli/'))
  assert.ok(discoveredPrefixes.includes('plugins/'))
  assert.ok(discoveredPrefixes.includes('packages/vector-search/'))

  const vectorSearch = discovered.find(c => c.prefix === 'packages/vector-search/')
  assert.equal(vectorSearch?.area, 'Vector Search')
  assert.equal(vectorSearch?.desc, 'Semantic vector search engine for codebase indexing.')

  const plugins = discovered.find(c => c.prefix === 'plugins/')
  assert.equal(plugins?.area, 'Plugins')
  assert.equal(plugins?.desc, 'Monorepo subsystem plugins/')
})

test('extractFileHeaders: extracts top comment blocks and markdown overviews while filtering test files', async (t) => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  const dir = await mkdtemp(join(tmpdir(), 'fbweb-headers-test-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')

  // File 1: JSDoc block comment
  await mkdir(join(dir, 'common', 'src', 'ads'), { recursive: true })
  await writeFile(join(dir, 'common', 'src', 'ads', 'campaigns.ts'), `/**
 * Ad placement campaigns and self-serve advertiser spending limits.
 * Not related to developer coding sessions or token credits.
 */

export const PLACEMENT_DEFAULT = 10000;
`)

  // File 2: Line comments with shebang
  await mkdir(join(dir, 'cli', 'bin'), { recursive: true })
  await writeFile(join(dir, 'cli', 'bin', 'run.mjs'), `#!/usr/bin/env node
// Freebuff CLI entrypoint.
// Initializes direnv sandbox and boots interactive REPL.

import { run } from './cli.js';
`)

  // File 3: Markdown documentation
  await writeFile(join(dir, 'README.md'), `# Freebuff AI Agent
Freebuff is an open-source coding agent designed for terminal and desktop environments.
`)

  // File 4: Test file (should be excluded)
  await writeFile(join(dir, 'common', 'src', 'ads', 'campaigns.test.ts'), `// Test suite for campaigns\n`)

  g('add', '.')
  g('commit', '-q', '-m', 'feat: initial files')

  const files = [
    'common/src/ads/campaigns.ts',
    'cli/bin/run.mjs',
    'README.md',
    'common/src/ads/campaigns.test.ts'
  ]

  const headers = await extractFileHeaders(dir, 'HEAD', files)
  assert.equal(headers.length, 3)

  const campaignsHeader = headers.find(h => h.path === 'common/src/ads/campaigns.ts')
  assert.ok(campaignsHeader)
  assert.ok(campaignsHeader.header.includes('Ad placement campaigns and self-serve advertiser spending limits'))

  const runHeader = headers.find(h => h.path === 'cli/bin/run.mjs')
  assert.ok(runHeader)
  assert.ok(runHeader.header.includes('Freebuff CLI entrypoint'))
  assert.ok(!runHeader.header.includes('#!/usr/bin/env node'))

  const readmeHeader = headers.find(h => h.path === 'README.md')
  assert.ok(readmeHeader)
  assert.ok(readmeHeader.header.includes('# Freebuff AI Agent'))

  // Verify test file was filtered out
  assert.equal(headers.find(h => h.path.includes('test.ts')), undefined)
})

test('findFileHistory: retrieves up to 10 commits that touched overlapping files across history', () => {
  const entries = []
  for (let i = 1; i <= 15; i++) {
    entries.push({
      sha: `sha${i.toString().padStart(37, '0')}`,
      date: `2026-09-${i.toString().padStart(2, '0')}T10:00:00Z`,
      day: `2026-09-${i.toString().padStart(2, '0')}`,
      title: `Commit #${i}`,
      summary: `Summary of #${i}`,
      noise: i === 5, // noise entry should be skipped
      files: {
        modified: i % 2 === 0 ? ['common/src/ads/campaigns.ts'] : ['cli/src/main.ts'],
        added: []
      }
    })
  }

  // Target entry is #15 which modifies cli/src/main.ts
  const target = entries[14]
  const history = findFileHistory(entries, target, 10)

  // There are 7 previous odd-numbered commits: 13, 11, 9, 7, 5 (noise: skipped), 3, 1 => 6 commits
  assert.equal(history.length, 6)
  assert.equal(history[0].sha, 'sha0000000000000000000000000000000000013'.slice(0, 8))
  assert.deepEqual(history[0].overlap, ['cli/src/main.ts'])
  assert.equal(history[0].title, 'Commit #13')

  // Target entry modifying campaigns.ts
  const targetCampaigns = {
    sha: 'newshatarget000000000000000000000000000',
    date: '2026-09-20T10:00:00Z',
    files: { modified: ['common/src/ads/campaigns.ts'] }
  }
  const campaignsHistory = findFileHistory(entries, targetCampaigns, 10)
  // Even-numbered commits: 14, 12, 10, 8, 6, 4, 2 => 7 commits
  assert.equal(campaignsHistory.length, 7)
  assert.equal(campaignsHistory[0].title, 'Commit #14')
  assert.equal(campaignsHistory[6].title, 'Commit #2')
})

test('extractFullOrOutlinedFiles: splits files by line count into full source vs outlines', async (t) => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  const dir = await mkdtemp(join(tmpdir(), 'fbweb-full-outline-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')

  // 1. Small file (30 lines)
  await mkdir(join(dir, 'common', 'src'), { recursive: true })
  const smallLines = Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')
  await writeFile(join(dir, 'common', 'src', 'small.ts'), smallLines)

  // 2. Large file (260 lines) with exports
  const largeLines = [
    'export const DEFAULT_BUDGET = 500;',
    'export function computeScore(x: number): number { return x * 2; }',
    'export type Mode = "strict" | "loose";',
    ...Array.from({ length: 257 }, (_, i) => `const internalVar${i} = ${i};`)
  ].join('\n')
  await writeFile(join(dir, 'common', 'src', 'large.ts'), largeLines)

  g('add', '.')
  g('commit', '-q', '-m', 'feat: add small and large files')

  const res = await extractFullOrOutlinedFiles(dir, 'HEAD', ['common/src/small.ts', 'common/src/large.ts'])

  assert.equal(res.fullFiles.length, 1)
  assert.equal(res.fullFiles[0].path, 'common/src/small.ts')
  assert.equal(res.fullFiles[0].lines, 30)
  assert.equal(res.fullFiles[0].content, smallLines)

  assert.equal(res.exportOutlines.length, 1)
  assert.equal(res.exportOutlines[0].path, 'common/src/large.ts')
  assert.equal(res.exportOutlines[0].totalLines, 260)
  assert.ok(res.exportOutlines[0].outline.includes('export const DEFAULT_BUDGET'))
  assert.ok(res.exportOutlines[0].outline.includes('export function computeScore'))
  assert.ok(res.exportOutlines[0].outline.includes('export type Mode'))
  assert.ok(!res.exportOutlines[0].outline.includes('internalVar0'))
})

test('extractSubsystemDocs: locates nearest parent README.md guide', async (t) => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  const dir = await mkdtemp(join(tmpdir(), 'fbweb-subsystem-docs-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')

  await mkdir(join(dir, 'packages', 'auth', 'src', 'tokens'), { recursive: true })
  await writeFile(join(dir, 'packages', 'auth', 'README.md'), '# Auth Subsystem\nProvides JWT issuance and OAuth integration.\n')
  await writeFile(join(dir, 'packages', 'auth', 'src', 'tokens', 'jwt.ts'), 'export const TOKEN_TTL = 3600;\n')

  g('add', '.')
  g('commit', '-q', '-m', 'feat: add auth package')

  const docs = await extractSubsystemDocs(dir, 'HEAD', ['packages/auth/src/tokens/jwt.ts'])
  assert.equal(docs.length, 1)
  assert.equal(docs[0].path, 'packages/auth/README.md')
  assert.ok(docs[0].content.includes('# Auth Subsystem'))
  assert.ok(docs[0].content.includes('Provides JWT issuance'))
})


