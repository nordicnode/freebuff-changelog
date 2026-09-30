// Historical API rewrites are intentionally disabled. This legacy entrypoint
// must never load credentials, overwrite full diffs, or bypass generator locks.
console.error('Historical regeneration is disabled by the no-backfill policy. Use the normal forward-only catch-up queue for newly admitted changes.')
process.exitCode = 1
