# Freebuff Changelog

Unofficial changelog generator and static site for [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff). Public snapshot diffs supply deterministic catalog events and optional model-written explanations. Zero runtime dependencies; **Node.js 22 or newer**.

## Safe local checks

```bash
npm test
npm run build     # reads stored data; writes ignored dist/ only
npm run preview   # optional local preview on port 8788
```

Build and tests do not call an LLM. CLI commands load local environment configuration; do not run ingestion, broadcast, or publication commands merely to validate code.

## Forward-only enrichment: no historical backfill

- `generate` fetches upstream and records deterministic changes. It performs **no model work**. When explicitly invoked with `--push`, new entries and the observed head are published before diff/PR decoration.
- `catch-up` and `watch` optionally enrich **newly admitted incremental entries** after deterministic publication. Admission is durable (`enrichment.policy`); initial scans and `--full` rescans do not admit historical entries. Existing legacy text and human overrides remain intact.
- Production CLI cycles force the no-backfill policy. Summary, plain-English, and PR queues reject unadmitted history by default. The low-level test-fixture override is not a supported production regeneration command.
- `enrich-all`, historical regeneration scripts, and the rewrite workflow are disabled. The old `backfill` name remains a compatibility alias for `watch`, **not permission to regenerate history**.
- The one deliberate way back is `retry-failed <sha>...`, run only through the sync workflow's dispatch input (a workstation must not spend the relay's key): it releases **named** rows that have no generation — an admitted row, or one whose current-prompt failure stub proves the pipeline already asked it — clears their failure stubs, stamps the row admitted when its record was lost (the writer's gate reads `enrichment.policy`, so a release the queue skips would be a no-op), fetches the clone before extracting patches, and re-asks once. It refuses noise, refuses any row with existing text, refuses a never-asked historical row, and accepts at most five names per run, so the spend is bounded by what a human types rather than by anything cached. One refused name does not abort the batch: the names that pass are released and published first and the run then ends red, so a stranded row cannot hold healthy ones hostage while the refusal stays visible. `--admit` (dispatch input `admit=true`) is the single override for a row with neither admission nor a recorded ask — the state the first release itself created, by deleting the stub that was the proof — and it widens only that gate, never noise and never a row that already has text. A row whose patch cannot be extracted is named in the log instead of being skipped silently, and a parked row that was never released still heals on the next prompt version.
- Refreshing recent text on request is the same bounded exception: `regen-last <N | sha...>` (dispatch input `regen`) re-asks for fresh summaries on the newest N rows, capped at 50 per run. Rows outside the set are untouched, a failed ask leaves the shipped text in place (a failure writes a stub, and a stub loses the merge to a real summary; `e.ai` is only ever replaced by a successful record), and a row in the set must be admitted or already carry a generation this pipeline wrote — a row with neither is refused and named, because that would be backfill. It runs under the worktree lock with its own six-calls-per-row budget scaled to the set (one minute per row, six-minute floor, thirty-minute cap), and is the sanctioned replacement for the retired `scripts/regenerate-last-20.mjs`, which still fails fast.
- Models are unchanged: existing `LLM_MODEL`, optional `LLM_MODEL_MAJOR`, and configured verifier routing are retained. The verifier default remains `deepseek-v4.1`. No new model is selected by this remediation.
- The provider context contract is fixed at **270,000 tokens**, with 8,000 output tokens reserved and conservative character budgeting. Environment settings cannot silently increase the window. Character budgeting is an estimate, not an exact tokenizer.
- A production cycle has two clocks: a **four-minute git/network deadline** for the sync, PR refresh and first publish, and a separate **paid window** (default five minutes, never past the watch run's remaining time) for model work. The old design armed one clock at cycle start and subtracted an ELI5 reserve of `limit * 15s` from it, so the summary pass was routinely handed a deadline in the past: ten consecutive relay cycles wrote nothing and every queued row answered "LLM cycle deadline exceeded" without a call being sent (254 such stubs are in the cache). Each pass now arms its own deadline when it starts, and is planned down to the rows its window can actually finish.
- A row owns **`CHANGELOG_LLM_ROW_BUDGET_MS`** of wall clock (default 90s) for all of its calls, and the pass plans its queue from the same number. A row that runs out is left for the next cycle with the short cooldown; a row can no longer spend the pass and leave the rows behind it unasked. Failed rows retain durable attempt counts and cooldowns.
- The provider's account limit is **40 requests/minute**, shared by every stage, retry and route; the configured value can only be lower.

Operator commands (not local validation commands):

```bash
node generator/cli.mjs generate [--full] [--push]
node generator/cli.mjs catch-up [--push]
node generator/cli.mjs watch [--push] --interval 30 --duration 12m
node generator/cli.mjs freshness
node generator/cli.mjs eval [--limit N]   # offline stored-artifact audit
node generator/cli.mjs override <sha>    # inspect a human-correction draft
node generator/cli.mjs retry-failed <sha>... [--push]  # bounded release of named rows with no generation (dispatch input on changelog-sync, not a local command)
node generator/cli.mjs regen-last <N | sha...> [--push]  # regenerate the newest N (max 50) or named rows: fresh summaries, bounded and forward-only
```

`--push` is consequential: it commits and pushes generated data. Broadcast sends external messages. Neither is required for build/test verification.

## Evidence and trust

The writer receives redacted source hunks, mechanical facts, revision-bound module/consumer context, and accepted PR intent. Source, PR descriptions, comments, older summaries, and quoted instructions are **untrusted data** in a separate user message; the system message provides the trusted task boundary. Inferred file-set PR matches fail closed when relevance cannot be established. PR disappearance means closure, not merge; shipped-intent matching uses only confirmed merged closures.

A failed generation is retried with a materially different ask, never with the same bytes. A reply that comes back wrong — a refusal, prose instead of JSON, an answer from training memory — takes the rung built for it: the ask with the diff's comments stripped, or the one with the wide repository-derived sections dropped. A reply that never comes back (a gateway 5xx, a dropped connection, a timeout) was, until 2026-09-30, re-sent verbatim up to three times and then handed to the next cycle unchanged, so a row whose request is slow enough to time out spent four identical full-size calls an hour apart and stayed ungenerated while smaller rows in the same cycles succeeded. It now spends its verbatim retries and then asks the smaller question once, which is the only attempt that can still change the answer. Rows that never resolve keep their recorded failure and are retried on a short cooldown; nothing is parked silently. The cooldown is re-read from the stored message rather than trusted from when it was written: a row whose calls were killed by our own cycle deadline or request budget gets the short cooldown however many times it happened (four deadline kills were storing `fc37ac10` as a permanent failure, so it could never be regenerated even after the gateway recovered), while a refusal on every rung is still parked for good, and a parked row is released by the next prompt version rather than by editing the cache.

New policy records carry source/base/head, model, prompt, delivered-evidence and context hashes. Forward summary cache identities include the complete gathered prompt/context and validator policy; PR identities include title, description, labels, and commit subjects. Verdicts bind to the exact published factual artifact. Editing checked text invalidates its verdict; changing only confidence does not.

Validation covers titles, summaries, evidence, migration steps, unknowns, settings, and per-topic claims. Semantic verification requires an explicit boolean verdict, valid claim records, and coverage of every published sentence/list item, audience, and boolean field. Malformed replies and timeouts never count as passed. A missing reviewer cannot clear an existing objection. Breaking/migration claims are not promoted as actionable until confirmed; self-check failure demotes them.

A deterministic pass also checks that every name, number and path the row publishes is present in the evidence the row was written from, and names it cannot find are reported as unverified. Grounding is by whole token, so a truncated prefix of a real name is caught, but a claim is read the way source is read: a member name after a dot (`server.httpServer`) is a mention of that member, a quoted fragment (`models?`) is grounded by verbatim presence, a wildcard (`run-*.ts`) by its head, a call (`fn(hasPaidPlan)`) by its callee, a file name without regard to case, and a subscript (`PATTERNS[1]`) is a claim about `PATTERNS` with a position attached — the index is never spelled by a declaration, so requiring the whole span reported faithful quotes as inventions. Fourteen of the twenty-two rows flagged under the earlier rule were faithful quotations, re-checked against their own diffs; stored flags are forward-only and are retired by the heal pass, never rewritten by hand.

Plain-English explanations receive their own semantic check for audience, availability, conditions, quantities, causal effects, and promises. Test/documentation-only entries can use deterministic templates without API calls. Same-family checking has correlated blind spots; a passed model check is not a human audit or proof of correctness.

Disclosure is two-tier, so the warning keeps its meaning. Rows with actual factual objections, ungrounded names, stale verdicts or value errors carry a visible `[UNVERIFIED]` badge and a demoted action label. A provider outage is not a factual objection: it has no outage-only badge or repeated alarm sentence, and says **Automated review is pending** quietly in Evidence and API quality notes (`reviewPending: true`). Its status stays `unavailable`, confidence is capped, actionable claims remain demoted, and real objections are never suppressed. Rows that merely predate the current policy were never checked, which is not a failure: they carry no badge and keep the labels they shipped with, and say so in one sentence in their own Evidence block, in the API `quality.notes`, and as a single counted line on `/stats/` (`pre-policy history`). Stored history is not relabelled as broken by a policy it never ran under, and it is not silently presented as checked either.

The verifier carries its own version (`VERIFY_POLICY_V`), separate from the writer's prompt version, because a verdict is only as current as the framing that produced it. A row whose recorded verdict predates the current framing gets **one** deferred re-read: verdict only, never a writer call and never replaced text, bounded by tries and a cooldown, and stamped afterwards so it is not re-read again. That is how objections raised under superseded framing are retired, including for history the no-backfill gate keeps out of the writer queue.

A call the endpoint never answered — a gateway 5xx, a timeout, a throttle, or a call the cycle deadline killed — produced no verdict, so it increases an exponential cooldown (up to six hours) instead of one of the row's three verdict tries. An outage never permanently retires an unanswered review; per-run queues and request ceilings still bound spend. An explicit `CHANGELOG_LLM_REVERIFY_MAX_ERRORS` cap is honored. Verification gateway failures try one compact framing with the same evidence and coverage contract rather than four identical requests. During the 2026-09-30 gateway outage every re-check was charged to the verdict budget, so a row hit its three-try cap after 90 minutes of 504s and the fresh read it was owed could never happen. A refusal or a malformed reply, by contrast, is the model answering badly: that is a real attempt and is charged as one.

Where a warning does apply, the badge is the signal and the objections themselves sit in that entry's Evidence block, whose toggle counts them (`N objections`) next to the diff citations they are about. Nothing is hidden, and a card is not buried under a wall of claims. The verifier often reports one objection twice, as an issue sentence and as the quote inside it, so overlapping objections are collapsed to the fuller one (a bare identifier is never swallowed by a sentence that mentions it), and tooltips and export text carry a character budget instead of the whole list.

Warnings and capped confidence travel with cards, API records, JSON/RSS feeds, Discord, weekly digests, release markdown, and derived story context. Related unchecked prose cannot establish an access-policy headline. `/stats/` separates text coverage, current-policy coverage, verification coverage, and pre-policy history. **Complete text coverage does not imply accurate or currently verified history.**

A release roll-up is a version-bump row describing what shipped, so it is written **and checked** against its window rather than against its own one-line manifest diff: the window lists the release's changes with the files each one touched, and the verifier is told that a claim is supported when the window lists the corresponding change. That framing exists because the bump's own diff can never contain the features the row is about, which made every roll-up look unsupported. Mixed code-plus-version releases receive the window **and their own source hunks** in both writing and checking. Functional release responses that collapse into version/packaging boilerplate are rejected for repair, including in map/reduce fusion. Unchanged READMEs and package inventories cannot establish newly shipped features. A failed plain-English fact-check gets one repair; a replacement is accepted only after its exact text passes. Windows exclude members with ungrounded names, failed value checks or flagged/stale claims. If a member's reviewer was unavailable, only its deterministic facts enter the window, never its unchecked AI prose. Members that predate the policy are the history a window exists to describe, so they stay in it and are disclosed per row instead of being dropped. Deterministic catalog events still count. Window hashes invalidate dependent forward roll-ups and explanations together; omissions and partial evidence remain visible. Deferred verification uses a hash-bound stored evidence bundle when the context key changes and checks only the currently published artifact, so changing a window cannot strand a pending review or resurrect discarded prose. A release with no AI summary renders a read-only mechanical fallback sampling changed test assertions across the stored list, explicitly as test expectations rather than a live-rollout claim. Legacy roll-ups are not rewritten at API cost, so stored objections from the old framing stay on the rows that carry them.

Large new diffs use an 8 MB extraction ceiling, streamed full-source inventory before selection, source-first prioritization, and line-split chunks for giant files. Default map/reduce starts around **782,400 characters**, derived from the fixed window. Map calls are bounded to eight; bigger inputs can still be partial and are labelled as such. Historical truncated diff files are **not regenerated**. A stored diff is never described as guaranteed complete.

Structured constants are keyed by path/symbol; authoritative extraction can replace equally sized or smaller old fact sets. Novelty requires a successful base-revision lookup proving absence: missing revisions, lookup errors, or exhausted budgets mean unknown, not new. Changed test assertions remain evidence even when novelty is unknown.

The published significance tier is the deterministic entry tier on cards, feeds, digests, and API. Model significance remains an advisory judgment for calibration. Unknown motive is acceptable; no paid repair is required merely to invent a WHY clause. Unsupported marketing claims are rejected rather than advertised as accuracy improvements.

## Evaluation and human corrections

`eval` audits stored golden-set artifacts **offline**, without fetching upstream or calling a writer/judge. Missing entries/text and row failures are counted; every completed row checkpoints; incomplete, unsupported, or all-failed runs fail the CLI gate. Partial results are excluded from comparison. The weekly workflow always uploads reports/checkpoints, even when the audit fails, and does not commit results to main.

This audit is not a fresh semantic re-evaluation or proof that a changed prompt improved historical accuracy. Human-reviewed references and adversarial mocked regressions complement it. Existing unverified golden rows may intentionally make the weekly audit red. Paid historical replay is blocked by the operator CLI.

Human overrides in [data/overrides.json](data/overrides.json) take precedence at build time across reader surfaces. `override <sha>` prints a draft; explicit field arguments write a correction. Overrides do not require regeneration.

## Site and exports

- Daily timeline, archive, release notes, model catalog/lineage, area/audience filters, search, and stats.
- RSS slices, JSON Feed, weekly digests, OPML subscriptions, and Discord copy.
- `/api/entry/<sha>[.json]`, recent `/api/entries.json`, day shards, `/api/status.json` (observed upstream head plus source-check stamp).
- Stable commit permalinks, date ranges, inline stored diffs, and release `notes.md` / `?format=md`.
- Open-PR previews are proposals, not shipped behavior. Stale revisions and unverified previews are disclosed.

## Configuration

| Setting | Contract |
|---|---|
| `CHANGELOG_LLM=1` + `LLM_API_KEY` | Optional enrichment of admitted new work only |
| `LLM_MODEL`, `LLM_MODEL_MAJOR`, `LLM_VERIFY_MODEL` | Model identities/routing; the configured writer is `gemini-3.6-flash` and the code literal floor stays `deepseek-v4.1` |
| `LLM_API_BASE` | OpenAI-compatible provider; configured `https://generativelanguage.googleapis.com/v1beta`, literal floor `https://vyceai.com/v1`. A missing setting can no longer route the writer elsewhere; the run logs the identity it is using |
| `LLM_API_KEYS` | Comma-separated bearer keys rotated one per call; the rolling RPM window stays global, so more keys share the load rather than raising the cap. `LLM_API_KEY` remains the single-key form |
| `CHANGELOG_LLM_STREAM` | Requests stream by default (`stream: true`). Not a preference: the provider's non-streaming path times the origin out after ~12s and answers 504, while the same bytes streamed answer 200. `=0` disables, and a gateway that rejects the field is probed once and then never asked again |
| `CHANGELOG_LLM_CYCLE_BUDGET_MS` | Wall clock one cycle may spend on model calls (default 300,000; further bounded by the watch run's remaining time) |
| `CHANGELOG_LLM_ROW_BUDGET_MS`, `CHANGELOG_ELI5_ROW_BUDGET_MS` | Wall clock one row owns for all of its calls — writer, repairs, and any check (defaults 90,000 and 45,000). A row that runs out is left for the next cycle and keeps the short cooldown; it is never parked for our own budget |
| `CHANGELOG_LLM_VERIFY` | `all` (default) checks every row; `1` selective; `0` disables the pass and cannot confer trust. The relay runs with `0` by operator decision (2026-10-02): a new row carries no verdict, says so, and never claims to be checked. Rows that already carry a verdict keep it |
| `LLM_BACKUP_API_BASE`, `LLM_BACKUP_API_KEY`, `LLM_BACKUP_MODEL` | Failover route: consulted once, only when the primary fails at the transport/gateway level (5xx, connection, response timeout, 408, exhausted 429 wait). Auth, content and validator failures stay on the primary so they surface there; `CHANGELOG_LLM_BACKUP=0` disables it. Shares the primary's entry cap, cycle budget and 60 RPM window |
| `LLM_TIMEOUT_MS` | Default 60,000 ms, bounded further by remaining cycle time; includes body consumption |
| `CHANGELOG_LLM_LIMIT`, `CHANGELOG_ELI5_LIMIT` | Entry limits; production defaults to a small bounded batch |
| `CHANGELOG_LLM_CONCURRENCY`, `CHANGELOG_LLM_RPM` | Default two workers and 40 requests/minute — the provider's own account limit. The configured value can only go lower, never above the contract |
| `CHANGELOG_LLM_MAX_ATTEMPTS` | Default three lifetime failure attempts per input; deterministic refusal/memory failures park earlier |
| `CHANGELOG_PR_CALLS` | GitHub decoration ceiling capped at 40/cycle, even with authentication |
| `CHANGELOG_SYNC_STALE_MIN` | Default five minutes; freshness gate fails at twice this age |
| `SITE_URL` | Deployment/feed URL |

## Deployment safety

[Generator CI](.github/workflows/generator-check.yml) runs syntax, build, and offline regressions on code changes. [Sync](.github/workflows/changelog-sync.yml) selects the latest successful push-tested **compatible policy runtime**, extracting its generator separately while keeping current data. It does not run the full suite before every poll. Bootstrap requires one successful generator-check; a pre-policy runtime is not allowed to bypass no-backfill constraints.

The relay polls every 30 seconds and has a ten-minute watchdog. These are **targets, not a hard end-to-end guarantee**: runner delays, upstream failures, and deploy queues still matter. Deterministic publication precedes model work. Recovery has reserved capacity and runs even when all summaries exist.

[Deploy](.github/workflows/deploy.yml) builds static assets and uploads through the existing Cloudflare workflow. Worker changes trigger it. After upload it checks the served head against the built head and the served timestamp for staleness, and reports current upstream divergence. A disabled relay never exempts freshness. Cloudflare credentials, GitHub token permissions, and live behavior were not changed or exercised by local validation.

History compaction is replaced by a read-only [size audit](.github/workflows/history-compaction.yml): no force pushes, orphan branches, or workflow disabling. Human code history is not disposable. Historical rewrite is a read-only policy notice. Disabled legacy scripts cannot bypass locks or overwrite evidence.

See [implementation mapping and limits](reports/pipeline-implementation.md) for R1–R20 coverage, validation evidence, and deliberate no-backfill exclusions.
