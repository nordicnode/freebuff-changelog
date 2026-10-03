# Day roll-up: duplicate resolution + alternate-provider trial

2026-10-03. What changed, what was measured, and what the alternate provider did.

**Decision (2026-10-03): the alternate route is off.** Its `deepseek-v4.1-flash`
answered HTTP 503 on every call, so the `CHANGELOG_ROLLUP_LLM_*` values in
`.env` are commented out and the day roll-up runs on the primary route
(VyceAI) with the Google backup — the stage machinery stays in place, tested
and inert, for the day a second provider is worth trying again.

## The problem

A day digest can repeat a change twice, in two sentences that share almost no
words. Measured on 2026-09-29 (27 changes), the model wrote:

> Added in-flight sweep and per-project state files so a sponsored run that dies before a terminal report is marked failed.
> Added launch-time sweep recovery for sponsored runs that did not write a terminal report.

Four shared words in sixteen. The old check was exact-string equality, so both
shipped. Duplicates also arrive from the *input*: the same change is stored
twice (a cherry-pick, a revert of a revert, one upgrade split across two
commits), so the model is asked about it twice.

## What now stops a duplicate (four layers, in order)

| # | Layer | Catches | Cost |
|---|---|---|---|
| 1 | `digestibleMaterial` | duplicate rows in the day's material: same title on the same day, or title+summary that read as one change | 0 |
| 2 | prompt rule | "one bullet per change, and one change per bullet", with the change count in the material header | 0 |
| 3 | `validateRollupOut` | bullet pairs that are equal, contain one another, or share ≥75% of their words — after dropping stopwords, the mandated lead verb, and light stemming; numbers must agree | 0 |
| 4 | `dedupeBullets` | **paraphrases**: one small call reads the finished list as a reader would and returns the bullets to remove | 1 request / digest |

Layer 4 is strictly optional: if it fails (outage, refusal, bad reply) the
rule-based list ships, and `CHANGELOG_ROLLUP_DEDUPE=0` turns it off. An answer
that would empty the list is rejected by the validator.

## Measurements

**Layer 1 over the whole corpus** (742 days, 6,946 digestible rows):

- 6,942 rows after de-duplication: **4 rows collapsed, across 4 days, 0 false merges**.
- All four are verified same-title duplicates (`Windows PTY spawns cmd.exe outside PowerShell` + its revert-of-revert, `Upgrade OpenTUI to 0.2.2` split across two commits, `Remove runId parameter from startAgentRun`, `Privacy policy metadata date updated`).
- Deliberately *not* collapsed: the 39 same-day pairs whose titles merely overlap — e.g. `add cli login flow` and `Revert CLI login auth flow` are two changes.

**Prompt A/B** (primary provider, same three days, `reports/rollup-providers-*.md`):

| prompt | 2026-10-01 (22 changes) | 2026-09-30 (23) | 2026-09-29 (27, cap 24) |
|---|---|---|---|
| before v4 | 17 raw | 15 raw | **31 raw → 7 over the limit** |
| with v4 rules | 15 | 19–24 | 23–24, never over |

**Layer 4, live** (2026-09-29, primary provider): 23 raw → 15 after the rules →
**14 after the duplicate check**, in 3.4s. The bullet it dropped was a
paraphrase no word rule reaches:

> kept — Added GPT-6.1 Sol to the premium subscription model picker, free in the US and paid elsewhere, with a tooltip stating the one-session-per-day cap for every account.
> dropped — Added a per-account daily session cap of one session for GPT-6.1 Sol, so a second session is rejected once the day's un-refunded debits hit the limit.

It kept two genuinely different changes next to each other (removing the web
chat surface vs rewriting the house-ad copy), which is the failure mode of a
threshold that is set too low.

**Sample caveat:** on these three days the *raw* answers contained zero
word-level restatements under either prompt. The duplicate problem is
paraphrastic, which is why layer 4 exists rather than a lower threshold.

## Alternate provider trial (`CHANGELOG_ROLLUP_LLM_*` in `.env`, now disabled)

Configured as asked for the trial: `https://logfare.ai/v1`, `deepseek-v4.1-flash`,
plan 20 rpm / 500 per hour / 2,500 per day / 3 concurrent — all four enforced
(own rolling window keyed by base URL, own concurrency slots, no failover, and
only its own key ever sent to it).

**The configured model does not answer.** Every call returns HTTP 503
`Service temporarily unavailable`: 6 direct probes and 9 roll-up attempts
spread over ~25 minutes. The model id exists in `GET /v1/models`
(`tier: 2`, `requires_training_optin: true`), so the account, key and gateway
are fine — the upstream route for that model is what is down (or gated).

Everything else about the route is verified working:

- `logfare/auto` produced a real completion **through our exact request body** (strict JSON + streaming) — same code path, same budgets.
- `ling-3.0-flash-vl` rejects `response_format` with `"does not support feature: structured-outputs"`; the probe only recognised the words `response_format`/`json_object`, so the call (and both repairs) failed. The probe now matches that phrasing too and retries once without the field.
- `qwen-3.8-27b` 429s from its own upstream, `gemma-4-26b` is "at capacity", `logfare/auto` timed out twice against the 90s row budget and once returned non-JSON.

Two defects the trial surfaced in *our* code, both fixed:

1. A gateway error delivered **inside HTTP 200** was only classified as a transport failure when the message happened to contain the word `timeout`. A `server_error` or `rate_limit_error` frame fell through as a content failure — permanent cooldown, no failover, as if the model had answered badly. Every such frame is now a gateway error.
2. The strict-JSON probe only recognised one gateway's wording of "I don't support that field".

## Cost

A digest is now two requests (write + duplicate check), both on the stage
route: 2/day against 20 rpm and 500 per hour.

## How to run

```bash
node generator/cli.mjs rollups                 # report: what is pending
node generator/cli.mjs rollups --day 2026-09-30  # one day
node generator/cli.mjs rollups --backfill 10 --push
node scripts/compare-rollup-providers.mjs 3    # A/B report, nothing written to data/
node scripts/compare-rollup-providers.mjs 3 --legacy-prompt   # the old rules
```
