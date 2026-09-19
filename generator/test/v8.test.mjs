import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ungroundedIdentifiers, groundingCorpus, validateLlmOut, summaryValidator, normalizeEli5,
  templateEli5, pruneStaleCache, cacheKeyVersion, computeShippedIn, isSecurityEntry,
  rememberClosedPrs, contextTier, rewriteRank, buildPrompt, buildEli5Prompt, AUDIENCES,
  PROMPT_V, ELI5_V, ELI5_HYPE_ROLLUP_RE, ELI5_ROLLUP_MAX_CHARS, sequenceForEntry, groupEntriesByDay,
  prSummaryKey, attachPrSummaries, validateVerifyOut
} from '../lib/llm.mjs'
import { significanceOf, securityHint, commitNatureOf } from '../lib/analyze.mjs'
import { applyOverrides, diffShipFilter, repairEntries } from '../cli.mjs'
import { isoWeekOf, buildWeeklyDigests, weeklyHeadline, weeklyFeedItem, summaryQuality } from '../lib/digest.mjs'
import { buildStoryIndex } from '../lib/story.mjs'

const sha = (c) => c.repeat(40)

// ---------------------------------------------------------------------------
// Identifier grounding

test('ungroundedIdentifiers: flags names absent from the corpus, tolerates paths, flags and placeholders', () => {
  const corpus = 'export const FREEBUFF_ENFORCEMENT_EXEMPT_USER_IDS = 1\n common/src/constants/freebuff-cost-mode.ts\n function parseExemptUserIds() {}\n Usage: codebuff --agent <name>'
  const text = 'Adds `parseExemptUserIds` reading `FREEBUFF_ENFORCEION_EXEMPT_USER_IDS` in `common/src/constants/freebuff-cost-mode.ts`; see `codebuff --agent <publisher>/<id>@<version>` and `v1.2.3`.'
  const bad = ungroundedIdentifiers(text, corpus)
  assert.deepEqual(bad, ['FREEBUFF_ENFORCEION_EXEMPT_USER_IDS'], 'typo flagged; command words present, placeholders and versions skipped')
  assert.deepEqual(ungroundedIdentifiers('`codebuff --agnet x`', corpus), ['codebuff --agnet x'], 'a misspelled flag is caught word by word')
  assert.deepEqual(ungroundedIdentifiers('`web/` and `parseExemptUserIds()`', corpus + '\nweb/src/x.ts'), [])
  assert.deepEqual(ungroundedIdentifiers('no ticks here', corpus), [])
  assert.deepEqual(ungroundedIdentifiers('`anything`', ''), [], 'no corpus, no verdict')
})

test('groundingCorpus: includes files, facts, catalog rows, PR text and source context', () => {
  const e = { files: { added: ['a/b.ts'], modified: ['c.ts'], renamed: [{ from: 'x', to: 'y' }] }, facts: ['A fact.'], modelChanges: { added: ['GPT-9'], tables: { 'GPT-9': { after: ['GPT-9', 'Full access'] } } } }
  const c = groundingCorpus(e, 'diff text', { prMeta: { title: 'PR title', body: 'PR body' }, fileHeaders: [{ path: 'h.ts', header: '// header' }], fullFiles: [{ path: 'f.ts', content: 'const inFull = 1' }] })
  for (const s of ['a/b.ts', 'c.ts', 'y', 'A fact.', 'GPT-9', 'Full access', 'PR body', 'header', 'inFull', 'diff text']) assert.ok(c.includes(s), s)
})

test('validateLlmOut: audience normalized, grounding throws once then flags', () => {
  const out = { title: 'Trust gate for remote agents', summary: 'Adds `checkTrust` in `sdk/src/trust.ts`.', significance: 'notable', audience: 'End users', evidence: 'New `sdk/src/trust.ts`.' }
  const clean = validateLlmOut(out, 'minor')
  assert.equal(clean.audience, 'end-users')
  assert.equal(validateLlmOut({ ...out, audience: 'Sponsor' }, 'minor').audience, 'advertisers')
  assert.equal(validateLlmOut({ ...out, audience: 'nonsense' }, 'minor').audience, undefined)
  const corpus = 'sdk/src/trust.ts\nexport function checkTrust'
  assert.deepEqual(validateLlmOut(out, 'minor', { corpus, onUngrounded: 'throw' }).ungrounded, undefined)
  const bad = { ...out, summary: 'Adds `checkTrsut` in `sdk/src/trust.ts`.' }
  assert.throws(() => validateLlmOut(bad, 'minor', { corpus, onUngrounded: 'throw' }), /checkTrsut/)
  assert.deepEqual(validateLlmOut(bad, 'minor', { corpus, onUngrounded: 'flag' }).ungrounded, ['checkTrsut'])
  const v = summaryValidator('minor', corpus)
  assert.throws(() => v(bad), /not present/)
  assert.deepEqual(v(bad).ungrounded, ['checkTrsut'], 'second call is lenient so the entry still lands')
})

test('validateLlmOut: title cap aligned with the index clip (110)', () => {
  const long = 'Word '.repeat(40).trim()
  assert.ok(validateLlmOut({ title: long, summary: 'x.' }).title.length <= 110)
})

test('buildPrompt asks for audience and verbatim identifiers; sequence marks unsummarized siblings', () => {
  const day = '2026-09-18'
  const a = { sha: sha('a'), date: `${day}T10:00:00Z`, day, title: 'Shared/Core update: env-schema', summary: 'x', category: 'Core' }
  const b = { sha: sha('b'), date: `${day}T11:00:00Z`, day, title: 'T', summary: 'x', category: 'Core', ai: { title: 'Real title', summary: 'First sentence. Second sentence.' } }
  const c = { sha: sha('c'), date: `${day}T12:00:00Z`, day, title: 'T', summary: 'x', category: 'Core', files: { added: [], modified: [] } }
  const seq = sequenceForEntry(groupEntriesByDay([a, b, c]), c, 25)
  assert.equal(seq.earlier[0].unsummarized, true)
  assert.equal(seq.earlier[1].unsummarized, undefined)
  assert.equal(seq.earlier[1].summary, 'First sentence.')
  const p = buildPrompt(c, 'diff --git a/x b/x', { sequence: seq })
  assert.match(p, /"audience"/)
  assert.match(p, /verbatim/)
  assert.match(p, /Shared\/Core update: env-schema \(unsummarized\)/)
  for (const aud of AUDIENCES) assert.match(p, new RegExp(aud))
})

// ---------------------------------------------------------------------------
// ELI5 guardrails

test('buildEli5Prompt: derives commit nature when unstored and hands over the audience', () => {
  const e = { sha: sha('a'), day: '2026-09-18', files: { added: [], modified: ['docs/guide.md'], removed: [] }, ai: { title: 't', summary: 's', audience: 'operators' } }
  const p = buildEli5Prompt(e, [], {})
  assert.match(p, /Commit nature: docs-only/)
  assert.match(p, /Audience \(classified by the technical pass[^)]*\): operators/)
  assert.match(p, /Operator settings are not user settings/)
  assert.match(p, /Never define the reader in an aside/)
})

test('buildEli5Prompt roll-up carries anti-marketing rules', () => {
  const p = buildEli5Prompt({ version: '1.0.1', ai: { title: 'x' } }, [], { releaseCtx: 'Updates included in this release:\n- 2026-09-18 A thing' })
  assert.match(p, /No marketing/)
  assert.match(p, /Together, these changes make/)
})

test('normalizeEli5: strips "you (the person ...)" asides and rejects hype', () => {
  assert.equal(normalizeEli5('When you (the person using the assistant in their terminal) log in, the key travels with you.'), 'When you log in, the key travels with you.')
  assert.throws(() => normalizeEli5('This release makes your coding sessions smarter and more capable.', ELI5_ROLLUP_MAX_CHARS), /marketing/)
  assert.throws(() => normalizeEli5('We are excited to announce a new model in the picker today.'), /marketing/)
  assert.throws(() => normalizeEli5('Checksums are verified. Together, these changes make Freebuff safer.'), /marketing/)
  // "faster" is the literal content of a perf fix: allowed on single rows.
  assert.equal(normalizeEli5('Startup is faster because the index loads lazily.'), 'Startup is faster because the index loads lazily.')
  assert.ok(ELI5_HYPE_ROLLUP_RE.test('faster'))
})

test('templateEli5: test-only and docs-only rows get a fixed line; bumps, facts and shipped code do not', () => {
  const testOnly = { files: { added: [], modified: ['a/__tests__/x.test.ts'], removed: [] } }
  assert.match(templateEli5(testOnly), /automated tests/)
  assert.match(templateEli5({ files: { added: [], modified: ['docs/a.md'], removed: [] } }), /documentation/)
  assert.equal(templateEli5({ ...testOnly, facts: ['A comment.'] }), null)
  assert.equal(templateEli5({ files: { added: [], modified: ['src/a.ts'], removed: [] } }), null)
  assert.equal(templateEli5({ version: '1.0.2', files: { added: [], modified: ['cli/release/package.json'], removed: [], meaningful: 1 } }), null)
  assert.equal(templateEli5({ noise: true, files: {} }), null)
})

// ---------------------------------------------------------------------------
// Cache, ordering, tiering

test('pruneStaleCache drops keys from retired prompt versions only', () => {
  const cache = {
    [`${sha('a')}:v5:abc`]: { title: 'old' },
    [`${sha('a')}:v${PROMPT_V}:abc`]: { title: 'new' },
    [`${sha('b')}:eli5:v4:abc`]: { text: 'old' },
    [`${sha('b')}:eli5:v${ELI5_V}:abc`]: { text: 'new' },
    [`${sha('c')}:eli5:v${ELI5_V}:abc:ctx-r8`]: { error: 'x' },
    garbage: { x: 1 }
  }
  assert.equal(pruneStaleCache(cache), 2)
  assert.deepEqual(Object.keys(cache).sort(), [`${sha('a')}:v${PROMPT_V}:abc`, `${sha('b')}:eli5:v${ELI5_V}:abc`, `${sha('c')}:eli5:v${ELI5_V}:abc:ctx-r8`, 'garbage'].sort())
  assert.deepEqual(cacheKeyVersion(`${sha('a')}:eli5:v3:x`), { kind: 'eli5', v: 3 })
  assert.equal(cacheKeyVersion('nope'), null)
})

test('rewriteRank orders major before notable before minor; contextTier scales with the diff', () => {
  assert.ok(rewriteRank({ ai: { significance: 'major' } }) < rewriteRank({ significance: 'notable' }))
  assert.ok(rewriteRank({ significance: 'notable' }) < rewriteRank({}))
  assert.equal(contextTier('a'.repeat(100), ['one.ts']), 'small')
  assert.equal(contextTier('a'.repeat(100), ['one.ts', 'two.ts']), 'full')
  assert.equal(contextTier('a'.repeat(5000), ['one.ts']), 'full')
})

test('validateVerifyOut: empty issues means supported', () => {
  assert.deepEqual(validateVerifyOut({ supported: true, issues: [] }), { supported: true, issues: [] })
  assert.equal(validateVerifyOut({ supported: true, issues: ['claims X'] }).supported, false)
  assert.equal(validateVerifyOut({ issues: [] }).supported, true)
})

// ---------------------------------------------------------------------------
// Release membership, security, merged PRs, PR previews

test('computeShippedIn: rows belong to the next bump of each track', () => {
  const row = (c, day, extra = {}) => ({ sha: sha(c), date: `${day}T10:00:00Z`, day, files: { added: [], modified: ['src/x.ts'], meaningful: 1 }, ...extra })
  const bump = (c, day, path, version) => ({ sha: sha(c), date: `${day}T20:00:00Z`, day, version, files: { added: [], modified: [path], meaningful: 1 }, versionTrack: path.startsWith('freebuff') ? 'freebuff-cli' : 'codebuff-cli' })
  const entries = [
    row('a', '2026-09-16'),
    bump('b', '2026-09-16', 'freebuff/cli/release/package.json', '0.0.177'),
    row('c', '2026-09-17'),
    bump('d', '2026-09-17', 'cli/release/package.json', '1.0.690'),
    row('e', '2026-09-18')
  ]
  const m = computeShippedIn(entries)
  assert.equal(m.get(sha('a'))['freebuff-cli'].version, '0.0.177')
  assert.equal(m.get(sha('a'))['codebuff-cli'].version, '1.0.690')
  assert.equal(m.get(sha('c'))['freebuff-cli'], undefined, 'no 0.0.x bump after c yet')
  assert.equal(m.get(sha('c'))['codebuff-cli'].version, '1.0.690')
  assert.equal(m.get(sha('e')), undefined, 'not shipped yet')
})

test('isSecurityEntry and securityHint: trust gates, checksums and env stripping qualify; a README edit does not', () => {
  assert.ok(isSecurityEntry({ files: { added: ['sdk/src/agent-publisher-trust.ts'], modified: [] } }))
  assert.ok(isSecurityEntry({ files: { added: [], modified: ['x.ts'] }, ai: { title: 'Launcher verifies archive checksums before install', summary: 'sha256.' } }))
  assert.equal(isSecurityEntry({ files: { added: [], modified: ['README.md'] }, ai: { title: 'Fix typo', summary: 'A typo.' } }), false)
  assert.equal(isSecurityEntry({ noise: true }), false)
  assert.ok(securityHint({ files: { modified: ['cli/src/utils/auth.ts'] } }))
  assert.ok(securityHint({ files: { modified: ['x.ts'] }, messageTitle: 'fix: refuse untrusted publishers' }))
  assert.equal(securityHint({ files: { modified: ['x.ts'] }, messageTitle: 'chore: bump deps' }), false)
})

test('rememberClosedPrs: PRs that left the open list are kept with what the prompt needs', () => {
  const prev = [{ number: 1, title: 'A', body: 'why A', labels: [{ name: 'cli' }], commitsList: [{ sha: 'abc', message: 'm', author: 'x' }] }, { number: 2, title: 'B' }]
  const { doc, added } = rememberClosedPrs(prev, [{ number: 2 }], { prs: [] }, '2026-09-18T00:00:00Z')
  assert.equal(added, 1)
  assert.deepEqual(doc.prs.map(p => p.number), [1])
  assert.deepEqual(doc.prs[0].labels, ['cli'])
  assert.deepEqual(doc.prs[0].commitsList, [{ sha: 'abc', message: 'm' }])
  assert.equal(doc.prs[0].body, 'why A')
  const again = rememberClosedPrs(prev, [{ number: 2 }], doc, '2026-09-19T00:00:00Z')
  assert.equal(again.added, 0, 'idempotent')
})

test('attachPrSummaries: exact diff-hash hit first, newest record per number as fallback', () => {
  const pr = { number: 7, title: 't' }
  const cache = { [prSummaryKey(pr, 'DIFF')]: { title: 'exact', summary: 's', at: '2026-01-01' }, '7:v1:other': { title: 'older', summary: 's', at: '2025-01-01' }, '8:v1:x': { error: 'e' } }
  assert.equal(attachPrSummaries([pr], cache, () => 'DIFF'), 1)
  assert.equal(pr.ai.title, 'exact')
  const pr2 = { number: 7 }
  attachPrSummaries([pr2], cache, () => 'changed')
  assert.equal(pr2.ai.title, 'exact', 'newest record wins when the hash misses')
  const pr3 = { number: 8 }
  assert.equal(attachPrSummaries([pr3], cache), 0, 'error records never attach')
})

// ---------------------------------------------------------------------------
// Deterministic weight, repair, overrides, dist trim

test('significanceOf: bump-only rows are notable with a reason; bumps shipping code stay major', () => {
  const bumpOnly = { version: '1.0.1', files: { added: [], removed: [], modified: ['cli/release/package.json'], meaningful: 1 }, stats: { additions: 1, deletions: 1 } }
  assert.deepEqual(significanceOf(bumpOnly), { significance: 'notable', reason: 'version bump' })
  const bumpPlus = { version: '1.0.1', files: { added: ['src/new.ts'], removed: [], modified: ['cli/release/package.json'], meaningful: 2 }, stats: { additions: 90, deletions: 1 } }
  assert.equal(significanceOf(bumpPlus).significance, 'major')
  assert.equal(significanceOf({ modelChanges: { added: ['X'] }, files: {} }).significance, 'major')
  assert.equal(significanceOf({ files: { added: [], removed: [], modified: ['a.ts'] }, stats: { additions: 300, deletions: 200 } }).reason, 'large change (500 lines)')
  assert.equal(significanceOf({ files: { added: [], removed: [], modified: ['a.ts'] }, stats: { additions: 3, deletions: 2 } }).significance, 'minor')
})

test('repairEntries fills commitNature, significanceReason and the security tag without touching text', () => {
  const e = { sha: sha('a'), title: 'T', summary: 'S', ai: { title: 'AI' }, files: { added: [], removed: [], modified: ['cli/src/utils/auth.ts'], meaningful: 1 }, stats: { additions: 5, deletions: 1 }, significance: 'major', tags: ['cli'] }
  assert.equal(repairEntries([e]), 1)
  assert.equal(e.commitNature, 'production')
  assert.equal(e.significance, 'minor')
  assert.equal(e.significanceReason, 'edits to existing files')
  assert.ok(e.tags.includes('security'))
  assert.equal(e.ai.title, 'AI')
  assert.equal(e.title, 'T')
  assert.equal(repairEntries([e]), 0, 'idempotent')
  const churn = { noise: true, files: {} }
  repairEntries([churn])
  assert.equal(churn.commitNature, 'churn')
  assert.equal(commitNatureOf({ files: { added: [], modified: ['a/__tests__/b.test.ts'], removed: [] } }), 'test-only')
})

test('applyOverrides: full sha or prefix, fields merged, marked as human-edited', () => {
  const e = { sha: sha('a'), title: 'T', summary: 'S', significance: 'minor', ai: { model: 'm', v: 7, title: 'AI', summary: 'AI sum', ungrounded: ['x'] }, eli5: { text: 'old', v: 6 } }
  const n = applyOverrides([e, { sha: sha('b'), title: 'B' }], { [sha('a').slice(0, 12)]: { title: 'Fixed title', eli5: 'Plain line.', significance: 'notable', note: 'typo' }, 'not-a-sha': { title: 'x' } })
  assert.equal(n, 1)
  assert.equal(e.ai.title, 'Fixed title')
  assert.equal(e.ai.summary, 'AI sum', 'unspecified fields kept')
  assert.equal(e.ai.ungrounded, undefined)
  assert.equal(e.ai.overridden, true)
  assert.equal(e.significance, 'notable')
  assert.equal(e.eli5.text, 'Plain line.')
  assert.equal(e.eli5.model, 'human')
  assert.equal(e.overridden, true)
  assert.equal(applyOverrides([e], {}), 0)
})

test('diffShipFilter: null by default; churn and old rows trimmed when asked', () => {
  assert.equal(diffShipFilter([], {}), null)
  const f = diffShipFilter([], { CHANGELOG_DIST_SKIP_CHURN_DIFFS: '1' })
  assert.equal(f({ noise: true }), false)
  assert.equal(f({ day: '2026-09-18' }), true)
  const g = diffShipFilter([], { CHANGELOG_DIST_DIFF_MONTHS: '1' })
  assert.equal(g({ day: '2020-01-01' }), false)
  assert.equal(g({ day: new Date().toISOString().slice(0, 10) }), true)
})

// ---------------------------------------------------------------------------
// Weekly digests, quality, story lookback

test('isoWeekOf and buildWeeklyDigests: ISO weeks, releases first, top capped and ranked', () => {
  assert.deepEqual(isoWeekOf('2026-09-18'), { key: '2026-W38', monday: '2026-09-14', sunday: '2026-09-20' })
  assert.equal(isoWeekOf('2024-12-30').key, '2025-W01')
  assert.equal(isoWeekOf('garbage'), null)
  const mk = (c, day, extra = {}) => ({ sha: sha(c), date: `${day}T10:00:00Z`, day, title: `T${c}`, summary: 's', significance: 'minor', files: { added: [], modified: ['x.ts'] }, ...extra })
  const entries = [
    mk('a', '2026-09-14'),
    mk('b', '2026-09-15', { significance: 'major', ai: { title: 'Big', summary: 's', significance: 'major' } }),
    mk('c', '2026-09-16', { version: '1.0.1', files: { added: [], modified: ['cli/release/package.json'], meaningful: 1 } }),
    mk('d', '2026-09-17', { modelChanges: { added: ['GPT-9'], removed: [] } }),
    mk('e', '2026-09-21'),
    mk('f', '2026-09-18', { noise: true })
  ]
  const weeks = buildWeeklyDigests(entries, { topN: 1 })
  assert.deepEqual(weeks.map(w => w.key), ['2026-W39', '2026-W38'])
  const w = weeks[1]
  assert.equal(w.counts.changes, 4, 'noise excluded')
  assert.deepEqual(w.releases.map(e => e.sha), [sha('c')])
  assert.deepEqual(w.models.map(e => e.sha), [sha('d')])
  assert.deepEqual(w.top.map(e => e.sha), [sha('b')], 'major first, bumps and catalog moves excluded, capped')
  assert.match(weeklyHeadline(w), /1 release, 1 model catalog change, 4 changes over 4 days/)
  const item = weeklyFeedItem('https://x.test', w)
  assert.match(item, /<link>https:\/\/x.test\/week\/2026-W38\/<\/link>/)
  assert.match(item, /Releases/)
  assert.doesNotMatch(item, /undefined/)
})

test('summaryQuality counts prompt coverage, grounding flags, hype and audience', () => {
  const rows = [
    { ai: { v: PROMPT_V, title: 't', summary: 's', evidence: 'e', audience: 'end-users', ungrounded: ['x'] }, eli5: { v: ELI5_V, text: 'Plain.' }, commitNature: 'production' },
    { ai: { v: 5, title: 't', summary: 'Scope limited to x.' }, eli5: { v: 4, text: 'Behind the scenes, it is smarter.' } },
    { noise: true, ai: { v: 1, title: 'ignored' } }
  ]
  const q = summaryQuality(rows)
  assert.equal(q.changes, 2)
  assert.equal(q.onCurrentPrompt, 1)
  assert.equal(q.stalePrompt, 1)
  assert.equal(q.ungrounded, 1)
  assert.equal(q.scopeBoilerplate, 1)
  assert.equal(q.eli5Preamble, 1)
  assert.equal(q.eli5Hype, 1)
  assert.equal(q.natureMissing, 1)
  assert.equal(q.audience['end-users'], 1)
  assert.equal(q.audienceUnset, 1)
})

test('story index: a next-day bump joins the previous day cluster and keeps its own day in links', () => {
  const line = 'Singapore lost full access to the free tier on September 16.'
  // Two shared identifiers: the linker needs a shared specific path or two
  // shared tokens, and a bump touches only a generic manifest.
  const a = { sha: sha('a'), day: '2026-09-16', date: '2026-09-16T10:00:00Z', title: 'Country list', files: { added: [], modified: ['common/src/freebuff-countries.ts'] }, ai: { title: 'Country list update', summary: `${line} FREEBUFF_COUNTRY_TIERS and FREEBUFF_FULL_ACCESS_COUNTRIES updated.` }, eli5: { text: line }, facts: [line] }
  const bump = { sha: sha('b'), day: '2026-09-17', date: '2026-09-17T02:00:00Z', version: '1.0.5', title: 'Version 1.0.5', files: { added: [], modified: ['cli/release/package.json'], meaningful: 1 }, ai: { title: 'CLI 1.0.5 ships the FREEBUFF_COUNTRY_TIERS list', summary: 'FREEBUFF_FULL_ACCESS_COUNTRIES now holds every country approved for full access; eligibility is unchanged today.' }, eli5: { text: 'A single list now holds every country approved for full access. This does not change who is eligible today.' } }
  const idx = buildStoryIndex([a, bump])
  const clusters = idx.days.get('2026-09-16') || []
  assert.ok(clusters.some(c => c.members.some(m => m.sha === sha('b'))), 'bump borrowed into the previous day')
  assert.equal(idx.days.has('2026-09-17'), false, 'a lone borrowed bump seeds no cluster of its own')
  const note = idx.notes.get(sha('b'))
  assert.ok(note && note.length, 'the reassuring bump line gets the access note')
  assert.equal(note[0].day, '2026-09-16', 'note links point at the peer\'s own day')
})
