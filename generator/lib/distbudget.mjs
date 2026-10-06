// generator/lib/distbudget.mjs - the deploy envelope for dist/.
//
// dist/ is uploaded to Cloudflare Workers as static assets, and two platform
// limits decide whether an upload succeeds at all:
//
//   - 20,000 static asset files per Worker version on the Free plan (100,000 on
//     Workers Paid), and
//   - 25 MiB for any single asset.
//
// Breaking either one fails the upload outright, and it fails quietly: ingestion
// keeps running, the freshness gate keeps passing, and the site simply stops
// updating. So the file *count* is treated as a hard budget rather than a
// number nobody watches.
//
// The count is the binding constraint, not the bytes: dist/ carries one file per
// stored diff, and the changelog grows by ~80 entries a day, so the count climbs
// with history while each diff stays small. generator/lib/retention.mjs is what
// keeps it under this budget; this module owns the numbers and the verdict.
//
// Note the split from sizebudget.mjs: that one guards individual *tracked data*
// files against GitHub's 100 MiB push limit, which is a different platform with
// a different failure. Both are budgets; they are not the same budget.
import { sizeText } from './sizebudget.mjs'

// Cloudflare Workers, Free plan. Workers Paid raises this to 100,000; an
// operator on Paid sets CHANGELOG_ASSET_CAP_FILES to say so.
export const ASSET_CAP_FILES = 20000
export const ASSET_CAP_BYTES_PER_FILE = 25 * 1024 * 1024

// Our own budget is a share of the cap, not the cap itself. The fixed asset
// families (day pages, entry frags, og cards, api record shards, release pages,
// feeds) keep growing a few files a day even with every diff archived, and the
// retention plan's estimate of them must not leave itself no margin for error.
export const ASSET_BUDGET_SHARE = 0.75
// The margin the envelope must keep under the cap, also stated as a share of the
// cap. Note what is deliberately NOT here: a warning for approaching the budget.
// Retention plans *to* the budget, so a healthy build sits exactly at it and a
// count-based warning band would be lit permanently -- the kind of alarm this
// repository already refuses elsewhere. The count is a target now, not a
// measurement; what is worth warning about is an envelope configured with no
// margin left, which is a configuration smell rather than a build one.
export const ASSET_MARGIN_SHARE = 0.1

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * The envelope for one build. `cap` is the platform's, `budget` is ours:
 * retention plans to the budget, and check-dist fails past it.
 */
export function resolveAssetLimits (env = process.env) {
  const cap = positiveInt(env.CHANGELOG_ASSET_CAP_FILES) || ASSET_CAP_FILES
  const configured = positiveInt(env.CHANGELOG_ASSET_BUDGET_FILES)
  const budget = Math.min(configured || Math.floor(cap * ASSET_BUDGET_SHARE), cap)
  return { cap, budget, margin: cap - budget }
}

/**
 * Weigh a built dist/ against the envelope. `files` is [{ path, bytes }].
 * `overCap` means the platform will refuse the upload; `overBudget` means our
 * own retention policy did not do its job.
 */
export function checkDistBudget (files = [], limits = resolveAssetLimits()) {
  let bytes = 0
  let largest = null
  let counted = 0
  const oversized = []
  for (const f of files) {
    if (!f || typeof f.bytes !== 'number') continue
    counted++
    bytes += f.bytes
    if (!largest || f.bytes > largest.bytes) largest = f
    if (f.bytes > ASSET_CAP_BYTES_PER_FILE) oversized.push(f)
  }
  const count = counted
  const overCap = count > limits.cap || oversized.length > 0
  const overBudget = count > limits.budget
  return {
    count,
    bytes,
    largest,
    oversized,
    overCap,
    overBudget,
    tightMargin: limits.margin < limits.cap * ASSET_MARGIN_SHARE,
    limits
  }
}

/** One line for logs, CI and the failure message. */
export function distBudgetMessage (reading, { label = 'dist/' } = {}) {
  const { count, bytes, limits, overCap, overBudget, tightMargin } = reading
  const pct = Math.round((count / limits.cap) * 100)
  const weighed = `${count.toLocaleString()} file${count === 1 ? '' : 's'} (${sizeText(bytes)}, ${pct}% of the ${limits.cap.toLocaleString()}-file cap)`
  if (reading.oversized?.length) {
    const worst = reading.oversized.sort((a, b) => b.bytes - a.bytes)[0]
    return `${label} ${weighed}: ${worst.path} is ${sizeText(worst.bytes)}, over the ${Math.round(ASSET_CAP_BYTES_PER_FILE / 1048576)} MiB per-asset cap -- Cloudflare will refuse the upload`
  }
  if (overCap) {
    return `${label} ${weighed}: at or over the Cloudflare Workers static-asset cap of ${limits.cap.toLocaleString()} per version, so the next upload fails. Retention (generator/lib/retention.mjs) should have kept this under ${limits.budget.toLocaleString()}; on Workers Paid raise CHANGELOG_ASSET_CAP_FILES`
  }
  if (overBudget) {
    return `${label} ${weighed}: over the retention budget of ${limits.budget.toLocaleString()} -- the plan in buildAssetRetention did not hold`
  }
  if (tightMargin) {
    return `${label} ${weighed}: within the ${limits.budget.toLocaleString()}-file budget, but that leaves only ${limits.margin.toLocaleString()} files of margin under the cap. Retention plans to the budget, so a growth spurt has nowhere to go -- raise CHANGELOG_ASSET_CAP_FILES if this account is on Workers Paid (100,000), or lower CHANGELOG_ASSET_BUDGET_FILES`
  }
  return `${label} ${weighed}: within the ${limits.budget.toLocaleString()}-file budget, ${limits.margin.toLocaleString()} files of margin under the cap`
}
