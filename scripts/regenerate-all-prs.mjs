// Bulk historical PR previews are intentionally disabled; no credentials load.
console.error('Bulk PR regeneration is disabled by the no-backfill policy. New or genuinely updated PRs are handled by the bounded catch-up queue.')
process.exitCode = 1
