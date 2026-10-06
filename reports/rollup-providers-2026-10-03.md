# Day roll-up: primary provider vs dedicated roll-up provider

> Consolidated 2026-10-06 from five same-afternoon experiment runs
> (16:11, 16:20, 16:22, 16:31, 16:33 UTC); the timestamped originals were
> superseded and removed. The dedicated roll-up route returned HTTP 503 on
> every call in all five runs -- see the decision in
> [rollup-dedupe-and-provider-trial.md](rollup-dedupe-and-provider-trial.md)
> (alternate route off).

Superseded v4-rule iterations (same three days; `raw` = answer before
de-duplication, `restated` = paraphrase repeats, `over` = bullets beyond
one per change):

| run | rollup route model | calls | failed | raw | restated | over | kept |
|---|---|---|---|---|---|---|---|
| 16:11 | `deepseek-v4.1-flash` @ `https://logfare.ai/v1` | 3 | 3 | 0 | 0 | 0 | 0 |
| 16:20 | `logfare/auto` @ `https://logfare.ai/v1` | 3 | 3 | 0 | 0 | 0 | 0 |
| 16:22 | `ling-3.0-flash-vl` @ `https://logfare.ai/v1` | 3 | 3 | 0 | 0 | 0 | 0 |

## Final v4-rule run (16:31)

Generated 2026-10-03T16:31:18.469Z over 2026-10-01, 2026-09-30, 2026-09-29.

`raw` is the answer before de-duplication; `restated` counts bullets that say the same change as an earlier bullet; `over` counts bullets beyond one per change. Production collapses both, so these numbers describe what each model *wanted* to ship.

| route | model @ provider | calls | failed | raw | restated | over | kept | changes |
|---|---|---|---|---|---|---|---|---|
| primary | `deepseek-v4.1` @ `https://vyceai.com/v1` | 3 | 1 | 42 | 0 | 0 | 39 | 72 |
| rollup | `deepseek-v4.1-flash` @ `https://logfare.ai/v1` | 3 | 3 | 0 | 0 | 0 | 0 | 72 |

## 2026-10-01

### primary (deepseek-v4.1)

FAILED: LLM gateway error in the response body (timeout): The request timed out. Please try again.; backup route: LLM HTTP 503


### rollup (deepseek-v4.1-flash)

FAILED: LLM gateway error in the response body (server_error): Service temporarily unavailable


## 2026-09-30

### primary (deepseek-v4.1)

- Added a /byok effort command to pick low, medium, or high reasoning effort for BYOK runs, persisted in settings and resolved at run start.
- Fixed file edits that would otherwise be saved cut off mid-generation, refusing truncated writes to avoid leaving broken files.
- Capped reasoning effort at high for GPT-6.1 Sol, Muse Spark, and Gemini 3.8 Flash, removing the deepest thinking level on those paid models.
- Kept the Freebucks discount reservation active on session end for multi-session CLI users, so closing one session no longer cancels a locked-in price.
- Sent the CLI terminal environment and input profile in ad and run metadata to distinguish real developer sessions from bot traffic.
- Treated caller aborts separately from idle timeouts in agent runtime and SDK runs, so manual stops log as cancellations.
- Resolved premium shared-pool quota for the CLI landing counter and session-ended banner instead of whichever quota served first.
- OpenAI-compatible streams now infer missing tool-call indexes instead of failing the whole chunk.
- Named missing environment variables in BYOK credential diagnostics while excluding key values.
- Repaired pasted line breaks in the /byok parser, joining unambiguous breaks in URLs, provider types, and model names.
- Reported endpoint HTTP status and warned on missing models during /byok add, validate, and select.
- Stopped daily limit refusals from falling back to another model, surfacing the server's available hours instead.
- Accepted an optional environment variable for new endpoints in /byok update after a changed base URL.
- Kept Up and Down paging prompt history after recalling an entry until the entry is edited or the cursor moves.
- Added a 'vercel' spend provider and introduced the server-driven Freebuff model catalog protocol.
- Moved the Freebuff auth token to the OS keychain at login, leaving plaintext storage behind.
- Updated /byok validation to report HTTP 404 base URLs, web pages at /models, timeouts, and connection refusals.

### rollup (deepseek-v4.1-flash)

FAILED: LLM gateway error in the response body (server_error): Service temporarily unavailable


## 2026-09-29

### primary (deepseek-v4.1)

- Added an optional note field to the Freebucks window and a notice explaining that VPN users get a smaller free pool and fewer models.
- Added GPT-6.1 Sol to subscription premium models and the CLI picker, free in the US and paid elsewhere.
- Added a per-account daily session cap of one for GPT-6.1 Sol across all plans.
- Added invoiced CPM value to placement totals so advertisers see frozen-CPM delivery value separately from click spend.
- Added default UTM tags to advertiser-facing links in sponsored-run procedures, leaving existing tags and code links untouched.
- Added source tags (user prompt, step prompt, tool) to ad request messages so the server can tell developer-typed input from runtime-synthesized input.
- Added a post-click return label in the CLI that records return as the latency from an ad click to the next submitted prompt.
- Split the combined Instagram, TikTok, Facebook referral chip into separate options while preserving the legacy id for read-time tallying.
- Added a residential-proxy-specific notice for household connections that look like a bandwidth-sharing app rather than a VPN.
- Fixed streak bonus copy that misled east-of-Pacific readers by claiming the credit sat in their wallet.
- Moved the streak bonus into the daily Freebucks allowance and updated the client to show when it lands and resets.
- Framed in-progress steering messages as mid-turn so models keep the running task instead of starting a new request.
- Added launch-time in-flight sweep and partial-edit undo so a sponsored run that dies before a terminal report is marked failed by the next CLI launch.
- Released an open head think tag as text when the model finishes the step, instead of swallowing the rest of the answer.
- Returned a state snapshot rather than the live session when local agent templates fail validation, preventing post-error writes from bleeding into persisted state.
- Added GPT-6.1 Sol promotional copy noting it is free in the US, paid elsewhere, capped at one session a day for every account.
- Pinned the Muse Spark OpenRouter lane to the meta endpoint with a price ceiling so traffic cannot shift to a cheaper or different host.
- Removed the Freebuff web chat surface from the house ad catalog and its fallback copy.
- Updated the Freebuff, Freebuff Chinese, and CLI READMEs to document Freebucks per-day metering instead of the legacy session system.
- Tightened release download origin to accept only https codebuff.com, freebuff.com, or loopback URLs with strict semver versions.
- Added a terminal text sanitizer and blocked steered or malformed release versions from rewriting paths or escaping directories.
- Removed the tier change notice from the Freebuff landing screen full-access branch.

### rollup (deepseek-v4.1-flash)

FAILED: LLM gateway error in the response body (server_error): Service temporarily unavailable



## Appendix: legacy-prompt variant (16:33)

Same three days with the v4 rules removed from the prompt.

Generated 2026-10-03T16:33:14.574Z over 2026-10-01, 2026-09-30, 2026-09-29 (legacy prompt: the rules added in v4 removed).

`raw` is the answer before de-duplication; `restated` counts bullets that say the same change as an earlier bullet under the v4 rule; `old` counts only exact-string repeats, which is what the validator before v4 would have let through; `over` counts bullets beyond one per change.

| route | model @ provider | calls | failed | raw | restated | old | over | kept | changes |
|---|---|---|---|---|---|---|---|---|---|
| primary | `deepseek-v4.1` @ `https://vyceai.com/v1` | 3 | 0 | 63 | 0 | 0 | 7 | 56 | 72 |

## 2026-10-01

### primary (deepseek-v4.1)

- Added identity-verification messaging on the Freebuff CLI landing screen for spend-limited sessions that require account verification.
- Added first-tab discount carryover to the Freebucks quote when switching AI models in the Freebuff CLI.
- Added MiMo 2.6 Flash as the default model across all Freebuff surfaces, replacing GLM 5.3 Flash.
- Added a to-do nudge that keeps a turn going instead of ending it when the assistant's task list is still partly unfinished.
- Added terminal output sanitization in the Freebuff CLI that strips escape sequences and treats bare carriage returns as progress-bar redraws.
- Removed Kimi K3 from the plan-metered Freebuff model catalog because its provider is retired.
- Added an 18-row terminal floor below which the Freebuff CLI landing screen no longer fetches ads.
- Added refusal of unreadable commands and deep credential redaction for sponsored local-execution command walks.
- Added connection pinning and per-redirect validation to the Freebuff SDK URL-reading tool to block private and reserved addresses.
- Kept landing ads enabled on the Freebuff CLI while simplifying the shared SDK fetch path and sponsored-run handling.
- Added adoption of completed deferred updates on the next Freebuff CLI launch when a terminal closes before installation.
- Added a BYOK connection method on the Freebuff SDK that reuses a saved endpoint and key with its own independent limits.
- Added a /todo slash command and a scrollable panel that shows the latest task list in the Freebuff terminal.
- Fixed the Freebuff CLI chat scroll so it no longer swallows mouse-wheel input at the bottom of the view.
- Added a sticky first-party model ad arm for eligible Tier-1 requests with independent telemetry.
- Added sorting of the Freebucks model picker so discounted ties are ordered by regular price.
- Updated the Freebuff privacy policy metadata date to October 1, 2026.

## 2026-09-30

### primary (deepseek-v4.1)

- Added a /byok effort command letting users pick low, medium, or high reasoning effort for BYOK runs, saved in settings and applied per provider dialect.
- Fixed file edits cut off mid-generation so the assistant refuses to save a broken file instead of applying an incomplete write.
- Changed the default reasoning effort to high for Muse Spark, GPT-6.1 Sol, and Gemini 3.8 Flash, turning down the deepest thinking level on those paid models.
- Improved the CLI to keep its discounted price reservation active when ending a session, so closing a terminal session no longer cancels the locked-in discount.
- Changed caller aborts to be treated as a true cancel instead of a timeout error, so manual stops no longer log a confusing idle message.
- Updated quota displays to resolve the shared premium pool instead of reading whichever quota the server serialized first.
- Added inference of missing tool-call indexes in OpenAI-compatible streams so omissions no longer fail the whole chunk.
- Updated BYOK credential diagnostics to name the missing environment variable while excluding key values.
- Fixed the CLI /byok parser to join unambiguous pasted line breaks inside arguments like URLs and model names.
- Added endpoint HTTP status reporting and a warning when an OpenAI-compatible model is absent from its /models listing during /byok add, validate, and select.
- Changed daily limit refusals to stop instead of falling back to another model, surfacing the server's available hours as the failure message.
- Updated /byok update to accept an optional environment variable for new endpoints and prompt for the existing credential name when the base URL changes.
- Improved prompt history arrows to keep paging recalled entries until the entry is edited or the cursor is moved.
- Added a vercel spend provider and introduced the server-driven Freebuff model catalog protocol.
- Moved the Freebuff auth token to the operating system keychain at login, keeping it out of plaintext files.

## 2026-09-29

### primary (deepseek-v4.1)

- VPN users now see a notice explaining more models and Freebucks are available on a direct connection.
- VPN and proxy users receive a smaller free Freebucks daily pool than direct connections.
- Each Freebuff Freebucks window can now carry an optional note explaining why the daily pool is this size.
- Sponsored run funnel metadata now records which client version (desktop or CLI) produced a run.
- A receiver schema rejects unknown funnel fields while widening failure codes so newer producers do not break older receivers.
- The release launcher now requires its app URL override to use https on approved hosts and strict semver versions before building a download path.
- A strict-terminal text sanitizer now rejects release versions that are not valid semver before any download URL is built.
- Dying sponsored runs are now marked failed by the next CLI launch, which reads leftover receipts from disk.
- Each sponsored run now keeps one file per project and one in-flight record per run for crash recovery.
- Referral source chips now split Instagram, TikTok, and Facebook into separate options instead of one combined chip.
- Residential proxy users now see a dedicated explanation naming their bandwidth-sharing app connection as the likely cause.
- Streak bonus copy now describes when the credit lands and the next due moment instead of claiming it sits in the wallet.
- Steering messages sent mid-run are now framed as additions to the current task instead of replacing it.
- A head think tag is now released as text when a model finishes its step but kept as thought when the step is cut off.
- Prompt errors now return a state snapshot instead of proceeding into the live session so post-error writes do not bleed into persisted state.
- A GPT-6.1 Sol model was added to the premium subscription model list.
- GPT-6.1 Sol is available free in the US and on paid plans elsewhere, capped at one session per day per account.
- GPT-6.1 Sol's picker tooltip now states it is free in the US, paid elsewhere, and capped at one session daily.
- A daily session cap of one per account was added for GPT-6.1 Sol across all plan types.
- The referral source picker no longer offers a combined Instagram, TikTok, and Facebook chip.
- Streak bonus funds now come from the daily Freebucks allowance rather than the wallet, with explicit expiration timing shown.
- Ad click return visits from the CLI are now measured as time from click to next submitted prompt.
- Ad request messages now carry source tags identifying user-typed input versus runtime-synthesized messages.
- The Freebuff web chat house ad surface was removed from the ad copy catalog.

