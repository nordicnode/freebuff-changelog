# LLM Configuration

## Current setup

| Setting | Value | Where |
|---|---|---|
| Provider base | `https://vyceai.com/v1` | repository secret `LLM_API_BASE`; the code/workflow literal is the same value |
| Writer model | `deepseek-v4.1` | repository secret `LLM_MODEL` |
| Key ring | supported but unused in CI | `LLM_API_KEYS` (comma-separated, rotated one per call). The Google keys are free tier — **20 requests/day per key** — so they sit on the backup route instead |
| Backup route | `gemini-3.6-flash` at `https://generativelanguage.googleapis.com/v1beta` | `LLM_BACKUP_*` secrets, used once when the primary route itself fails. Free tier: a rescue for a few calls, not a workload |
| Verifier model | `deepseek-v4.1` | `CHANGELOG_LLM_VERIFY=0` disables the pass in the relay, retry and regen steps |
| Rate limit | 40 requests/minute | module cap (`LLM_PROVIDER_RPM`) and workflow default |
| Streaming | on | `stream: true` on every request; `CHANGELOG_LLM_STREAM=0` disables |
| Cycle paid window | 300,000 ms | `CHANGELOG_LLM_CYCLE_BUDGET_MS` |
| Row budget | 90,000 ms (45,000 ms for plain-English) | `CHANGELOG_LLM_ROW_BUDGET_MS`, `CHANGELOG_ELI5_ROW_BUDGET_MS` |

Repository settings (`nordicnode/freebuff-changelog`): secrets `LLM_API_KEY`,
`LLM_API_KEYS`, `LLM_API_BASE`, `LLM_MODEL`, `LLM_VERIFY_MODEL`, optional
`LLM_MODEL_MAJOR` and `LLM_BACKUP_*`; variables `CHANGELOG_LLM`,
`CHANGELOG_LLM_LIMIT`. The operational identity lives here: the literals in the
code and workflow are only the floor. **Set the values
in repository settings, never in this file** — this repository is public, and an
API key committed here is a key published to the world (and still readable in
history after removal). A key that has ever been committed must be rotated at
the provider.

Every paid run logs the identity it is using, once, with no secret in it:

```
LLM provider: write deepseek-v4.1 @ https://vyceai.com/v1, verify deepseek-v4.1, backup gemini-3.6-flash @ https://generativelanguage.googleapis.com/v1beta
```

With more than one key in `LLM_API_KEYS`, requests rotate through them one per
call (round-robin) while the rolling 40 requests/minute window stays global:
more keys share the load, they do not raise the cap. The key-ring code is in
place for a paid multi-key provider; the Google keys measured here answered
`429 Quota exceeded ... generate_content_free_tier_requests, limit: 20` — a
daily allowance, not a per-minute one — so Google cannot be the primary until
billing is enabled on those keys. VyceAI answered a 40 KB prompt in ~2.1s at
the same time Google was refusing every call.

## Why the shape is what it is (measured 2026-10-02, not assumed)

- **Non-streaming times out.** One real row's exact production body (43,010
  chars of prompt asking for a ~2.6 KB JSON answer): non-streaming answered HTTP
  504 "Gateway time-out" in 11.4s; the same bytes with `stream: true` answered
  HTTP 200 in 0.3s with the complete answer. Neutral prompts of 300,000 chars
  answered in under 4s, so it is neither size nor content — the gateway gives its
  origin about twelve seconds on the non-streaming path, and a changelog answer
  that needs longer is cut off. Every verbatim re-send of the same non-streaming
  ask hit it again, which is why 134 `LLM HTTP 504` stubs sat in the cache and
  rows could not be generated however often they were retried.
- **A timeout can arrive as HTTP 200.** With streaming, the gateway sometimes
  answers `200` and then a single frame
  `{"error":{"message":"The request timed out. Please try again.","code":"timeout"}}`.
  That is a transport failure with no answer, and it is now classified as one:
  the row takes the lean ask, then the failover route — never the "your reply was
  malformed" repair, which re-sends the same full ask and times out identically.
- **A 5xx costs ~12s.** Three verbatim retries plus 2s/4s/8s backoff spent ~62s
  of a row's budget re-asking the same bytes and left nothing for the rung that
  could change the answer or for the failover. One verbatim retry, then the lean
  ask, then the failover.
- **The 40 RPM limit is the provider's, not a preference.** The old 60 (both
  configured and hardcoded) meant the relay asked for more than the plan allows
  and spent row budgets on 429 waits.

## Time budgeting

```
git/network phase ─ 240s ─┐
                          ├─ sync, PR refresh, first publish (own clock)
paid window ── 300s ──────┘
  summary pass: window minus the plain-English reserve (share of the window,
                capped at 35%; no reserve when nothing is pending)
  plain-English pass: whatever the summary pass left
  PR previews: their own small slice
```

Each pass plans its queue from the window and the row budget
(`planLlmPass`): rows = `floor(window / rowBudget) * workers`, capped by the
configured limit. A window shorter than one row is skipped and **said so** — a
pass started on guaranteed-dead calls is what produced the 254 deadline stubs.
The `CHANGELOG_LLM_RPM_WARMUP=1` quiet minute is spent before any pass deadline
is armed; charged to a pass it used to kill that pass outright.

## Verifier: off in the relay (operator decision, 2026-10-02)

The semantic verifier was the most expensive and least reliable stage of the
forward pass (one ask ~23s; two of three probed asks returned a gateway timeout
frame), and its failures shipped rows as "Automated review is pending" after
spending two-thirds of the row's budget. `CHANGELOG_LLM_VERIFY=0` sets it aside
so the request budget goes to rows that have no text at all.

What that means, stated plainly: **new rows carry no verdict.** They are not
marked verified, they cannot claim to be, and the site/API say so. Rows that
already carry a verdict keep it. Turning it back on is a repository variable
(`CHANGELOG_LLM_VERIFY=all`), not a code change.

## Failure handling

- **Transient** (5xx, connection, timeout, HTTP 200 error frame, 408, exhausted
  429): one verbatim retry, then the lean ask, then the backup route once.
- **Content** (refusal, memory answer, malformed JSON, schema/grounding): the
  materially different ask — comments stripped, or wide evidence dropped —
  chosen by the failure, not by a fixed order.
- **Our own budgets** (cycle deadline, entry time/request budget): the row keeps
  the short cooldown and is retried next cycle. It is never parked for a call
  nobody answered.
- **Parked for good**: only a deterministic refusal/memory answer, or a real
  permanent HTTP error, after its attempts. A prompt-version bump releases it.

## Monitoring

- `LLM provider: …` — what the run is talking to (first line of each paid cycle).
- `[enrichment] summary pass: up to N row(s) in Ms (Xs per row)` — the plan; a
  skipped pass states its reason.
- `LLM health watch: …` — daily drift ledger (`data/llm-health.json`).
- `LLM: N entries written in M API calls` — spend vs output for the run.
