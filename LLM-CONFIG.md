# LLM Configuration

## Current Setup

### VyceAI (Primary)
- **API Base**: `https://vyceai.com/v1`
- **Model**: `deepseek-v4.1`
- **Status**: Configured ✅

### Repository Secrets
These are set in GitHub repository settings (`nordicnode/freebuff-changelog`):

```bash
LLM_API_KEY=sk-0ae4fc7e1dc54cc7d5de54deb9c3615b964f61bbdf666ca7
LLM_API_BASE=https://vyceai.com/v1
LLM_MODEL=deepseek-v4.1
```

## Previous Issues

Before this fix, we were using GitHub Models (`github:gpt-4o-mini`) which caused:
- HTTP 502/504 gateway errors
- Rate limiting on free tier
- Systematic "LLM cycle deadline exceeded" errors
- Inconsistent throughput

VyceAI provides more reliable infrastructure for bulk generation workloads.

## Time Budgeting Fixes

To prevent CI starvation issues, the pipeline now reserves guaranteed time slices:

1. **cmdCatchUp (watch cycle)**:
   - Technical summaries: Gets remaining budget after reserving 60s minimum for ELI5
   - ELI5 pass: Guaranteed at least 50-60 seconds before cycle deadline
   - PR previews: Separate budget with its own deadline

2. **cmdRegenLast (manual regeneration)**:
   - 60% of budget to technical summaries
   - 40% reserved for ELI5 generation
   - Prevents one pass from starving another

## Error Handling

The pipeline automatically handles:
- **Transient errors** (HTTP 5xx): Retries with exponential backoff
- **Timeout errors**: Respects cycle deadlines to avoid complete failures
- **Deterministic errors** (refusals): Parks after max attempts (default: 3)

## Monitoring

Watch for these patterns:
- High error rates → May need backup provider configured
- Timeout errors → Check if diffs are too large or timeout too short
- Stalled CI runs → Should be rare now with time budgeting fixes

## Backup Provider (Optional)

For failover during VyceAI outages:

```bash
LLM_BACKUP_API_BASE=<backup-url>
LLM_BACKUP_API_KEY=<backup-key>
LLM_BACKUP_MODEL=<backup-model>
```

This is only used when the primary route fails at transport/gateway level.
