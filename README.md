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
- Models are unchanged: existing `LLM_MODEL`, optional `LLM_MODEL_MAJOR`, and configured verifier routing are retained. The verifier default remains `deepseek-v4.1`. No new model is selected by this remediation.
- The provider context contract is fixed at **270,000 tokens**, with 8,000 output tokens reserved and conservative character budgeting. Environment settings cannot silently increase the window. Character budgeting is an estimate, not an exact tokenizer.
- A production cycle has a four-minute git/network deadline, a two-minute enrichment deadline within it, **40 total model requests**, and **12 requests per entry**. Retries, repairs, relevance gates, verification, and self-checks all consume this budget. Failed rows retain durable attempt counts and cooldowns.

Operator commands (not local validation commands):

```bash
node generator/cli.mjs generate [--full] [--push]
node generator/cli.mjs catch-up [--push]
node generator/cli.mjs watch [--push] --interval 30 --duration 12m
node generator/cli.mjs freshness
node generator/cli.mjs eval [--limit N]   # offline stored-artifact audit
node generator/cli.mjs override <sha>    # inspect a human-correction draft
```

`--push` is consequential: it commits and pushes generated data. Broadcast sends external messages. Neither is required for build/test verification.

## Evidence and trust

The writer receives redacted source hunks, mechanical facts, revision-bound module/consumer context, and accepted PR intent. Source, PR descriptions, comments, older summaries, and quoted instructions are **untrusted data** in a separate user message; the system message provides the trusted task boundary. Inferred file-set PR matches fail closed when relevance cannot be established. PR disappearance means closure, not merge; shipped-intent matching uses only confirmed merged closures.

A failed generation is retried with a materially different ask, never with the same bytes. A reply that comes back wrong — a refusal, prose instead of JSON, an answer from training memory — takes the rung built for it: the ask with the diff's comments stripped, or the one with the wide repository-derived sections dropped. A reply that never comes back (a gateway 5xx, a dropped connection, a timeout) was, until 2026-09-30, re-sent verbatim up to three times and then handed to the next cycle unchanged, so a row whose request is slow enough to time out spent four identical full-size calls an hour apart and stayed ungenerated while smaller rows in the same cycles succeeded. It now spends its verbatim retries and then asks the smaller question once, which is the only attempt that can still change the answer. Rows that never resolve keep their recorded failure and are retried on a short cooldown; nothing is parked silently. The cooldown is re-read from the stored message rather than trusted from when it was written: a row whose calls were killed by our own cycle deadline or request budget gets the short cooldown however many times it happened (four deadline kills were storing `fc37ac10` as a permanent failure, so it could never be regenerated even after the gateway recovered), while a refusal on every rung is still parked for good, and a parked row is released by the next prompt version rather than by editing the cache.

New policy records carry source/base/head, model, prompt, delivered-evidence and context hashes. Forward summary cache identities include the complete gathered prompt/context and validator policy; PR identities include title, description, labels, and commit subjects. Verdicts bind to the exact published factual artifact. Editing checked text invalidates its verdict; changing only confidence does not.

Validation covers titles, summaries, evidence, migration steps, unknowns, settings, and per-topic claims. Semantic verification requires an explicit boolean verdict, valid claim records, and coverage of every published sentence/list item, audience, and boolean field. Malformed replies and timeouts never count as passed. A missing reviewer cannot clear an existing objection. Breaking/migration claims are not promoted as actionable until confirmed; self-check failure demotes them.

A deterministic pass also checks that every name, number and path the row publishes is present in the evidence the row was written from, and names it cannot find are reported as unverified. Grounding is by whole token, so a truncated prefix of a real name is caught, but a claim is read the way source is read: a member name after a dot (`server.httpServer`) is a mention of that member, a quoted fragment (`models?`) is grounded by verbatim presence, a wildcard (`run-*.ts`) by its head, a call (`fn(hasPaidPlan)`) by its callee, a file name without regard to case, and a subscript (`PATTERNS[1]`) is a claim about `PATTERNS` with a position attached — the index is never spelled by a declaration, so requiring the whole span reported faithful quotes as inventions. Fourteen of the twenty-two rows flagged under the earlier rule were faithful quotations, re-checked against their own diffs; stored flags are forward-only and are retired by the heal pass, never rewritten by hand.

Plain-English explanations receive their own semantic check for audience, availability, conditions, quantities, causal effects, and promises. Test/documentation-only entries can use deterministic templates without API calls. Same-family checking has correlated blind spots; a passed model check is not a human audit or proof of correctness.

Disclosure is two-tier, so the warning keeps its meaning. Rows where a check **ran and did not pass** carry a visible `[UNVERIFIED]` badge and a demoted action label. Rows that merely predate the current policy were never checked, which is not a failure: they carry no badge and keep the labels they shipped with, and say so in one sentence in their own Evidence block, in the API `quality.notes`, and as a single counted line on `/stats/` (`pre-policy history`). Stored history is not relabelled as broken by a policy it never ran under, and it is not silently presented as checked either.

The verifier carries its own version (`VERIFY_POLICY_V`), separate from the writer's prompt version, because a verdict is only as current as the framing that produced it. A row whose recorded verdict predates the current framing gets **one** deferred re-read: verdict only, never a writer call and never replaced text, bounded by tries and a cooldown, and stamped afterwards so it is not re-read again. That is how objections raised under superseded framing are retired, including for history the no-backfill gate keeps out of the writer queue.

A call the endpoint never answered — a gateway 5xx, a timeout, a throttle, or a call the cycle deadline killed — produced no verdict, so it spends a separate, much looser no-answer allowance instead of one of the row's three verdict tries; the cooldown still spaces the re-ask. During the 2026-09-30 gateway outage every re-check was charged to the verdict budget, so a row hit its three-try cap after 90 minutes of 504s and the fresh read it was owed could never happen. A refusal or a malformed reply, by contrast, is the model answering badly: that is a real attempt and is charged as one.

Where a warning does apply, the badge is the signal and the objections themselves sit in that entry's Evidence block, whose toggle counts them (`N objections`) next to the diff citations they are about. Nothing is hidden, and a card is not buried under a wall of claims. The verifier often reports one objection twice, as an issue sentence and as the quote inside it, so overlapping objections are collapsed to the fuller one (a bare identifier is never swallowed by a sentence that mentions it), and tooltips and export text carry a character budget instead of the whole list.

Warnings and capped confidence travel with cards, API records, JSON/RSS feeds, Discord, weekly digests, release markdown, and derived story context. Related unchecked prose cannot establish an access-policy headline. `/stats/` separates text coverage, current-policy coverage, verification coverage, and pre-policy history. **Complete text coverage does not imply accurate or currently verified history.**

A release roll-up is a version-bump row describing what shipped, so it is written **and checked** against its window rather than against its own one-line manifest diff: the window lists the release's changes with the files each one touched, and the verifier is told that a claim is supported when the window lists the corresponding change. That framing exists because the bump's own diff can never contain the features the row is about, which made every roll-up look unsupported. Windows exclude only members a check actually discredited: ungrounded names, failed value checks, or a recorded verdict of flagged/stale/unavailable. Members that predate the policy are the history a window exists to describe, so they stay in it and are disclosed per row instead of being dropped. Deterministic catalog events still count. Window hashes invalidate dependent forward roll-ups and explanations together; omissions and partial evidence remain visible. Legacy roll-ups are not rewritten at API cost, so stored objections from the old framing stay on the rows that carry them.

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
| `LLM_MODEL`, `LLM_MODEL_MAJOR`, `LLM_VERIFY_MODEL` | Existing model identities/routing; verifier default `deepseek-v4.1` |
| `LLM_API_BASE` | Existing OpenAI-compatible provider; default `https://api.openai.com/v1` |
| `LLM_TIMEOUT_MS` | Default 60,000 ms, bounded further by remaining cycle time; includes body consumption |
| `CHANGELOG_LLM_LIMIT`, `CHANGELOG_ELI5_LIMIT` | Entry limits; production defaults to a small bounded batch |
| `CHANGELOG_LLM_CONCURRENCY`, `CHANGELOG_LLM_RPM` | Default two workers and 60 requests/minute; shared request ceiling still applies |
| `CHANGELOG_LLM_MAX_ATTEMPTS` | Default three lifetime failure attempts per input; deterministic refusal/memory failures park earlier |
| `CHANGELOG_LLM_VERIFY` | All rows by default; `1` selective, `0` disables and cannot confer trust |
| `CHANGELOG_PR_CALLS` | GitHub decoration ceiling capped at 40/cycle, even with authentication |
| `CHANGELOG_SYNC_STALE_MIN` | Default five minutes; freshness gate fails at twice this age |
| `SITE_URL` | Deployment/feed URL |

## Deployment safety

[Generator CI](.github/workflows/generator-check.yml) runs syntax, build, and offline regressions on code changes. [Sync](.github/workflows/changelog-sync.yml) selects the latest successful push-tested **compatible policy runtime**, extracting its generator separately while keeping current data. It does not run the full suite before every poll. Bootstrap requires one successful generator-check; a pre-policy runtime is not allowed to bypass no-backfill constraints.

The relay polls every 30 seconds and has a ten-minute watchdog. These are **targets, not a hard end-to-end guarantee**: runner delays, upstream failures, and deploy queues still matter. Deterministic publication precedes model work. Recovery has reserved capacity and runs even when all summaries exist.

[Deploy](.github/workflows/deploy.yml) builds static assets and uploads through the existing Cloudflare workflow. Worker changes trigger it. After upload it checks the served head against the built head and the served timestamp for staleness, and reports current upstream divergence. A disabled relay never exempts freshness. Cloudflare credentials, GitHub token permissions, and live behavior were not changed or exercised by local validation.

History compaction is replaced by a read-only [size audit](.github/workflows/history-compaction.yml): no force pushes, orphan branches, or workflow disabling. Human code history is not disposable. Historical rewrite is a read-only policy notice. Disabled legacy scripts cannot bypass locks or overwrite evidence.

See [implementation mapping and limits](reports/pipeline-implementation.md) for R1–R20 coverage, validation evidence, and deliberate no-backfill exclusions.
