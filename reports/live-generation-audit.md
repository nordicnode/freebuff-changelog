# Live generation audit — 2026-10-01

Inspected the actual homepage in Chromium, the Sep 30 timeline, `/stats/`, and the Oct 1/Sep 30/Sep 29/Sep 28 day-record APIs. Live record snapshot: `2026-10-01T15:22:35.207Z`. Counts exclude lockfile/asset churn.

## Coverage visible to readers

| Day | Meaningful entries | No generated summary | No plain-English explanation |
| --- | ---: | ---: | ---: |
| Oct 1 | 25 | 12 | 13 |
| Sep 30 | 29 | 4 | 7 |
| Sep 29 | 34 | 1 | 28 |
| Sep 28 | 17 | 0 | 17 |

Missing explanations and missing summaries overlap; do not add their counts. Missing explanation is not by itself a factual error. API provenance was cross-checked against stored entry AI fields, not inferred from title wording alone.

The local data snapshot has 7,971 meaningful entries: 17 without summaries and 744 without explanations. Live counts can differ while the relay updates data. This does **not** justify regenerating 744 historical rows: many are outside the forward admission policy.

Examples the user sees:

- `2b4fd7db6a35`: “SDK changes across 1 file(s) (+194/−78).”
- `af742b4afe36`: “New files: sdk/src/tools/pinned-fetch.ts.”
- `a8c632ee26b9`: “Removed: sdk/src/tools/pinned-fetch.ts.”
- `a080b0350b61`: a new-file inventory for a 36-file change.
- Several release rows have prose but still explain only a manifest/version change.

The read-only test-assertion fallback is richer than a version literal, but **is not a proper generation** and is counted as missing. It also exposes awkward source-test title fragments. It is not a substitute for explaining mechanisms and user impact.

## Missing-summary repair set

All 17 rows below are admitted in the checked local snapshot. Revalidate admission and current text in production before generation; concurrent relay work may already have filled some.

| Day | SHA | Mechanical title |
| --- | --- | --- |
| Oct 1 | 2b4fd7db6a35ecfa22bbfdcdcce6913119b55120 | SDK update: byok |
| Oct 1 | dfec4965e1fca35dbd60e69e1ce8d3f2ac90a605 | Freebuff CLI 0.2.9 |
| Oct 1 | a8c632ee26b9700e7304d1e830fd4157ce3653ce | CLI cleanup: pinned-fetch |
| Oct 1 | af742b4afe363b3aafc8d7c7da50b4721dc658bb | SDK update: CHANGELOG |
| Oct 1 | 9a24ecd20f4d9e277f877907a9d6850d6382e882 | Shared/Core update: sponsored-command-refusals |
| Oct 1 | 10c969706881170ce54df95709887b58e32ed911 | CLI update: freebuff-landing-screen |
| Oct 1 | cc9b5daf7055fd8c3a1095bfdbfc788014a7708d | Shared/Core update: freebuff-models |
| Oct 1 | d71a831b3a7a5b66a7a100a47a69c2c6bcc70d82 | Freebuff CLI 0.2.8 |
| Oct 1 | a56263b791609357ec8bb7d3e2be4bbc9ed6a20a | CLI update: tool-branch |
| Oct 1 | c5c0acc93f8fec48e0f7f78c536c4ed6dea74a2c | Freebuff CLI 0.2.7 |
| Oct 1 | 0f1fc2d8fa542f76735645866e2d510c7cd66ca6 | CLI update: README |
| Oct 1 | e32b322ebdcb417c7acb704627f1b9b9bc2017c9 | CLI update: freebuff-catalog-store |
| Sep 30 | a080b0350b619eac9376a20495be7f15326080d1 | Agents update: base3 |
| Sep 30 | 28d82f9a80eb3c590275d1072338856d577e7742 | CLI update: byok |
| Sep 30 | 6fbd1ad3e5ea867246171a0c6d90aebdc63fa504 | CLI update: byok |
| Sep 30 | 039c90769849244284480ca92f0b350f7aa0a71b | CLI update: freebuff-landing-screen |
| Sep 29 | 38d5cf2d883a9700d1618b9f7d87d7b18500c1b2 | Shared/Core update: llm |

`dfec4965e1fc` is already in the approved three-release repair; exclude it from another batch. The proposed expansion is **16 additional named rows**, at most 96 total model requests and 16 minutes under the existing `regen-last` budget. No expansion has been dispatched.

## Diagnosis

- Most recorded missing-summary failures are gateway HTTP 504s or cycle deadline interruptions. `a080b0350b61` has a stored failure record with 24 attempts. Some newest rows have no failure stub, meaning they were not reached in the checked snapshot.
- `38d5cf2d883a` has a recorded deterministic refusal parked after two attempts. It needs a named retry or materially different input, not an infinite identical retry loop.
- The prior completed sync (`36882544071`) logged zero summary enrichments and 17 remaining, followed by zero plain-English enrichments. Its repeated 504s ended in the gateway-offline guard. A green sync means ingestion/publication succeeded, **not** that explanations were generated.
- The new fixes passed production CI and deployed as code commit `70dfb39dfd2ecc1a64b38d4cb31c94edabe080d5`. Duplicate outage warnings are removed on the live site; unresolved factual objections remain visible.
- The approved repair run `36883439680` completed (workflow success, regen step 15:29:57–15:32:25). Outcome per its own log: `2/3 rows rewritten`, `2/3 now carry text`, `dfec4965` still without text after repeated HTTP 504s, `verdict could not run: 05b8302c, 03df0d8b`. The following normal watch step then failed `dfec4965`, `d71a831b`, `c5c0acc9` and others on HTTP 504 and hit the gateway-offline guard (`0 entries written in 17 API calls` twice). A green workflow conclusion again means publication succeeded, not generation.
- Live re-count at `2026-10-01T15:41:39.012Z` (noise excluded): Oct 1 = 25 entries, **11 without a generated summary**, 12 without plain-English; Sep 30 = 29 / 4 / 7; Sep 29 = 34 / 1 / 28; Sep 28 = 17 / 0 / 17. Oct 1 review states: 14 `unavailable`, 11 `pre-policy` (none passed).

## Provider / 504 diagnosis

- Provider requests are `deepseek-v4.1` for writer, reviewer and plain-English alike; there is no `LLM_MODEL_MAJOR` or `LLM_VERIFY_MODEL` secret in production, so no fallback route and no independent reviewer.
- Verification HTTP 504s cluster at a 10–19 s median response (Oct 1: 222×504, median 11.3 s; generation 504s similar), far below the local 300 s timeout. This is an upstream/proxy deadline, not our client timeout, and it reproduces on 431-character evidence, so context size is not the cause. No 401/403/429 seen in recent logs, so key expiry and rate limiting are not evidenced.
- Reads-only check of the provider site (`vyceai.com`, OpenAI-compatible multi-model proxy) shows no public status page; no authenticated probe was sent.

## Fixes implemented locally (uncommitted)

All validated by `npm test`: 395 tests, 394 pass, 1 skip, 0 fail; every generator file passes `node --check`.

1. **60 RPM contract enforced, not assumed** (`generator/lib/llm.mjs`, `changelog-sync.yml`):
   - `llmRpm()` clamps any configured value to `1..60`; `0`, `-1`, `NaN`, `Infinity` now fall back to 60 instead of disabling the limiter (the old `Number(env.RPM || 60)` treated `0`/`-1` as "no limit", and offline tests relied on that).
   - One limiter instance serves writer, verifier, plain-English, map/fuse, PR and escalation calls; retries take a slot in the same rolling window instead of being free.
   - HTTP 429 `Retry-After` now parses both delta-seconds and HTTP-date, and defers **all** workers/stages, even when the in-call retry budget is exhausted.
   - Workflow-level `CHANGELOG_LLM_RPM=60` + a 60 s startup handoff (`CHANGELOG_LLM_RPM_WARMUP`) so serialized process handoffs (regen → watch) cannot spend the previous process's trailing minute. The relay workflow is serialized, so no cross-workflow contention exists.
2. **Release evidence fixes** (`RELEASE_ROLLUP_V` 10 → 11):
   - `releaseBoilerplate()` now rejects packaging-field sentences (the exact "All packaging fields (bin, scripts, files...) remain unchanged" response that shipped from the canary).
   - `gatherReleaseEvidence()` sends each window member's **own source hunks** to both the technical writer and the plain-English pass (no extra model calls), so a sparse window no longer invites invented reliability/configuration claims; unavailable member source is labeled as a gap instead of filled in.
   - Rejected/flagged member prose still stays out of the window, but its underlying change now reaches the model as source evidence rather than being dropped entirely.
   - The plain-English roll-up no longer commands "MUST name the actual features" on sparse evidence (that instruction is what forced the invented benefits); it must state the evidence gap instead. Marketing regex now covers "more reliable/consistent".
3. **Completion is measurable** (`generationState()` in `quality.mjs`): an entry is `missing` / `review-pending` / `needs-repair` / `legacy-unreviewed` / `complete` only when both artifacts exist with exact-text passing verdicts, complete evidence and no unresolved objections. `regen-last` now prints per-row states and exits non-zero if any named row is not fully generated, so a partial batch can no longer report success.

## Boundaries and next decision

- No new regeneration batch has been dispatched in this phase; no commit, push or deploy has been made for the fixes above.
- Do not broaden regeneration automatically to historical entries or label missing text as verified. The provider's ~10–19 s 504 deadline is the binding constraint: more calls on the same route will keep failing until routing/timeout at the provider is fixed or an alternate model route is approved.
- Filling older missing explanations and rewriting thin legacy release prose remains a separate explicit scope decision.
