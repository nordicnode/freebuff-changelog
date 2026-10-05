# LLM pipeline audit — 2026-10-05

## Scope and conclusion

Read-only investigation of recent generator/workflow commits, GitHub Actions logs, committed caches/day shards, the deployed website/API, and the supplied [Agnes documentation](https://www.agnes-ai.com/en/docs/agnes-30-flash). No provider requests, workflow dispatches, secret changes, deployments, commits, or pushes were made.

**There are separate configuration, retry/scheduling, and observability failures. A successful sync/deploy does not establish successful LLM generation.** The Agnes defaults match the documented API; the first promoted provider-switch run received an invalid override. Old error stubs then obstruct recovery even when provider identity changes. Named regeneration also has an incorrectly anchored plain-English deadline.

Workspace code examined: `b092e52c`. Remote data sampled at `ff13e689` (16:48 UTC). Live API last checked at **16:58:41 UTC**; the status endpoint reported at 16:58:27 UTC: `generatedAt=2026-10-05T16:53:33.170Z` and upstream head `5d02de3e8d4e79daafd09162f66356696ce4d15a`, matching GitHub upstream. Thus ingestion was current at the final check; the missing generation was not.

## Reader-visible impact

Confirmed through the public `/api/entry/<sha>.json` interface, not just stored data:

| Entry | Date | Missing |
|---|---|---|
| [0f35bd7a — Agents update: base2-free-mimo](https://freebuff-changelog.nordicnode.workers.dev/c/0f35bd7aa3a4) | Oct 5 | Summary and plain-English explanation |
| [5d02de3e — Freebuff CLI 0.2.16](https://freebuff-changelog.nordicnode.workers.dev/c/5d02de3e8d4e) | Oct 5 | Summary and plain-English explanation |
| [38d5cf2d — Shared/Core update: llm](https://freebuff-changelog.nordicnode.workers.dev/c/38d5cf2d883a) | Sep 29 | Summary and plain-English explanation |
| [e4a960f7 — Database alert threshold / CLI 0.1.0](https://freebuff-changelog.nordicnode.workers.dev/c/e4a960f781ae) | Sep 27 | Plain-English explanation at 16:57; appeared by 16:58, but `needs-repair` remains (partial evidence) |

The workspace snapshot contains 8,054 non-noise entries and 201 admitted to automatic enrichment. Among those admitted rows, 198 have summaries, 197 have plain-English text, 30 report `needs-repair`, and 167 report `review-pending`. Review-pending is not equivalent to a failed generation: verification is deliberately disabled for current production calls, and these totals also include earlier pending verdicts.

There are **677 non-noise rows without plain-English text**, but **673 are outside automatic admission**. The default forward-only policy will not repair that historical gap. Increasing the automatic limit does not change admission.

## Findings

### 1. Provider switch initially used an invalid configured base URL — confirmed production failure

Commit `b092e52c` sets correct defaults:

- Base: `https://apihub.agnes-ai.com/v1`
- Model: `agnes-3.0-flash`
- Request endpoint: `/chat/completions` appended to the base

However, workflow secrets/variables take precedence over those defaults. [Run 37342686893](https://github.com/nordicnode/freebuff-changelog/actions/runs/37342686893) selected **b092e52c** at 16:45:03 UTC, then logged URL parsing failures for summaries, ELI5, and PR previews. The persisted cache reveals the exact failed URL: **`-/chat/completions`**. This is a local request-construction/configuration error, not an Agnes HTTP outage.

That run logged 36 URL errors across all stages and wrote zero summaries/ELI5 lines. At the sampled remote revision, the shared summary cache retained 15 summary error stubs and one ELI5 error stub from this incident. The counter labels them API calls, although URL parsing happens before an HTTP request can reach the provider.

GitHub secret metadata shows `LLM_API_BASE`, `LLM_API_KEY`, and `LLM_MODEL` updated around **16:47 UTC**, followed by a new run at 16:48:44. That may be a configuration correction already in progress; metadata cannot reveal or validate the current secret values. The replacement run was still running at the final check, and GitHub refused its unfinished logs. A new `data: forward enrichment` commit (`f11af8f7`, 16:56:53 UTC) was deployed, and by 16:58:41 UTC the live `e4a960f7` record carried an Agnes plain-English manifest and no missing text. That is evidence of at least one successful Agnes generation after the restart. Its quality still says `needs-repair` because summary and plain-English evidence are marked partial; the other three rows still lack both texts. Do not treat the malformed base as confirmed current configuration, or claim full recovery.

**Recommendation:** validate effective route URLs and model settings once before building paid queues. Reject malformed primary/backup/stage configuration as a process/configuration fault, not as a permanent failure on each row. Perform one bounded provider contract test after validation, before attempting a backlog.

### 2. Retry prefilter ignores provider/input identity and explicit force — reproduced offline

[generator/lib/llm.mjs:4536–4567](../generator/lib/llm.mjs#L4536-L4567) builds `coolingShas` using SHA plus current prompt version. It does not compare the provider/model identity carried by the current ask. The candidate loop skips these SHAs **before** computing the exact content-addressed cache key.

Consequences:

- A refusal recorded on the old provider blocks a materially different ask on Agnes until its old cooldown expires, or forever if parked.
- Both summary and ELI5 current-version failures participate in the SHA-wide prefilter.
- `force` makes `isCurrent` false, but does not bypass `coolingShas`. A named `regen-last` can therefore ask nothing despite the later exact-key gate explicitly allowing forced rows.
- The claim in `b092e52c`'s commit message that admitted backlog requeues under the new model is not reliable for error-only rows.

At 16:12 UTC, the three missing-summary rows each received an attempt-1 deterministic error. Each gets a one-hour cooldown, explaining the later logs: **“3 remaining: 0 eligible, 3 cooling, 0 parked”** even after the provider switch. These particular failures were not yet permanently parked in the sampled state.

Offline mocked-interface reproduction using a parked old-provider stub:

| Scenario | Rows written | Patch reads | Fetch calls |
|---|---:|---:|---:|
| New Agnes provider/model identity | 0 | 0 | 0 |
| Explicit `force` + named `only` scope | 0 | 0 | 0 |

No real provider was contacted. Results are saved in [reproductions.json](../.cache/pipeline-audit/reproductions.json).

**Recommendation:** make retry eligibility agree with the actual request identity, and honor explicit force before the cheap prefilter. Maintain bounds and forward-only admission; do not clear the whole cache or reset attempts on every run.

### 3. Named regeneration's ELI5 deadline is earlier than its summary deadline — confirmed code defect

[generator/cli.mjs:2199–2220](../generator/cli.mjs#L2199-L2220) allocates 60% of a run to summaries and 40% to ELI5, but computes both deadlines from the same original `startedAt`:

- Summary: `startedAt + summaryBudgetMs`
- ELI5: `startedAt + eli5BudgetMs`

For the six-minute minimum run, summary has 216 seconds, while the ELI5 deadline is only 144 seconds after the original start. If the writer consumes its allowed window, ELI5 begins **72 seconds after its own deadline** and immediately skips. It does not receive the reserved 144 seconds.

**Recommendation:** give ELI5 a real post-summary window, bounded by the total run budget, and add an end-to-end named-regeneration test where summary consumes more than 40% of the total budget.

### 4. Earlier upstream/provider failures were real, and failover fixes did not replay failed asks

[Oct 1 run 36942882212](https://github.com/nordicnode/freebuff-changelog/actions/runs/36942882212) includes HTTP 503/504, transport timeouts, and cycle-deadline cuts. Across three summary passes it wrote **one summary in 33 counted calls**; explanation passes wrote 14 lines in 107 calls. This aligns with the high transient-error event counts in [data/llm-health.json](../data/llm-health.json), but those daily totals are event counts, not unique affected rows.

[Oct 5 retry run 37338160921](https://github.com/nordicnode/freebuff-changelog/actions/runs/37338160921) explicitly released `0f35bd7a`, `5d02de3e`, and `38d5cf2d`, then wrote **0 of 3 summaries in 9 calls**. Replies included “The latest Claude Opus model I know about…” and “I'm DeepSeek…”, rather than source-diff JSON.

The fix sequence matters:

- `ef725acf`: route classification plus more selective relay yielding.
- `09e1f6be`: refusal failover, shorter warmup, concurrency 3.
- `49416c34`: raise RPM ceiling.
- `45295881`: actually consult backup before throwing the attempt-3 deterministic failure.
- `b092e52c`: switch default provider/model/context.

The original failover classifications were insufficient because the deterministic branch threw before reaching route failover. `45295881` addresses that path, but old failure stubs are not automatically replayed by code changes alone. The successful 16:28–16:40 relay run repeatedly wrote zero rows because all three were cooling.

**Recommendation:** after configuration and retry-gate repair, recover only the named affected rows using bounded operator scope. Include ELI5-only failures; `retry-failed` skips rows that already have a summary, so it cannot by itself repair `e4a960f7`.

### 5. Successful workflows and backlog counters hide failed/stale generation

- Catch-up counts a row current mostly by `ai.title`, while the writer checks model/input identity and release context. The provider-switch run logged “3 remaining” while also attempting rewrites of rows with existing summaries. This underreports actual generation work and identity-stale text.
- Generation errors are caught and stored; deterministic ingestion can keep publishing and the workflow can stay green over zero LLM progress.
- [generator/cli.mjs:2094](../generator/cli.mjs#L2094) says failure stubs are cleared and the next relay cycle asks again even though the failed retry just wrote fresh stubs with a one-hour cooldown. The observed next cycle made no asks.
- The deploy “Verify uploaded head” step reads the checkout manifest and upstream SHA; it does **not** fetch the served website. Its name overstates what it validates.
- The default heal path requires a replacement verdict of `passed` ([llm.mjs:4844](../generator/lib/llm.mjs#L4844)), while production verification is disabled. That path cannot accept an otherwise cleaner unchecked rewrite. A named forced rewrite is a separate path.

**Recommendation:** separate ingestion freshness, actual served-deployment freshness, generation completeness, generation identity freshness, and review state. Report oldest missing admitted row, actual eligible queue, route/configuration failures, and writes versus requests sent. A persistent configuration failure or sustained generation starvation should produce an explicit failing health signal without withholding deterministic updates.

## Staleness assessment

Staleness was real earlier: [deploy run 37337455987](https://github.com/nordicnode/freebuff-changelog/actions/runs/37337455987) failed at 16:01 UTC because the data manifest was **35 minutes old**. Sync logs also reported a 34-minute last-sync age before republishing.

At the final live check, the served manifest was approximately 3.5 minutes old and matched upstream head. This investigation does **not** establish that the former relay issue was solely phantom queued runs; the latest commit documents that diagnosis, but actual cancellations, setup delays, and handoffs are also visible. The observed green workflow does not mean the missing summaries recovered.

## Agnes contract check

The supplied authoritative documentation confirms:

- `POST https://apihub.agnes-ai.com/v1/chat/completions`
- Bearer authentication, `messages`, `temperature`, `max_tokens`, and `stream`
- `agnes-3.0-flash`, 512K context, 65,536 maximum output tokens
- OpenAI-compatible `choices[].message.content`

The ordinary request shape and streaming setting match. `response_format` is not listed on this page; the existing per-route compatibility probe handles an explicit unsupported-field response, but that is not proof this feature is supported. Account RPM/availability are entitlement-specific: the current 60-RPM ceiling is inherited from the previous provider, not documented as Agnes's account allowance. These are follow-up contract checks, **not demonstrated causes of the URL failure**.

## Recovery priority

1. Validate the effective primary/backup/stage configurations and confirm the 16:47 secret correction using a bounded real integration test.
2. Repair identity-aware retry/force gating and the named-run ELI5 deadline, with regressions covering the offline reproductions above.
3. Regenerate the three named missing-summary rows, preserving shipped text on failure. Reassess the newly recovered `e4a960f7` partial-evidence quality separately. Do not run a broad historical rewrite.
4. Add separate generation/served-freshness health checks and accurate queue counters.
5. Decide explicitly whether the 673 historical explanations outside admission should be backfilled; current automatic policy forbids it.

## Verification and limitations

- Public homepage, `/api/status.json`, daily records, and all four affected `/api/entry/` records checked in the browser.
- Offline retry reproduction confirmed zero asks under both provider change and explicit force.
- Existing relevant offline suites: **67/67 passed**, zero skipped. Passing existing tests do not cover the newly demonstrated defects. [Test output](../.cache/pipeline-audit/offline-tests.log).
- No source-code repair was made in this investigative task; only this report and ignored diagnostic artifacts were created.
- Current secret values are unreadable; only names/update metadata were inspected. The newest in-progress run's logs were unavailable. One successful post-restart Agnes explanation is evidenced by the live API manifest; the three missing summaries remain unrecovered.

## Remediation (subsequent implementation)

The findings above describe the original read-only audit. The follow-up implementation repairs:

- Identity-aware summary cooldowns (separate from explanation failures), explicit force for both artifacts, and shared identity-current backlog counters. New failures carry input/route/release identity; older stubs are handled at the exact-key gate rather than vetoing new routes.
- Provider URL/model/key preflight and process-level authentication errors. Configuration faults create no row failure stub, stop additional queued asks, and fail the watcher immediately after deterministic publication.
- Correct post-summary explanation deadlines in named regeneration, with an end-to-end offline CLI test advancing the writer clock past 40% of the total budget.
- Gateway-body failover after the attempt cap; a backup outage following a refusal remains transient rather than permanently parking the row.
- PR retry identity, transient retries, actual served-model provenance, and no unavailable verdict when verification is disabled.
- Opt-in daily re-probes for repeatedly failing rows in the relay, retaining attempt counts and all row/cycle/rate limits. No automatic historical backfill is introduced.
- Independent `generation-health` CLI/workflow gates after publishing and generation health in `/api/status.json`. Historical non-admitted gaps and intentional unchecked text do not trip the gate; overdue admitted missing text does.
- A served-website head/timestamp probe, including unchanged upstream-head redeploys, and bounded asset-propagation retries.
- Relay queue inspection corrected to use supported `gh --jq` syntax without silently turning API errors into an empty queue. A failed named repair no longer suppresses deterministic sync.
- Unchecked-text healing can accept a strictly cleaner replacement without inventing a verdict; recorded factual objections require a real passing check to clear.

Verification includes the full offline suite on Node 26 and CI's Node 22, the opt-in real-fetch 65-second response regression, Actionlint validation, and browser inspection of the new local status/entry API. The generation-health CLI intentionally reports failure against the existing three overdue rows until production recovery writes their text. No historical content or production secrets were edited.

## Second remediation: the oversized row that could never be asked (2026-10-05 19:xx UTC)

The first remediation's gate did its job and then kept firing: both `changelog-sync` and
`deploy-site` failed their generation-completeness step on every run, naming the same single
admitted row, `d71a831b` (release 0.2.8), which had no plain-English line. Its stubs read
`LLM entry time budget exceeded`, `attempts` climbing, `transient: true` -- a row that kept
being asked and never answered.

The cause was arithmetic, and it was permanent:

| measurement | value | source |
|---|---|---|
| `data/diffs/d71a831b….diff` | 836,045 chars (486 additions, 10,542 deletions) | the stored diff |
| plain-English prompt built from it | **842,051 chars** | `buildEli5Prompt`, replayed offline |
| one real production call with 828,311 chars | **63,439 ms** (`validated`, `agnes-3.0-flash`) | `data/ai-summaries.json`, request ledger |
| prefill throughput that implies | 13,056 chars/second | 828,311 / 63.4 s |
| plain-English row clock | 45,000 ms | `CHANGELOG_ELI5_ROW_BUDGET_MS` |

A prompt that needs 63 seconds to prefill cannot be paid for by a 45-second clock. Every cycle
aborted the request mid-flight, the ladder retried into a spent clock, and the row was written
back as unanswered -- forever, because nothing about the row changes. The `deploy-site` gate then
reported it again on every data push (~200/day) even though the deploy itself had succeeded and
the workflow could neither write text nor dispatch a cycle.

Repairs:

- **Prompts are sized against the row's clock, not only the model's window.** `diffRoom` now takes
  the row budget and caps the diff at `clock x CHANGELOG_LLM_PREFILL_CHARS_PER_SEC (12,000, measured
  13,056) x CHANGELOG_LLM_PROMPT_CLOCK_SHARE (0.5)`, minus whatever the fixed sections already cost.
  The half is deliberate: the rest pays for the answer, the in-row RPM wait and one retry. Ordinary
  rows are untouched (half of 90 s is 540,000 chars; only one row in this repo exceeds even the 45 s
  figure), and the floor keeps real hunks in every prompt. Applied to the summary ask, the
  plain-English ask (per-change and roll-up), the verifier and the re-check.
- **Result on the stuck row**: plain-English 842,051 -> **236,917 chars** (~20 s at the conservative
  rate, inside 45 s); summary 849,175 -> **540,178 chars** (~45 s, inside 90 s).
- **One hard gate, in the workflow that owns generation.** `changelog-sync` still fails on overdue
  admitted text and still dispatches the healing cycle. `deploy-site` now runs
  `generation-health --report`: identical numbers, identical row list, a `::warning::` annotation,
  exit 0. A missing `data/changelog.json` still fails there, and a stalled relay still fails the
  freshness gate, so the advisory step removes noise, not signal.

Verification: two regression tests fail on the pre-fix code and pass after it (the prompt-clock
ceiling and the plain-English row clock), the full offline suite passes on Node 26 (496 tests,
495 pass, 1 opt-in skip) and on Node 22, and the CLI's two strengths were run against live data
(`--report` exits 0 and warns with the row list; the default still exits 1).

Still open, unchanged and intentional: ~30 `needs-repair` rows with partial evidence or recorded
objections, the historical explanation gaps outside durable admission (no backfill), provider 429/504
bursts, and the ~160 admitted rows whose summary identity is stale under the current provider and
are being re-asked in bounded batches.

## Third finding: the roll-up line was charged the per-change clock (2026-10-05 20:2x UTC)

The first relay cycle on the new runtime (`82ab8c86`) healed the four-day-old row: `d71a831b`
got its first plain-English line at 19:59:32Z, written from a 236,917-char prompt instead of
842,051, and the pass wrote 6 of 6 lines that cycle.

One row still failed, and it was a different shape: `95ecda2e` (Freebuff CLI 0.2.14) had its
summary rewritten at 20:01:55Z, which by design deletes the plain-English line it no longer
matches (`eli5.src` is the hash of the title+summary it was written from). The ELI5 pass reached
it 10 seconds later and aborted mid-answer: a release roll-up carries the release window (its
summary prompt was 300,718 chars, the same wide evidence the summary ask pays a 90s clock to
read) and is asked for up to eight sentences, but it was charged the 45s per-change share. Small
rows in the same pass finished in seconds.

Fix: `CHANGELOG_ELI5_ROLLUP_BUDGET_MS` defaults to the wider of the two row budgets (90,000), and
`explainEntry` charges a roll-up row that clock, sizing its prompt from the same number. Per-change
rows keep the 45s share. Regression test: with a 150ms per-change share, a stalled roll-up row is
answered under the wide clock while a per-change row in the same env is still cut.

This also names the churn that keeps the completeness gate red in bursts: a summary rewrite
invalidates the plain-English line it explained, so every bulk summary re-ask (provider migration,
prompt change) creates a set of rows that are "missing plain-English" until the ELI5 pass catches
up, and the 30-minute gate budget is shorter than that catch-up when many rows change at once.
The relay now closes that gap in the same cycle for the rows it rewrites, but a large bulk rewrite
can still expose rows for one cycle. Both workflows report it honestly; neither is silent about it.

## Fourth finding: the gate charged the admission clock for a gap that had just opened (2026-10-05 21:1x UTC)

`generationHealth` gave every admitted row a 30-minute budget measured from
`enrichment.admittedAt`, then failed the run if required text was still missing. Admission dates the
*requirement*, but not each gap inside it. A summary rewrite changes `eli5Source(e)`, and the merge
deletes the line that explained the old text rather than publish a line about a summary it no
longer describes, so a row admitted days ago can lose its plain-English line on this cycle's write.
Charged the admission clock, that row was overdue the instant the rewrite landed, before the
same-cycle plain-English pass could possibly have answered.

The live example, measured on the row that was still red: `95ecda2e` was admitted
`2026-10-05T08:17:52Z` and its summary was rewritten `20:01:55Z`, so the old clock reported a
four-day-old gap the moment the new one appeared. The fix computes `missingSince` from when the
requirement arose: admission for a missing summary, and `max(admittedAt, ai.at)` for a missing
plain-English line, since `ai.at` is when the current title and summary were written and therefore
the earliest moment the line explaining them could be absent. Deletion happens at or after that
write, so the value is deliberately the earlier, more forgiving end of the window. The budget still
fails a row whose text has genuinely been absent for 30 minutes; it no longer fails one that just
lost it. `--report` and the hard gate read the same numbers, and the row list now carries
`missingSince` so an overdue row reports its own age rather than its admission date.

This is what made the failure look constant rather than periodic: any batch of summary re-asks
turned the gate red immediately and stayed red until the explanation drain caught up, with no cycle
in between that could have gone green. Regression test: a row admitted four days ago whose summary
was rewritten two minutes ago is not overdue and still counts as `missingPlain: 1`; the same row
with a summary written at admission is overdue, and it becomes overdue again once the grace
elapses.
