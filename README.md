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
| `LLM_API_BASE`, `LLM_MODEL` | Relay writer route and model (`https://apihub.agnes-ai.com/v1`, `agnes-3.0-flash`). The Worker reads the same two names out of `wrangler.json` vars, pointed at vyceai for Ask; the runtimes never share an environment |
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
| `CHANGELOG_ASSET_CAP_FILES`, `CHANGELOG_ASSET_BUDGET_FILES` | The deploy envelope: static asset files Cloudflare accepts per Worker version (default 20,000, the Free plan; set 100,000 on Workers Paid) and the budget the build holds itself to (default 75% of the cap). Retention plans to the budget, `check-dist` fails past it |
| `SITE_URL` | Deployment and feed URL |
| `ASK_LLM_API_KEY` (repo secret → Worker secret `LLM_API_KEY`, re-bound by the deploy-site workflow), `ANSWER_RPM` | Ask-the-AI at the edge: its own credential -- deliberately separate from the relay's `LLM_API_KEY` -- and asks per IP per minute (default 5). Worker-side, not relay-side |

CLI commands load local environment configuration (`.env`). No setting can raise the token window or the configured RPM ceiling. Agnes rate limits are account-specific; 60 is the inherited safety cap, not a claimed Agnes entitlement. Invalid URLs and authentication failures fail the paid process without creating row failure stubs; deterministic updates publish first.

## Retention and the deploy envelope

dist/ is uploaded to Cloudflare Workers as static assets, and Cloudflare accepts at most **20,000 asset files per Worker version** (100,000 on Workers Paid, 25 MiB per file). dist/ carries one file per stored diff, and upstream produces ~80 entries a day, so with no policy the count reaches that wall a couple of months out. The symptom of reaching it is the worst kind: ingestion, generation and freshness all stay green while `wrangler deploy` starts refusing the upload, so the only witness is a site that quietly stops updating.

So older entries give way to newer ones, **by budget rather than by date**. [generator/lib/retention.mjs](generator/lib/retention.mjs) is a pure function of the corpus and the envelope, and it runs before anything renders. A date cutoff is the obvious shape and the wrong one: it is a function of the wall clock, and it cannot promise anything about the thing that actually breaks, which is a file count.

What giving way means, precisely: **the entry is untouched.** It keeps its place in `data/`, its day page, its record shard, the API, search, the feeds and the timeline. What stops shipping is the stored diff behind the inline viewer -- and with it the Ask control, because the Worker refuses to ground an answer against a diff it does not have, so offering the button would advertise a feature that cannot work. The card says so and links to the change on GitHub instead. Nothing is deleted from the repository and no text is rewritten.

`node generator/cli.mjs check-dist` weighs the built dist/ against the envelope and fails both CI and the deploy when it is over the budget or over the cap. `/api/status.json` reports the plan under `retention`: the cap and budget, how many diffs ship inline, how many were archived, how far back the inline window reaches, and whether the projection fits.

## Ask the AI

Every row that ships a diff offers **Ask the AI about this change**. Answers are generated at the edge by `POST /api/ask` in [worker.js](worker.js) and are **hard-gated** before a reader sees them: [generator/lib/grounding.mjs](generator/lib/grounding.mjs) checks each claim against the entry's stored diff, where backticked and code-like identifiers must occur in the evidence as whole tokens (never as a cut of a longer name), `[file]` citations must name a file this entry touched, and `[file:LINE]` must fall inside a hunk. A failing claim earns one corrective re-ask that names exactly what failed; a second failure is refused with `422` and the offending claims, and the text is never returned. Rows with no stored diff do not offer the button, because nothing could ground an answer, and a question the change cannot support is answered "the change does not show that" rather than with the model's general knowledge of the codebase.

Setup, once:
1. Set `ASK_LLM_API_KEY` as a repo Actions secret (`gh secret set ASK_LLM_API_KEY`), holding the widget's provider credential (currently vyceai). It is deliberately a **different** secret from the relay's `LLM_API_KEY`: the relay generates with Agnes, the widget answers with vyceai, and neither may be steered by changing the other. The deploy-site workflow binds it as the Worker secret `LLM_API_KEY` whenever it is missing and then probes `GET /api/ask` for `configured: true`, so the binding repairs itself instead of silently disabling the control. Never in this repo (public) and never as a dashboard text var: an upload rewrites the binding set from `wrangler.json`, which declares no secret, so a dashboard text var is deleted on every deploy.
2. Endpoint and model live in `wrangler.json` `vars` (`LLM_API_BASE`, `LLM_MODEL` -- currently `https://vyceai.com/v1` and `deepseek-v4.1`), so they survive every deploy by construction; `ANSWER_RPM` (asks per IP per minute, default 5) belongs there too if it ever changes.
3. Rotating the key: `gh secret set ASK_LLM_API_KEY`, then run deploy-site with the **rebind_ask_key** input (the step otherwise skips an already-bound secret, and the probe only proves the binding exists, not that the key is current).

Without the secret, `GET /api/ask` reports `configured: false`, the control disables itself with a note, and no other route changes. Identical asks are answered from cache (the Cache API where it exists, isolate memory otherwise), so a repeated question costs nothing. The rate limit is per-isolate and therefore best effort: an anti-accident limiter rather than a billing firewall, so lower `ANSWER_RPM` if abuse ever shows up. This site's limiter is not the only one: the provider's gateway can rate limit too (its own Cloudflare zone answers 1015), so an ask that lands there is retried within a few seconds and, if the gateway stays shut, fails with a plain sentence instead of the gateway's error page. `npm run preview` serves this route through the same `worker.js`, so local preview exercises the real gate rather than a reimplementation.

**A plain limit on the grounding guarantee.** The gate mechanically checks claims against the stored diff, but it cannot mechanically check ordinary prose: an answer can be fluent and confident while saying things the diff only loosely supports. For typical "what changed" questions the refusal guarantee is therefore weaker than the hard-gated description above reads. Treat Ask answers as a reading aid over the diff, not as checked facts.

## Data and outputs

- `data/changelog.json` (entries), `data/ai-summaries.json` (forward cache), `data/overrides.json` (human corrections, applied at build time), `data/open-prs.json`, `data/llm-health.json`, `data/diffs/`.
- Site: daily timeline, `/models`, `/week`, `/archive`, `/search`, `/stats`, `/c/<sha>` permalinks, RSS + JSON Feed, release notes as markdown, and `/api/*` (`entry`, `records`, `entries`, `days`, `status`).

## CI and deployment

- [generator-check](.github/workflows/generator-check.yml) runs syntax, build, the deploy-envelope check and the offline test suite on code changes.
- [changelog-sync](.github/workflows/changelog-sync.yml) polls upstream every ~30s under a ten-minute watchdog, publishes deterministic data first, then spends a bounded paid window. It runs the latest push-tested compatible generator against current data; bootstrap needs one green generator-check. Data pushes authenticate with the `CHANGELOG_GITHUB_TOKEN` repo secret (Contents: write + Actions: read/write) so pushes trigger deploy-site; without it the site refreshes only on deploy-site's 30-minute schedule. Rotation runbook: [docs/pat-rotation.md](docs/pat-rotation.md).
- [deploy-site](.github/workflows/deploy.yml) builds and uploads static assets, then probes the served head and timestamp with bounded propagation retries.
- Generation completeness has one hard gate, in [changelog-sync](.github/workflows/changelog-sync.yml), which owns generation: it names the overdue rows and its failure dispatches the cycle that heals them. [deploy-site](.github/workflows/deploy.yml) reads the same verdict, prints the same numbers and warns with the same row list, but does not fail the run: an upload that succeeded is not a failed deploy, and this workflow can neither write text nor dispatch a cycle. A stalled relay still fails deploy-site's freshness gate, and that failure now also names what the relay last did, so a run cancelled before it executed is legible as a platform condition rather than a data fault. The missing-text budget runs from when the text went missing, not from durable admission: a summary rewrite changes the source of the line that explains it, so the clock restarts when that rewrite invalidates the old line rather than judging a days-old admission against a gap that only just opened. `/api/status.json` exposes admitted missing-summary/explanation counts, overdue SHAs, repair needs, and pending reviews. Intentionally unchecked text and historical rows outside admission are not missing-generation failures. Deliberate: `/api/status.json` is public by design -- traffic counts and open-PR counts included. Transparency is the project's brand; the raw build status the site itself polls is the same file anyone can read.
- Provider/input changes release obsolete cooldowns; explicit named regeneration bypasses current cooldowns for both artifacts. Same-input attempts survive retries, and the relay re-probes repeatedly failing rows at most daily under the existing spending limits.
- History compaction is a read-only size audit; no force pushes or orphan branches.

Details live in `generator/lib/`, `generator/test/` and `.github/workflows/`.
