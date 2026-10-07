## What

## Why

## Checklist

- [ ] Branched from current `main` (not stacked on another PR)
- [ ] `node --check` clean on touched files
- [ ] `npm test` passes (or the failure is noted as pre-existing)
- [ ] No paid LLM calls in tests (`CHANGELOG_LLM=0`)
- [ ] No new runtime dependencies
- [ ] If client JS adds a visual hook, the stylesheet defines it
- [ ] `data/` untouched (corrections go through `override` or an issue)
