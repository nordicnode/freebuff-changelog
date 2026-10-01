# ELI5 Generation Fix - Verification & Testing Guide

## What Was Fixed

### Bug #1: Missing Persistence (Critical)
**File**: `generator/cli.mjs` line 1217  
**Problem**: Writing back stale `existing` variable instead of modified `entries` array  
**Fix**: `{ ...existing, entries }` preserves metadata AND updated entries

### Bug #2: Version Check Blocking Old Entries (CRITICAL)
**File**: `generator/lib/llm.mjs` line 4355  
**Problem**: `eli5Eligible()` required `(e.ai?.v ?? 1) >= PROMPT_V` (PROMPT_V=11)  
**Impact**: Filtered out ALL 6,925 entries with ai.v=5 from ELI5 generation  
**Fix**: Removed version requirement; ELI5 only needs title+summary

## Current Status

Both fixes are **LIVE on GitHub**:
- Commit 1: `fix: persist ELI5 data to changelog.json...` 
- Commit 2: `fix: remove PROMPT_V requirement from eli5Eligible()`

GitHub Actions sync relay is running every ~10 seconds and will automatically pick up these changes.

## How to Verify It's Working

### Option 1: Manual Backfill (Fastest)
Run this command locally once Node.js is fixed:

```bash
cd /home/mikey/Desktop/fbweb

# Remove any existing lock
rm -f .cache/generator.lock

# Run backfill with HIGH limits to clear backlog quickly
CHANGELOG_LLM_LIMIT=50 \
  CHANGELOG_LLM_CONCURRENCY=8 \
  npm run backfill --push
  
# Watch progress
tail -f data/changelog.json | python3 -c "import json,sys; [print(json.loads(x.decode())['generatedAt']) for x in sys.stdin]"
```

Expected output during run:
```
[enrichment] enriched X entries with LLM (Y remaining)
[enrichment] ELI5 wrote Z entries (W remaining)
ELI5 wrote abc12345 (1/50)
ELI5 wrote def67890 (2/50)
...
```

After completion (~30-60 minutes for full backlog):
```bash
python3 scripts/analyze-incomplete.py
```

Expected results:
- ✓ Full entries: Should increase dramatically (target: 50%+)
- ✗ Partial entries: Should decrease significantly
- 🗃️ Cache hits: Many entries should hit cache immediately (fast!)

### Option 2: Wait for Sync Relay (Automatic)
The GitHub Actions sync relay (`changelog-sync.yml`) runs continuously:
- Triggers every ~10 seconds via self-dispatching
- Processes up to `CHANGELOG_LLM_LIMIT` entries per cycle (currently 10-30)
- Will gradually work through the backlog over several hours

To monitor progress:
1. Visit GitHub → Actions tab
2. Look at `changelog-sync` workflow runs
3. Watch logs for `[enrichment] ELI5 wrote N entries`

### Option 3: Trigger Individual Regeneration
For specific batches or targeted recovery:

```bash
# Regenerate last 20 entries (newest first)
npm run regen-last 20 --push

# Or regenerate specific failing entries
npm run retry-failed <sha-prefix> --push
```

## Expected Timeline

| Scenario | Time to First ELI5 Lines | Time to Full Backlog |
|----------|-------------------------|----------------------|
| Manual backfill (LIMIT=50) | 30-60 seconds | ~30-40 minutes |
| Sync relay (default) | Already happening | 4-6 hours |
| Combined approach | Immediate | 2-3 hours |

## Troubleshooting

### Issue: No ELI5 after 1 hour
Check if the sync relay picked up your code changes:
```bash
# In GitHub → Actions → changelog-sync
# Click latest run → scroll to logs
# Look for: "remove PROMPT_V requirement" comment in commit message
```

### Issue: "LLM refused the request" errors
These deterministic refusals need a prompt version bump:
```bash
# Temporarily bump PROMPT_V in generator/lib/versions.mjs
export const PROMPT_V = 12  # Change from 11

# Then run enrichment
npm run regen-last 50 --push
```

### Issue: Rate limiting (429 errors)
Increase retry budget or reduce concurrency:
```bash
CHANGELOG_LLM_RPM=30 \
  CHANGELOG_LLM_CONCURRENCY=2 \
  npm run backfill --push
```

## Validation Steps After Fix

### Step 1: Check Entry Counts
```python
# In Python
import json
with open('data/changelog.json') as f:
    data = json.load(f)
    
complete = [e for e in data['entries'] 
            if e.get('ai', {}).get('title') and 
               e.get('ai', {}).get('summary') and 
               e.get('ai', {}).get('eli5')]

print(f"Complete entries: {len(complete)}")
print(f"Percentage: {len(complete)/len(data['entries'])*100:.1f}%")
```

### Step 2: Verify Site Deployments
Visit your deployed site after each GitHub push:
- https://freebuff-changelog.nordicnode.workers.dev/
- Check individual entries for plain English lines
- Look for entries that previously had none

### Step 3: Monitor Build Logs
After pushing, watch deploy.yml workflow:
1. Go to GitHub → Actions → deploy
2. Latest run should show green checkmarks
3. If it fails, check if there's a syntax error in the fix

## Success Criteria

You'll know everything is working when:

✅ **Short-term (within 1 hour)**
- At least 500+ entries have complete AI + ELI5 data
- Live website shows plain English lines on recent entries
- No more "LLM endpoint offline" gateway failures

✅ **Medium-term (within 6 hours)**
- 2,000-3,000 entries with complete data
- Site rebuilds successfully without errors
- Sync relay processing steadily (no consecutive failures)

✅ **Long-term (full backlog)**
- 6,000+ entries with ELI5 lines
- Only fresh commits missing data (healthy, forward-looking state)
- Error rate below 1% for transient issues

## Next Steps After Everything Works

Once the backlog is cleared:

1. **Add monitoring**: Create alert for "Missing ELI5 > 10%" threshold
2. **Test automation**: Write integration test that validates entry completeness
3. **Optimize limits**: Tune `CHANGELOG_LLM_LIMIT` based on provider quota
4. **Document lessons**: Add this bug to "known issues" docs for future reference

---

**Current Fix Commits**:
- https://github.com/nordicnode/freebuff-changelog/commit/f131ec64 ← ELI5 eligibility fix
- https://github.com/nordicnode/freebuff-changelog/commit/76c808bc ← persistence fix

Both are live and being processed by the sync relay!
