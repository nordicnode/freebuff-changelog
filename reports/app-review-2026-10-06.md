# Comprehensive app review — 2026-10-06

Scope: the whole product — ingestion/generation pipeline, the static site it
builds, the Cloudflare Worker on top, CI, and the data it accumulates.
Reviewed at `d6fba65f` (working tree clean, level with `origin/main`).

Method: read the app end to end (`worker.js`, `generator/cli.mjs`,
`generator/lib/*.mjs`, workflows), then measured the real artifacts on disk
(`dist/` 15,736 files, `data/` shards, gzip sizes of the pages a reader actually
downloads) rather than reasoning about them from source. No LLM calls were made.

Baseline checks at review time: `npm test` 536 pass + 1 opt-in slow test, `npm run build` green.

---

## Status: what was addressed on 2026-10-06

Everything below was implemented and verified the same day. The sections that
follow are the review as written; this table is what happened to each finding.

Verification after the work: `npm test` **559 pass / 1 skipped / 0 fail** (up 23),
`npm run build` green, `node generator/cli.mjs check-dist` green, and the Worker
gate exercised end to end against a real `preview` server.

| # | Finding | Outcome |
|---|---|---|
| 1 | Stored XSS in the in-flight commit/comment renderers | **Fixed.** Both lists now go through a local `escInFlight()` before `innerHTML`, plus a regression test. |
| 2 | The static-asset cap, unmeasured | **Fixed.** `retention.mjs` + `distbudget.mjs`; `check-dist` fails CI and the deploy; `dist/` went 15,736 → **14,933 files** and is now bounded by construction (verified: 2 simulated years at 80 entries/day still project inside the budget). |
| 3 | `POST /api/ask` open to non-browser clients | **Fixed.** A request with neither `Origin` nor `Sec-Fetch-Site` is refused 403 (it used to reach the model). A latent bug this exposed in the preview — a synthetic `http://localhost` that dropped the port, so no matching `Origin` could ever pass — was fixed too. |
| 4 | No CSP | **Fixed.** `Content-Security-Policy` plus `X-Frame-Options: DENY` in the generated `_headers`. |
| 5 | No ask-usage observability | **Partial.** `GET /api/ask` now reports per-isolate counters (asked / cache hits / refused / not configured / rate limited / errors). Durable totals need a KV binding, which this Worker does not have; the counters are documented as a floor, not a total. |
| 6 | 4.7 MB search index fetched on load | **Fixed.** The index now loads on first interest (keystroke, filter, chip, or pointer), with the deep-link path still eager and a real catch that reports a failed fetch instead of leaving the page blank. |
| 7 | `/in-flight/` calls GitHub from each reader's browser | **Partial.** The untrusted-HTML path is closed by the escaping above, and the server-rendered `commitsList`/`commentsList` path (already escaped) is unchanged. The live fallback remains for the PRs whose lists the sync run did not capture — removing it needs a wider capture budget, which is a separate decision. |
| 8 | Big-day page weight | Not done (improvement, not a fire). |
| 9 | Thin eval signal | Not done (policy and scope: the golden set needs human verification). |
| 10 | PR-list staleness has no cause signal | Not done. |
| 11 | `escapeHtml` ignores `'` | **Fixed**, with a test. |
| 12 | `loadDayRecords` linear scan | Not done: the lookup is a two-way prefix match, which a `Map` cannot express. |
| 13 | 7.8 MB single diff asset | Not done: it is within the 25 MiB per-asset cap and now the largest asset in `dist/`. |
| 14 | `scripts/**` and tests not syntax-checked | **Fixed.** Both are in the CI `node --check` sweep (verified clean first). |
| 15 | No lint/format config | Not done, deliberately: it adds a dev toolchain to a repo whose zero-dependency posture is a stated feature. A decision for the owner, not a bug. |
| 16 | Range view's 400 sequential fetches | Not done. |
| 17 | `.git` at 944 MB | Not done: retention bounds what the *site ships*; repository history is a separate policy. |

---

## Where the app is strong

Worth saying before the list: this is an unusually careful codebase.

- **Budgets everywhere.** Row/cycle wall clocks, RPM ceilings, prompt sizing
  against the row's own clock, `LLM_DEADLINE_AT`, per-entry call caps.
- **A real trust boundary.** Diff text, PR text and prior summaries are labelled
  untrusted data; the schema gate rejects ungrounded identifiers; the Ask
  endpoint re-checks every claim against the stored diff and refuses on a second
  failure (`422`, text never returned).
- **Atomic, mergeable persistence.** `writeAtomic` via rename, content-addressed
  LLM keys, a sharded changelog store, evidence spilled to `data/evidence/`, and
  a union-merge that survives two writers.
- **Honest degradation.** Missing secret → one control disables itself; missing
  evidence → no Ask button; a partial diff → a pending note instead of a claim.
- **Disclosure discipline.** The `quality` record distinguishes
  "not yet generated" from "predates the policy" from "review pending".

The findings below are mostly about the *edges* of that care: the browser side,
the deploy envelope, and the cost surface.

---

## P0 — fix now

### 1. Stored XSS: unescaped GitHub text injected into `innerHTML` (in-flight PR cards)

`generator/lib/site.mjs` renders the in-flight page's lazy-loaded commit and
comment lists by string-concatenating API fields straight into `innerHTML`:

- commits, [site.mjs:4486-4497](generator/lib/site.mjs#L4486-L4497) — `msg`
  (`c.commit.message`), `author` (`c.commit.author.name`) and `url`
  (`c.html_url`) are interpolated unescaped.
- comments, [site.mjs:4506-4516](generator/lib/site.mjs#L4506-L4516) — escapes
  `<`/`>` only (not `&`), and leaves `author` and `html_url` unescaped.

Confirmed shipping: `dist/in-flight/index.html` contains
`pr-commit-msg">' + msg`. **And the same file contradicts itself one code path
over** — the server-rendered PR card escapes the identical field at
[site.mjs:4335](generator/lib/site.mjs#L4335) (`esc(c.message)`). The diff viewer
was fixed for exactly this bug and carries a test
("diff viewer escapes file paths and labels before innerHTML"); the in-flight
loader was missed.

Why it matters: `CodebuffAI/freebuff` is a public repo that accepts community
PRs, and this site exists to report them. Any commit whose subject contains
markup executes in the changelog's own origin for every reader who expands the
commits section. That origin also serves `POST /api/ask`, so injected script can
spend the Worker's model credential and rewrite the page. There is no CSP to
blunt it (finding 4).

Fix: run both lists through the existing `esc`/`htmlEsc` helper (and escape
`&` in the comment path), then add a site test mirroring the diff-viewer one.
Add a CSP as defence in depth.

### 2. The static-asset file count will hit Cloudflare's cap, and nothing measures it

| | |
|---|---|
| `dist/` today | **15,736 files**, 637 MB |
| of which `dist/diffs/` | 10,899 |
| Workers static assets per version | **20,000** (Free) / 100,000 (Paid) |
| Recent ingestion | **80.4 entries/day** (last 10 day shards) |
| New dist files/day | ≈ 80–85 (one `.diff` per entry, plus day/frag/og churn) |
| Headroom at the Free cap | **≈ 53 days** |

Nothing checks this. [`sizebudget.mjs`](generator/lib/sizebudget.mjs#L10) and
`assertDataSizeBudget` guard *individual tracked data files* against GitHub's
100 MiB push limit; there is no count or total-size check on `dist/`, in CI or
in the deploy step. When the cap is reached `wrangler deploy` fails and the site
simply stops updating — and the repo-side gates (freshness, generation health)
will still be green, because ingestion is fine. The failure mode is "everything
green, nothing published".

Fix, in order: (a) a `check-dist` gate in `generator-check` and before upload in
`deploy.yml` that fails loudly at, say, 90% of the cap; (b) decide the plan —
Workers Paid raises the cap 5×; (c) the real fix is to stop shipping one file
per entry: bundle diffs into per-month/per-release chunks (the worker already
does SHA→day indirection via `api/sha-day.json`, so a bundle pointer is a small
change), or move diffs to R2/KV and keep the asset set for pages only.

---

## P1 — high value, small surface

### 3. `POST /api/ask` is unauthenticated to any non-browser client

[worker.js:206-212](worker.js#L206-L212):

```js
const origin = request.headers.get('origin')
if (origin) { /* same-host check, 403 otherwise */ }
```

The check is skipped entirely when the header is absent, which is the normal
case for `curl` and every server-side script. The README describes the endpoint
as "same-origin only", and the comment reasons that "a naive script does not
[set this header]" — as written, that is what lets it through. Combined with a
per-isolate, best-effort RPM limit, the paid endpoint is effectively open to
anyone who finds the URL.

The ask tests cover the cross-origin rejection
([ask.test.mjs:380](generator/test/ask.test.mjs#L380)) but not the absent-header
path.

Fix: require proof of a browser context (`Origin` **or**
`Sec-Fetch-Site: same-origin` present and matching), and consider a durable
limiter (KV / Durable Object) or a Turnstile token if the endpoint is ever
noticed. Do at least one of these before promoting the site anywhere public.

### 4. No CSP anywhere in `_headers`

[site.mjs:4860](generator/lib/site.mjs#L4860) ships `X-Content-Type-Options`,
`Referrer-Policy` and site-wide `no-cache`; there is no
`Content-Security-Policy`. The site already satisfies a strict policy almost for
free — no external scripts, no CDN, all CSS/JS inline or self-hosted — so a
policy like `default-src 'self'; script-src 'self' 'unsafe-inline'; object-src
'none'; base-uri 'none'; frame-ancestors 'none'` would cost nothing and would
have turned finding 1 from "arbitrary script execution" into "a blocked
inline handler in the console". Also worth adding `X-Frame-Options`/
`frame-ancestors` (the upstream project itself shipped that fix once).

### 5. No ask-usage observability

Nothing records asks — count, tokens, refusals, or cost. `console.error` on a
gateway 429 is the only trace, and Workers logs are only visible to whoever is
tail-ing. `/api/status.json` reports generation health in admirable detail but
says nothing about the one feature that spends money per request. There is
already traffic accounting (`data/traffic.json`, 41,801 views / 3,923 uniques),
so the shape exists; asks should get the same treatment (a counter in the
Worker, surfaced in status), which also makes finding 3 measurable.

---

## P2 — worth doing, larger

### 6. `/search/` downloads and main-thread-parses a 4.7 MB index on first visit

`dist/search-index.json` is **4,742,377 bytes raw / 1,451,916 gzipped**, 8,084
rows, built in one file at [site.mjs:3701](generator/lib/site.mjs#L3701) and
fetched on page load — not on first keystroke. IndexedDB makes repeats cheap, but
every first-time visitor on a phone pays ~1.4 MB and a multi-MB JSON parse before
typing anything, and it doubles as entries double.

Options, cheapest first: defer `loadIndex()` to the first `input` event; shard
the index by month (or by first letter) behind a small manifest, the way
`entry-frags/` already shards cards; move the parse into a Web Worker. The index
also duplicates text already in `/entry-frags/`.

### 7. `/in-flight/` fetches GitHub from each reader's browser

[site.mjs:4481-4506](generator/lib/site.mjs#L4481-L4506) calls
`api.github.com/.../pulls/<n>/commits` and `/issues/<n>/comments`
unauthenticated: 60 requests/hour **per reader IP**, no token, and a third-party
request from every reader's address. Most readers will simply see "Could not
load live from GitHub", and it is the surface for finding 1.

The repo already stores `data/pr-diffs/<n>.diff` and `data/pr-summaries.json`
and has a sync cycle that decorates PRs. Capturing the commit list and a comment
preview at sync time would make the page self-contained: no third-party fetch,
no untrusted HTML path, works for offline/rate-limited readers, and fewer moving
parts in the browser. This deletes finding 1 rather than patching it.

### 8. Page weight on the biggest days

Measured (raw / gzipped): day page 2026-10-05 **944 KB / 112 KB**; home
**609 KB / 78 KB**; `entry-frags/2026-10-05.json` **838 KB / 78 KB**; about page
136 KB / 33 KB. Gzip carries most of it, so this is not urgent — but a 130-entry
day is a 900 KB document with no pagination, and the range view already proves
the site can assemble cards lazily. Consider paginating days past ~60 entries and
moving the shared inline JS/CSS into cached external files (the site pays
`no-cache` revalidation on every page today, so inlining is a deliberate
trade-off worth re-examining as pages grow).

### 9. The eval signal is thin, and verification is off

`data/eval/golden.json` holds 40 rows, only 10 human-verified; the paid/judge
replay paths are disabled by the no-backfill policy, so `eval-weekly` is an
offline stored-artifact audit. Meanwhile `/api/status.json` reports
`needsRepair: 49`, `reviewPending: 182`, `admitted: 231` — numbers that can no
longer drain while verification is off. The disclosure wording handles this
honestly, but **quality is currently unmeasured**, and the grounding gate (the
one mechanism that *is* testable offline) has no published precision/recall.

Concrete, policy-safe improvement: grow the human-verified golden set with rows
that already have published text (reading and scoring shipped text is not
backfill), and report the grounding gate's precision/recall on it in
`/api/status.json` and the weekly eval.

### 10. `openPrsCheckedMinAgo: 52` against a "refreshes every few minutes" promise

The live status shows the open-PR list 52 minutes old. The page does disclose
it (amber text) and `/api/status.json` exposes it, which is good. What is missing
is a signal on the *cause*: PR fetching competes for the cycle budget
(`PR_CALL_BUDGET`, a 60 s deadline) and gets starved when ingestion is busy. Add
the PR-list age to the generation-health report so a starved pass is legible
rather than looking like a GitHub problem.

---

## P3 — small, real

11. **`escapeHtml` does not escape `'`** ([util.mjs:92](generator/lib/util.mjs#L92)).
    Safe today — I checked that no single-quoted attribute is built with it — but
    it is a latent trap for the next edit. Add `&#39;` and a test.
12. **`loadDayRecords` linear-scans ~11k keys per request**
    ([worker.js:170-180](worker.js#L170-L180)) with a 60 s cache, and two cold
    requests can both parse the same ~1 MB map. Fine now; a `Map` and a
    single-flight promise would be trivial.
13. **`dist/diffs/` ships raw stored diffs**, including one 7.8 MB file. The row
    that owns it needs the data, but a reader opening it downloads 7.8 MB. The
    pipeline already knows how to compact deletion-heavy diffs
    (`compactDeletions`); a display-oriented trimmed variant would help.
14. **`scripts/**` and `generator/test/**` are not syntax-checked** in
    `generator-check` (only `worker.js`, `cli.mjs`, `generator/lib/*.mjs`).
15. **No lint/format configuration at all** — no ESLint, Prettier, EditorConfig,
    or TS. CI's correctness gate is `node --check` (syntax only) plus tests.
    For 23,033 lines across 20 modules (`llm.mjs` 6,486, `site.mjs` 4,915,
    `style.mjs` 3,248) a formatter and a minimal lint config would be cheap
    insurance. It does not threaten the zero-runtime-dependency promise
    (`dependencies` stays empty); it only adds dev tooling.
16. **The range view issues up to 400 sequential fetches** by design
    ([site.mjs:2161](generator/lib/site.mjs#L2161)). Two or three in
    flight would be materially faster with the same politeness.
17. **`.git` is 944 MB** and grows ~80 entries/day across `diffs/` + `evidence/`.
    History compaction exists but is a read-only audit; worth deciding a policy
    before it becomes a checkout-time problem (the deploy workflow already pins
    `fetch-depth: 1` for this reason).

---

## Suggested sequence (as written at review time)

1. Escape the in-flight commit/comment renderers + a test (finding 1).
2. Add `check-dist` and fail CI/upload past a share of the asset cap (finding 2).
3. Require a same-origin signal on `POST /api/ask`, and add a CSP (findings 3, 4).
4. Count asks and surface them in `/api/status.json` (finding 5).
5. Move `/in-flight/` off the browser→GitHub fetch (finding 7) — this also
   retires finding 1's root cause.
6. Lazy/sharded search index (finding 6).

Findings 8–17 are improvements to schedule, not fires. Steps 1, 2, 3, 4 and 6
were completed the same day; step 5 is half done, for the reason in the table
above.
