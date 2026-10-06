// generator/test/retention.test.mjs - the deploy envelope and the retention plan.
//
// What is under test is a guarantee, not a behaviour: dist/ must stay inside the
// Cloudflare Workers static-asset budget no matter how large the changelog gets.
// These tests exercise the arithmetic that makes that true, the ordering trap
// that would break it catastrophically (archiving the NEWEST diffs), and the
// verdict the CI gate reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planAssetRetention,
  fixedAssetCount,
  PER_DAY_FILES,
  PER_RELEASE_FILES,
  DIST_OVERHEAD_FILES
} from '../lib/retention.mjs'
import {
  ASSET_CAP_FILES,
  ASSET_BUDGET_SHARE,
  ASSET_MARGIN_SHARE,
  ASSET_CAP_BYTES_PER_FILE,
  checkDistBudget,
  distBudgetMessage,
  resolveAssetLimits
} from '../lib/distbudget.mjs'

const MiB = 1048576

// A unique 40-char sha per integer, so a corpus can be built by the hundred.
const shaOf = (n) => String(n).padStart(4, '0').repeat(10)

// A day string that sorts correctly, `d` days after 2026-01-01.
const dayOf = (d) => new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10)

const entry = (n, d, hasDiff = true) => ({ sha: shaOf(n), day: dayOf(d), date: `${dayOf(d)}T00:00:00Z`, hasDiff: hasDiff || undefined })

const entryWith = (n, d) => entry(n, d, true)

// ---------------------------------------------------------------------------
// The envelope

test('the envelope: our budget is a share of the Workers cap and keeps margin', () => {
  const l = resolveAssetLimits({})
  assert.equal(l.cap, ASSET_CAP_FILES)
  assert.equal(l.budget, Math.floor(ASSET_CAP_FILES * ASSET_BUDGET_SHARE))
  assert.ok(l.budget < l.cap, 'the budget must sit under the platform cap')
  assert.ok(l.margin >= l.cap * ASSET_MARGIN_SHARE, 'and keep at least the margin share as runway')
})

test('an operator on Workers Paid raises the cap and the budget follows it', () => {
  const l = resolveAssetLimits({ CHANGELOG_ASSET_CAP_FILES: '100000' })
  assert.equal(l.cap, 100000)
  assert.equal(l.budget, 75000, 'the budget is a share of whatever cap is declared')
})

test('a budget can never exceed the cap, and unusable values are ignored', () => {
  assert.equal(resolveAssetLimits({ CHANGELOG_ASSET_BUDGET_FILES: '99999' }).budget, ASSET_CAP_FILES)
  assert.equal(resolveAssetLimits({ CHANGELOG_ASSET_CAP_FILES: '-5' }).cap, ASSET_CAP_FILES)
  assert.equal(resolveAssetLimits({ CHANGELOG_ASSET_BUDGET_FILES: 'nonsense' }).budget, Math.floor(ASSET_CAP_FILES * ASSET_BUDGET_SHARE))
  assert.equal(resolveAssetLimits({ CHANGELOG_ASSET_BUDGET_FILES: '0' }).budget, Math.floor(ASSET_CAP_FILES * ASSET_BUDGET_SHARE))
})

test('fixedAssetCount: everything that is not a per-entry diff', () => {
  assert.equal(fixedAssetCount({}), DIST_OVERHEAD_FILES)
  assert.equal(
    fixedAssetCount({ dayCount: 10, releaseCount: 3, prPreviewCount: 5 }),
    10 * PER_DAY_FILES + 3 * PER_RELEASE_FILES + 5 + DIST_OVERHEAD_FILES
  )
})

// ---------------------------------------------------------------------------
// The plan

const smallLimits = { cap: 20000, budget: 15000, margin: 5000 }

test('a corpus that fits ships every stored diff and reports no tiers', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry(i + 1, i))
  const plan = planAssetRetention({
    entries,
    days: [...new Set(entries.map(e => e.day))],
    releaseCount: 1,
    prPreviewCount: 2,
    limits: smallLimits
  })
  assert.equal(plan.archivedDiffs, 0)
  assert.equal(plan.keptDiffs, 50)
  assert.deepEqual(plan.tiers, [], 'nothing gave way, so no tier ran')
  assert.equal(plan.keep.size, 50)
  assert.equal(plan.archived.size, 0)
  assert.ok(plan.fits)
  assert.ok(plan.projectedFiles <= smallLimits.budget)
})

test('past the budget the newest diffs ship and the oldest are archived', () => {
  // 50 days x 200 entries = 10,000 diffs against a much smaller budget.
  const limits = { cap: 20000, budget: 3000, margin: 17000 }
  const entries = []
  for (let d = 0; d < 50; d++) for (let k = 0; k < 200; k++) entries.push(entry(d * 200 + k, d))
  const days = [...new Set(entries.map(e => e.day))]
  const plan = planAssetRetention({ entries, days, releaseCount: 10, prPreviewCount: 5, limits })

  assert.ok(plan.archivedDiffs > 0, 'something gave way')
  assert.ok(plan.projectedFiles <= limits.budget, 'and the projection is inside the budget')
  assert.ok(plan.fits)
  assert.equal(plan.keep.size, plan.keptDiffs)
  assert.equal(plan.archived.size, plan.archivedDiffs)
  assert.equal(plan.keptDiffs + plan.archivedDiffs, entries.length, 'every candidate is either kept or archived')
  // The newest row must survive and the oldest must not: the direction of the
  // window is the one mistake that would be catastrophic rather than merely
  // wasteful, because it would drop today's diffs and keep 2024's.
  const newest = entries[entries.length - 1]
  const oldest = entries[0]
  assert.ok(plan.keep.has(newest.sha), 'the newest diff ships')
  assert.ok(!plan.keep.has(oldest.sha), 'the oldest diff is archived')
  assert.equal(plan.tiers[0].tier, 'diffs')
})

test('the plan is a function of the corpus, not of the order it is handed over', () => {
  const limits = { cap: 20000, budget: 3000, margin: 17000 }
  const entries = []
  for (let d = 0; d < 20; d++) for (let k = 0; k < 100; k++) entries.push(entry(d * 100 + k, d))
  const days = [...new Set(entries.map(e => e.day))].sort()
  const forward = planAssetRetention({ entries, days, releaseCount: 4, prPreviewCount: 1, limits })
  const reversed = planAssetRetention({ entries: [...entries].reverse(), days, releaseCount: 4, prPreviewCount: 1, limits })
  assert.deepEqual([...reversed.keep].sort(), [...forward.keep].sort(), 'a caller that reverses its corpus must not archive the newest rows')
  assert.equal(reversed.archivedDiffs, forward.archivedDiffs)
  assert.equal(reversed.projectedFiles, forward.projectedFiles)
  assert.equal(reversed.oldestKeptDiffDay, forward.oldestKeptDiffDay)
})

test('rows that never had a stored diff are neither kept nor archived', () => {
  const entries = [entry(1, 0, false), entry(2, 0, true), entry(3, 1, false), entry(4, 1, true)]
  const plan = planAssetRetention({ entries, days: [dayOf(0), dayOf(1)], releaseCount: 0, prPreviewCount: 0, limits: smallLimits })
  assert.equal(plan.candidates, 2)
  assert.equal(plan.keptDiffs, 2)
  assert.equal(plan.archivedDiffs, 0)
  assert.ok(!plan.keep.has(shaOf(1)) && !plan.archived.has(shaOf(1)))
  assert.ok(!plan.keep.has(shaOf(3)) && !plan.archived.has(shaOf(3)))
})

test('the same corpus plans the same way twice', () => {
  const entries = Array.from({ length: 500 }, (_, i) => entry(i + 1, Math.floor(i / 50)))
  const args = { entries, days: [...new Set(entries.map(e => e.day))], releaseCount: 3, prPreviewCount: 7, limits: { cap: 20000, budget: 1000, margin: 19000 } }
  const a = planAssetRetention(args)
  const b = planAssetRetention(args)
  assert.equal(a.projectedFiles, b.projectedFiles)
  assert.deepEqual([...a.keep].sort(), [...b.keep].sort())
  assert.equal(a.message, b.message)
})

test('the og tier is reached only once the fixed families alone outgrow the budget', () => {
  // 400 days of history and a budget smaller than the fixed tail: every diff is
  // already archived, so the social cards are what is left to give up.
  const entries = Array.from({ length: 40 }, (_, i) => entry(i + 1, i))
  const days = Array.from({ length: 400 }, (_, d) => dayOf(d))
  const limits = { cap: 20000, budget: 2000, margin: 18000 }
  const plan = planAssetRetention({ entries, days, releaseCount: 10, prPreviewCount: 5, limits })

  assert.equal(plan.archivedDiffs, 40, 'every diff gave way first')
  assert.ok(plan.dropOgDays.size > 0, 'and then the oldest cards')
  assert.equal(plan.tiers.map(t => t.tier).join(','), 'diffs,og-cards')
  // Oldest first, and no more than the shortfall requires. dayOf(0) is the
  // earliest day in this fixture and dayOf(399) the latest, so the newest day
  // must survive while the earliest one gives up its card.
  assert.ok(plan.dropOgDays.has(dayOf(0)), 'the oldest day loses its card first')
  assert.ok(!plan.dropOgDays.has(dayOf(399)), 'the newest keeps its card')
  assert.equal(plan.dropOgDays.size, plan.fixed - limits.budget, 'and exactly the shortfall gives way, not the whole family')
  assert.ok(plan.projectedFiles <= limits.budget)
  assert.ok(plan.fits)
})

test('a corpus that cannot fit says so instead of pretending', () => {
  // The fixed families alone exceed the budget: no diff to archive, no og card
  // left to drop, and the caller must be told rather than handed a plan that
  // quietly ships more files than the envelope allows.
  const entries = Array.from({ length: 5 }, (_, i) => entry(i + 1, i))
  const days = Array.from({ length: 5000 }, (_, d) => dayOf(d))
  const limits = { cap: 20000, budget: 1000, margin: 19000 }
  const plan = planAssetRetention({ entries, days, releaseCount: 0, prPreviewCount: 0, limits })
  assert.equal(plan.archivedDiffs, 5)
  assert.equal(plan.fits, false)
  assert.ok(plan.projectedFiles > limits.budget)
  assert.match(plan.message, /OVER BUDGET/)
})

// ---------------------------------------------------------------------------
// The claim the whole module exists to make

test('the wall: two years at the current ingestion rate stays inside the envelope', () => {
  // ~80 entries a day is what the real corpus does (measured over the last ten
  // day shards). Two years of it is ~58,000 entries, several times the whole
  // asset budget, and the point is that the projection does not move.
  const entries = []
  let n = 0
  for (let d = 0; d < 730; d++) for (let k = 0; k < 80; k++) entries.push(entry(++n, d))
  const days = [...new Set(entries.map(e => e.day))]
  const plan = planAssetRetention({ entries, days, releaseCount: 645, prPreviewCount: 120 })

  assert.ok(plan.fits)
  assert.ok(plan.projectedFiles <= plan.limits.budget, `projected ${plan.projectedFiles} must fit ${plan.limits.budget}`)
  assert.ok(plan.archivedDiffs > 45000, 'and it is retention doing the work, not luck')
  assert.ok(plan.keptDiffs > 5000, 'while the inline window stays deep enough to be useful')
  assert.equal(plan.dropOgDays.size, 0, 'the second tier is not needed at this scale')
})

// ---------------------------------------------------------------------------
// The gate that reads dist/

test('checkDistBudget: over the cap, over the budget and a margin that is too thin', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `dist/f${i}`, bytes: 1000 }))
  const limits = resolveAssetLimits({})

  const fine = checkDistBudget(files(limits.budget), limits)
  assert.equal(fine.overBudget, false)
  assert.equal(fine.overCap, false)
  assert.equal(fine.tightMargin, false, 'the default envelope keeps its margin')

  const over = checkDistBudget(files(limits.budget + 1), limits)
  assert.equal(over.overBudget, true)
  assert.equal(over.overCap, false, 'over our budget is not yet over the platform cap')

  const capped = checkDistBudget(files(limits.cap + 1), limits)
  assert.equal(capped.overCap, true)

  const thin = checkDistBudget(files(10), { cap: 20000, budget: 19800, margin: 200 })
  assert.equal(thin.tightMargin, true, 'an envelope with no runway is a configuration smell')
  assert.equal(thin.overBudget, false)
})

test('one oversized asset is over the cap no matter how few files there are', () => {
  const reading = checkDistBudget([{ path: 'dist/big.diff', bytes: ASSET_CAP_BYTES_PER_FILE + 1 }], resolveAssetLimits({}))
  assert.equal(reading.overCap, true)
  assert.equal(reading.oversized.length, 1)
  assert.match(distBudgetMessage(reading), /25 MiB per-asset cap/)
})

test('the verdict counts only well-formed entries and reports the largest', () => {
  const reading = checkDistBudget([
    null,
    { path: 'dist/a', bytes: 10 },
    { path: 'dist/b', bytes: 500 },
    { path: 'dist/broken' },
    { path: 'dist/c', bytes: 'big' }
  ], resolveAssetLimits({}))
  assert.equal(reading.count, 2)
  assert.equal(reading.bytes, 510)
  assert.equal(reading.largest.path, 'dist/b')
})

test('the message names the wall when the upload would be refused', () => {
  const limits = resolveAssetLimits({})
  const reading = checkDistBudget(Array.from({ length: limits.cap + 1 }, (_, i) => ({ path: `dist/f${i}`, bytes: 1 })), limits)
  assert.match(distBudgetMessage(reading), /static-asset cap/)
  const ok = checkDistBudget([{ path: 'dist/a', bytes: 1 }], limits)
  assert.match(distBudgetMessage(ok), /within the .* budget/)
  assert.match(distBudgetMessage(ok), /margin under the cap/)
})

test('a corpus with no entries and no history still plans a valid envelope', () => {
  const plan = planAssetRetention({ entries: [], days: [], releaseCount: 0, prPreviewCount: 0 })
  assert.equal(plan.candidates, 0)
  assert.equal(plan.keptDiffs, 0)
  assert.equal(plan.projectedFiles, DIST_OVERHEAD_FILES)
  assert.ok(plan.fits)
  assert.equal(plan.oldestKeptDiffDay, null)
  assert.match(plan.message, /every stored diff ships/)
})

test('the tier-1 report names what it archived so the log is not a surprise', () => {
  const entries = []
  for (let d = 0; d < 30; d++) for (let k = 0; k < 100; k++) entries.push(entryWith(d * 100 + k, d))
  const days = [...new Set(entries.map(e => e.day))]
  const plan = planAssetRetention({ entries, days, releaseCount: 5, prPreviewCount: 3, limits: { cap: 20000, budget: 2000, margin: 18000 } })
  assert.ok(plan.archivedDiffs > 0, 'the fixture has to archive something to report on')
  assert.match(plan.message, /archived to GitHub/)
  assert.match(plan.message, new RegExp(`${plan.oldestKeptDiffDay}`), 'and names how far back the inline window reaches')
  assert.doesNotMatch(plan.message, /OVER BUDGET/, 'this is the fitting case')
  assert.equal(plan.fits, true)
})
