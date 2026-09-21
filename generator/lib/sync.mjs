// generator/lib/sync.mjs - when the pipeline must re-analyze upstream.
//
// Two independent fields drive the deployed site's freshness:
//   changelog.headSha      the upstream snapshot the data was built from
//   changelog.generatedAt  what "[stale Nm]" is measured against (see site.mjs)
// Both are written *only* by the analyze pass, so a loop that only backfills
// LLM summaries can push commits forever while the site keeps reporting a
// timestamp from hours ago. This module is the decision the loop applies each
// cycle; it is pure so the two triggers can be tested without git or network.
export const DEFAULT_SYNC_STALE_MIN = 5

export function syncStaleMs (env = process.env) {
  return (Number(env.CHANGELOG_SYNC_STALE_MIN || DEFAULT_SYNC_STALE_MIN) || DEFAULT_SYNC_STALE_MIN) * 60000
}

/**
 * Why (if at all) must this cycle re-analyze upstream? Returns a human-readable
 * reason, or '' when the data on disk is fresh enough to leave alone.
 *
 * The age floor matters independently of `head !== lastSha`: while upstream is
 * quiet, "did it move" never fires, yet `generatedAt` still has to advance or
 * the site reads as broken even though nothing is wrong.
 */
export function syncReason ({
  head,
  lastSha,
  generatedAt,
  now = Date.now(),
  staleMs = DEFAULT_SYNC_STALE_MIN * 60000
}) {
  if (!head) return ''
  if (!lastSha) return 'no prior sync recorded'
  if (lastSha !== head) return `upstream advanced ${String(lastSha).slice(0, 8)} -> ${String(head).slice(0, 8)}`
  const then = Date.parse(generatedAt || '') || 0
  if (!then) return 'last sync timestamp unreadable'
  // Compare raw ms, not floored minutes: floor-then-`>` meant the floor fired
  // only past 6m on a 5m budget, and that extra minute-plus (poll + generate +
  // deploy) came straight out of the 2x budget the site's "[stale]" badge and
  // deploy.yml's freshness gate measure against.
  const ageMin = Math.floor((now - then) / 60000)
  if (now - then >= staleMs) return `last sync ${ageMin}m ago exceeded ${Math.round(staleMs / 60000)}m budget`
  return ''
}
