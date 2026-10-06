// generator/lib/retention.mjs - keep dist/ inside its deploy envelope, forever.
//
// The problem this solves is arithmetic, not policy. dist/ carries one file per
// stored diff, the upstream repository produces ~80 entries a day, and Cloudflare
// Workers accepts at most 20,000 static asset files per Worker version. Left
// alone, the changelog reaches that wall a couple of months out, and the symptom
// of reaching it is the worst kind: every gate in this repository stays green
// (ingestion is fine, generation is fine) while `wrangler deploy` starts failing
// and the site stops updating.
//
// So older entries give way to newer ones, and they do it by budget rather than
// by a date. A date cutoff is the obvious shape and the wrong one: it is a
// function of the wall clock, so the same corpus renders differently on different
// days, and it cannot promise anything about the thing that actually breaks (a
// file count). This plan is a pure function of the corpus in hand and a budget,
// which makes it testable and makes the guarantee real.
//
// What "giving way" means, precisely:
//
//   - The entry itself is untouched. It keeps its place in data/, its day page,
//     its record shard, the API, search, the feeds and the timeline. Nothing is
//     deleted from the repository and no text is rewritten.
//   - What stops shipping is the *heavy per-entry asset*: the stored diff behind
//     the inline viewer, and with it the Ask-the-AI control (which is refused by
//     the Worker without a stored diff, so offering it would advertise a feature
//     that cannot work). The card links to the change on GitHub instead, and says
//     why.
//
// The plan is applied before anything is rendered, so every surface -- day pages,
// entry frags, permalinks, the range view, search results -- agrees with what
// dist/ actually holds. A row is never left advertising a viewer that 404s.
import { resolveAssetLimits } from './distbudget.mjs'

// Files each unit of history contributes to dist/ that are NOT per-entry diffs.
// Measured against a real build: 4 per day (the day page, the day's entry frag,
// its og card, and its api record shard), 2 per release (the release page and its
// notes.md), and 1 per open-PR preview. The fixed tail is feeds, badges, the
// category/week/model pages, the root documents and the api singletons; it
// measured ~460 and is rounded up for margin. The 2026-10-06 site work added 7
// more fixed files (sitemap.xml + 4 sub-sitemaps, robots.txt, api/sha-day.json),
// so the overhead moves 512 -> 520 to keep the margin honest.
export const PER_DAY_FILES = 4
export const PER_RELEASE_FILES = 2
export const DIST_OVERHEAD_FILES = 520

export function fixedAssetCount ({ dayCount = 0, releaseCount = 0, prPreviewCount = 0, overheadFiles = DIST_OVERHEAD_FILES } = {}) {
  return dayCount * PER_DAY_FILES + releaseCount * PER_RELEASE_FILES + prPreviewCount + overheadFiles
}

const dayOf = (e) => String(e?.day || e?.date || '').slice(0, 10)

/**
 * Decide which stored diffs ship.
 *
 * `entries` may arrive in any order: the sort is done here, newest first, so a
 * caller that reverses its corpus cannot accidentally archive the newest rows.
 *
 * Returns the plan, including the `keep` set of SHAs whose diffs ship and the
 * `dropOgDays` set of days whose og cards are dropped (a second tier that only
 * engages once the diffs are spent). `fits` is the guarantee: when it is true the
 * projected dist/ is inside the budget, and the check-dist gate exists to notice
 * if the estimate behind it ever drifts.
 */
export function planAssetRetention ({
  entries = [],
  days = [],
  releaseCount = 0,
  prPreviewCount = 0,
  limits = resolveAssetLimits(),
  overheadFiles = DIST_OVERHEAD_FILES
} = {}) {
  const newestFirst = [...entries].sort((a, b) => (dayOf(a) < dayOf(b) ? 1 : dayOf(a) > dayOf(b) ? -1 : 0))
  const dayList = [...days].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // newest first
  const dayCount = dayList.length || new Set(newestFirst.map(dayOf)).size
  const fixed = fixedAssetCount({ dayCount, releaseCount, prPreviewCount, overheadFiles })
  const candidates = newestFirst.filter(e => e.hasDiff)
  const tiers = []

  // Room left for per-entry diffs once everything else has its share.
  let slots = limits.budget - fixed

  // Tier 1 -- the lever that matters, because it is the only family growing at
  // the corpus's own rate. Keep the newest diffs that fit; the rest are archived.
  const keptDiffs = Math.min(Math.max(0, slots), candidates.length)
  const keep = new Set(candidates.slice(0, keptDiffs).map(e => e.sha))
  const archived = candidates.slice(keptDiffs)
  const archivedDiffs = archived.length
  if (archivedDiffs) {
    tiers.push({
      tier: 'diffs',
      dropped: archivedDiffs,
      reason: `the stored diff behind the inline viewer, the heaviest family in dist/ and the only one that grows with the corpus`
    })
  }
  // Whatever the diffs did not take is what the fixed families left on the
  // table: negative here means they already exceed the budget on their own.
  slots -= keptDiffs

  // Tier 2 -- only reachable if the fixed families alone outgrow the budget, at
  // which point every diff is already archived and the og cards are the next
  // cheapest thing to give up. Their pages fall back to /og/default.png.
  const dropOgDays = new Set()
  let droppedOg = 0
  if (slots < 0) {
    for (let i = dayList.length - 1; i >= 0 && slots < 0; i--) {
      dropOgDays.add(dayList[i])
      droppedOg++
      slots++
    }
    if (droppedOg) {
      tiers.push({
        tier: 'og-cards',
        dropped: droppedOg,
        reason: 'the fixed families alone exceed the budget, so the oldest social cards fall back to the default image'
      })
    }
  }

  const projectedFiles = fixed - droppedOg + keptDiffs
  const fits = projectedFiles <= limits.budget
  const oldestKeptDiffDay = keptDiffs ? dayOf(candidates[keptDiffs - 1]) : null
  const newestArchivedDay = archivedDiffs ? dayOf(archived[0]) : null
  const oldestArchivedDay = archivedDiffs ? dayOf(archived[archivedDiffs - 1]) : null

  return {
    limits,
    fixed,
    dayCount,
    releaseCount,
    prPreviewCount,
    candidates: candidates.length,
    keptDiffs,
    archivedDiffs,
    // `keep` is what the diff copy consults; `archived` names the rows that lost
    // a diff this build (never the ones that never had one), which is what lets a
    // card explain the difference instead of silently losing its viewer.
    keep,
    archived: new Set(archived.map(e => e.sha)),
    dropOgDays,
    tiers,
    projectedFiles,
    headroom: limits.budget - projectedFiles,
    fits,
    oldestKeptDiffDay,
    newestArchivedDay,
    oldestArchivedDay,
    message: retentionMessage({ keptDiffs, archivedDiffs, fixed, projectedFiles, limits, oldestKeptDiffDay, newestArchivedDay, fits })
  }
}

function retentionMessage ({ keptDiffs, archivedDiffs, fixed, projectedFiles, limits, oldestKeptDiffDay, newestArchivedDay, fits }) {
  const head = `assets ${projectedFiles.toLocaleString()}/${limits.budget.toLocaleString()} budget (${fixed.toLocaleString()} fixed + ${keptDiffs.toLocaleString()} diffs)`
  if (!archivedDiffs) return `${head}: every stored diff ships`
  const window = oldestKeptDiffDay ? `inline diffs cover back to ${oldestKeptDiffDay}` : 'no diff ships inline'
  const boundary = newestArchivedDay ? `; archived through ${newestArchivedDay}` : ''
  const tail = fits ? '' : ' -- OVER BUDGET: raise CHANGELOG_ASSET_BUDGET_FILES or CHANGELOG_ASSET_CAP_FILES'
  return `${head}: ${archivedDiffs.toLocaleString()} older diff${archivedDiffs === 1 ? '' : 's'} archived to GitHub, ${window}${boundary}${tail}`
}
