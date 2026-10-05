# Freebuff Changelog

Unofficial changelog generator and static site for [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff): it diffs public snapshot merges, records deterministic facts, and optionally adds model-written summaries and plain-English explanations. Zero runtime dependencies; **Node.js 22+**.

## Safe local checks

```bash
npm test
npm run build     # reads stored data; writes ignored dist/ only
npm run preview   # optional local preview on port 8788
```

Build and tests never call an LLM.

## Commands

```bash
node generator/cli.mjs generate [--full] [--push]   # fetch upstream, deterministic changes only
node generator/cli.mjs catch-up [--push]            # sync plus bounded enrichment of newly admitted rows
node generator/cli.mjs watch [--push]               # long-running catch-up loop
node generator/cli.mjs freshness                    # ingestion staleness check
node generator/cli.mjs generation-health            # overdue admitted text (offline, 30m budget; hard gate)
node generator/cli.mjs generation-health --report   # the same reading as a warning (deploy-site, advisory)
node generator/cli.mjs eval [--limit N]             # offline stored-artifact audit
node generator/cli.mjs override <sha>               # draft a human correction
```

`--push` commits and pushes generated data; `npm run broadcast` sends external messages. Neither is required to verify code. Workflow-only dispatch inputs on `changelog-sync` are `retry-failed <sha>...` (at most five named rows with no generation) and `regen-last <N | sha...>` (at most 50 newest or named rows); both are bounded and refuse history.

## What it generates

- **Forward-only.** Only newly admitted rows are enriched; historical text is never backfilled or rewritten. Admission is durable (`enrichment.policy`), and existing text plus [data/overrides.json](data/overrides.json) corrections stay intact.
- **Deterministic first.** Model tables, slash commands, version bumps and stats are computed from the diffs; the deterministic tier is what cards, feeds and the API publish.
- **Trust boundary.** Source hunks, PR text and older summaries are untrusted data in a separate message; PR matches fail closed. A recorded verdict binds to the exact published text, and editing checked text invalidates it.
- **Disclosure.** Objections and stored verdicts live in each entry's Evidence block and in the API `quality` record. A provider outage gets a quiet *automated review is pending* note, pre-policy text says it was never checked, and a missing verdict prints nothing and stays visible only as its status. No `[UNVERIFIED]` marker is stamped anywhere, and objection text does not travel with feeds, digests, Discord copy or release notes.
- **Verification is off by operator decision (2026-10-02).** New rows carry no verdict and never claim to be checked; existing verdicts are kept, unconfirmed breaking/migration steps stay demoted, and confidence stays capped. When enabled, the verifier does an exact-text, claim-by-claim second read and owes one bounded re-read after an outage.
- **Limits.** Fixed 512,000-token context contract, streaming requests (the non-streaming path times out), a 60 requests/minute account ceiling, and per-cycle and per-row wall-clock budgets. A prompt is sized against the row's own clock as well as the window, so no row is asked a question its budget cannot prefill; an oversized diff loses hunks, never its row.

## Configuration

| Setting | Essential contract |
|---|---|
| `CHANGELOG_LLM=1` + `LLM_API_KEY` | Enables enrichment of admitted new rows |
| `LLM_API_BASE`, `LLM_MODEL` | Writer route and model (`https://apihub.agnes-ai.com/v1`, `agnes-3.0-flash`) |
| `LLM_VERIFY_MODEL` | Verifier model (`agnes-3.0-flash`); a same-family check is not a human audit |
| `LLM_BACKUP_API_BASE`, `LLM_BACKUP_API_KEY`, `LLM_BACKUP_MODEL` | Failover to the configured backup on gateway/transport failures, refusals, or model-memory answers |
| `CHANGELOG_LLM_VERIFY` | `all` (default), `1` selective, `0` off; the relay runs `0` |
| `CHANGELOG_LLM_RPM` | Requests/minute ceiling (default 60; can only go lower); set to your Agnes account entitlement |
| `CHANGELOG_LLM_PARK_RETRY_MS` | Re-probe repeatedly failing rows at a bounded interval (relay: once daily; unset: parked until input/provider changes) |
| `CHANGELOG_GENERATION_STALE_MIN` | Missing-text health budget, measured from when the text went missing (default 30 minutes) |
| `CHANGELOG_LLM_CYCLE_BUDGET_MS` | Model-call wall clock per cycle (default 300,000) |
| `CHANGELOG_LLM_ROW_BUDGET_MS`, `CHANGELOG_ELI5_ROW_BUDGET_MS` | Wall clock one row may spend (defaults 90,000 / 45,000, and what its prompt is sized against) |
| `CHANGELOG_LLM_PREFILL_CHARS_PER_SEC`, `CHANGELOG_LLM_PROMPT_CLOCK_SHARE` | Prefill throughput the prompt ceiling is computed from (default 12,000; measured 13,056) and how much of the row clock the prompt may own (default 0.5) |
| `CHANGELOG_ELI5_ROLLUP_BUDGET_MS` | Clock for a release roll-up line (default: the wider of the two row budgets, 90,000). A roll-up reads the release window and answers in up to eight sentences, which the per-change share cut off mid-answer |
| `CHANGELOG_LLM_LIMIT`, `CHANGELOG_ELI5_LIMIT` | Per-cycle row limits |
| `CHANGELOG_LLM_STREAM` | Streams by default; `=0` disables |
| `CHANGELOG_SYNC_STALE_MIN` | Freshness budget (default 5 minutes; the gate fails at twice this) |
| `SITE_URL` | Deployment and feed URL |

CLI commands load local environment configuration (`.env`). No setting can raise the token window or the configured RPM ceiling. Agnes rate limits are account-specific; 60 is the inherited safety cap, not a claimed Agnes entitlement. Invalid URLs and authentication failures fail the paid process without creating row failure stubs; deterministic updates publish first.

## Data and outputs

- `data/changelog.json` (entries), `data/ai-summaries.json` (forward cache), `data/overrides.json` (human corrections, applied at build time), `data/open-prs.json`, `data/llm-health.json`, `data/diffs/`.
- Site: daily timeline, `/models`, `/week`, `/archive`, `/search`, `/stats`, `/c/<sha>` permalinks, RSS + JSON Feed, release notes as markdown, and `/api/*` (`entry`, `records`, `entries`, `days`, `status`).

## CI and deployment

- [generator-check](.github/workflows/generator-check.yml) runs syntax, build and the offline test suite on code changes.
- [changelog-sync](.github/workflows/changelog-sync.yml) polls upstream every ~30s under a ten-minute watchdog, publishes deterministic data first, then spends a bounded paid window. It runs the latest push-tested compatible generator against current data; bootstrap needs one green generator-check.
- [deploy](.github/workflows/deploy.yml) builds and uploads static assets, then probes the served head and timestamp with bounded propagation retries.
- Generation completeness has one hard gate, in [changelog-sync](.github/workflows/changelog-sync.yml), which owns generation: it names the overdue rows and its failure dispatches the cycle that heals them. [deploy](.github/workflows/deploy.yml) reads the same verdict, prints the same numbers and warns with the same row list, but does not fail the run: an upload that succeeded is not a failed deploy, and this workflow can neither write text nor dispatch a cycle. A stalled relay still fails the deploy's freshness gate, and that failure now also names what the relay last did, so a run cancelled before it executed is legible as a platform condition rather than a data fault. The missing-text budget runs from when the text went missing, not from durable admission: a summary rewrite changes the source of the line that explains it, so the clock restarts when that rewrite invalidates the old line rather than judging a days-old admission against a gap that only just opened. `/api/status.json` exposes admitted missing-summary/explanation counts, overdue SHAs, repair needs, and pending reviews. Intentionally unchecked text and historical rows outside admission are not missing-generation failures.
- Provider/input changes release obsolete cooldowns; explicit named regeneration bypasses current cooldowns for both artifacts. Same-input attempts survive retries, and the relay re-probes repeatedly failing rows at most daily under the existing spending limits.
- History compaction is a read-only size audit; no force pushes or orphan branches.

Details live in `generator/lib/`, `generator/test/` and `.github/workflows/`.
