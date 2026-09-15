# Freebuff Changelog - unofficial changelog generator + static site

Tracks what actually ships in [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff),
a project whose public repo is a **mirror**: a bot pushes opaque
`Sync public snapshot from freebuff-private` commits, so the community sees no
changelog, no release notes, and no commit messages.

This project reconstructs an accurate changelog from the one source of truth
that remains: **the diff behind every public commit**.

## How it works

```
github.com/CodebuffAI/freebuff (fetched by the local sync loop; Actions backstop)
        │  git clone / fetch
        ▼
generator/cli.mjs generate
  ├─ segment history: sync-snapshot commits vs. community commits
  ├─ diff parent..commit per snapshot (avg 1–4 files → one focused change)
  ├─ rule extractors:
  │    • README model-table ±rows        → model lineup added/retired/replaced
  │    • cli/release/package.json ±ver   → release marker (v1.0.NNN)
  │    • slash-command registry diffs    → new/removed commands
  │    • file added/removed/renamed      → structural changes
  │    • inline rationale comments       → verbatim facts (Freebuff devs document heavily)
  ├─ classify: category, areas, significance, noise skip (lock-only/test-only)
  └─ optional LLM rewrite (env-gated, per-commit cached forever, diff-grounded;
     every non-churn entry, community commits included)
        ▼
data/changelog.json (+ state.json, ai-summaries.json)  ← committed to git
        ▼
generator/cli.mjs build  →  dist/  (static site → Cloudflare Pages)
```

* **Sync ownership.** A long-running loop (`npm run backfill`, systemd
  `freebuff-backfill.service`) is the primary syncer: each cycle re-analyzes
  upstream when the SHA moved *or* when `generatedAt` fell past
  `CHANGELOG_SYNC_STALE_MIN` (default 45), then runs one LLM backfill batch.
  Those two fields are the only inputs to the site's `[stale Nm]` counter, so
  freshness never waits on the Actions schedule — which drifts badly in practice
  (`0 * * * *` observed firing at 00:33, 05:35 and 11:21).
  `.github/workflows/changelog-sync.yml` remains the backstop for when that box
  is offline.
* Both writers share one publish path (`cli.mjs push-data`), and every write to
  `data/changelog.json` / `data/ai-summaries.json` is **merged, never
  overwritten**: the newer `generatedAt` wins the scalars, entries are unioned by
  SHA, and each side keeps the summaries it produced. A cycle holds a snapshot in
  memory across minutes of LLM calls, so overwriting would push a stale `headSha`
  back onto origin — the exact shape behind a site reading `[stale 184m]` while
  git kept receiving commits.
* `build` renders a **fully static site**: one inline stylesheet, zero client JS
  except the search page, system fonts, pre-rendered day/release/archive pages,
  RSS, sitemap, JSON API, `_headers` for content types, CORS and a site-wide
  `no-cache` policy (caching removed; browsers revalidate every request).
* Incremental + idempotent: state tracks the last analyzed SHA; rewritten
  upstream history triggers a safe full rescan; AI summaries are keyed by
  SHA+patch-hash so each commit is summarized at most once, ever.
* **Every commit is listed.** Nothing is dropped: a `bun.lock`-only sync is a
  commit the repository received, and 1,877 of them (30% of recent history) used
  to be invisible, which made the site look behind upstream. Churn rows carry
  `noise: true` + `churn: 'lockfile' | 'assets' | 'merge'` and the names of the
  files that were filtered out of the source diff, so they can state what
  actually changed. They are dimmed in the timeline and excluded from feeds,
  search, stats, the "changes" counts and the LLM queue — there is nothing for a
  model to describe (their diff is still stored; see below). Test-only commits are
  *not* churn: real work landed, so
  they get a row, a category and a summary like any other entry.
* An entry is complete where it is listed: index rows render the same full body
  as day pages (files, facts, meta links), so reading one never needs a second
  page. Every entry also has its diff on disk. `data/diffs/<sha>.diff` is
  generated for community commits and churn rows as well as snapshots — a churn
  row stores the *unstripped* diff, because the lockfile is its whole change —
  and retention follows the entry list: `pruneDiffs` deletes a file only when no
  entry references it. Age-based retention is what used to leave 58 rows
  advertising a diff that had been deleted, and a toggle that fetches a 404 is
  worse than the GitHub compare link beside it. The only rows without a toggle
  are the handful whose commit is genuinely empty (a net-zero merge).
* The front page filters: a chip per category present on the page, one toggle for
  churn, state kept in `localStorage`. Filtering is a visibility flip over rows
  that are already in the document, so it costs no request and no backend. **Churn
  is hidden on the server** (`<details … hidden>`), not by script — a default has
  to hold for readers with JavaScript off, and only the categories actually on the
  page get a chip, so no chip can filter the page down to nothing. A day whose rows
  are all filtered out hides its own header, and a `#sha` permalink into a
  filtered-out row reveals that row rather than landing on blank space.
* The timeline paginates **one day per page**: `/` is the newest day,
  `/day/2026-09-13/` is that same day at its permalink, and older days walk back
  721 pages to the first entry. A page *is* a date, so the heading on screen, the
  URL, the pager and a link someone shared cannot disagree, and no page splits a
  day in half. Chips count the day they sit on while `data-total` carries the
  all-time figure, and filter state is shared, so walking back keeps the reader's
  selection instead of snapping to the default. The live chrome — HEAD plus the
  sync countdown — belongs to the newest day only: it is a claim about *now*, and
  the shell's reload-when-behind hook keys off the same element, so a settled day
  prints the exact stamp it was built from and carries no hook at all (an
  auto-refresh while someone reads July 2024 would yank the page out from under
  them). Every page also carries a jump-to-date select, because 721 days of one
  click at a time is not navigation.

## Freshness path (an upstream commit → a reader seeing it)

| step | latency | knob |
|---|---|---|
| loop notices the new SHA | ≤ `WATCH_INTERVAL` (30s) | systemd unit env |
| analyze + merge-safe write | ~10–40s | — |
| new rows published **before** the LLM batch | ~1s | `commitAndPushData` |
| Workers build on push | ~20–60s | Cloudflare |
| browser reuse of any page | none (`Cache-Control: no-cache`; revalidate, 304 when unchanged) | `_headers` |
| its summary replaces the deterministic one | next batch, ahead of the backlog | `CHANGELOG_LLM_LIMIT` |
| its plain-English line appears | same batch (own queue, no diff needed) | `CHANGELOG_ELI5_LIMIT` |

So a new commit is readable in roughly 2–3 minutes, and a long-open tab reloads
itself once per data version when it comes back from the background past its
budget. Summarization order: this cycle's commits, then model swaps, releases
and commands, then newest-first — and only `4 × limit` candidates are diffed per
run, so a deep backlog can neither slow a cycle nor starve the new commit.
Gateway blips park a commit for `CHANGELOG_LLM_TRANSIENT_RETRY_MS` (default 5
min) instead of re-consuming a call every cycle; hard failures keep the hour
cooldown.

## Commands

```bash
node generator/cli.mjs generate [--full]   # analyze upstream → data/
node generator/cli.mjs build               # data/ → dist/
node generator/cli.mjs preview [port]      # serve dist/ locally (default 8788)
```

No npm dependencies. Node ≥ 20.11.

## Optional AI layer

Deterministic analysis alone produces accurate entries. Setting these (repo
Variables/Secrets in Actions, or locally) enables an AI rewrite pass grounded
strictly in the diff text:

| env | meaning |
|---|---|
| `CHANGELOG_LLM=1` | enable |
| `LLM_API_BASE` | any OpenAI-compatible endpoint (default `https://api.openai.com/v1`) |
| `LLM_API_KEY` | key |
| `LLM_MODEL` | model name |
| `CHANGELOG_LLM_LIMIT` | max commits summarized per run (default 60; `0` = no cap) |
| `CHANGELOG_LLM_CONCURRENCY` | parallel API calls (default 5) |
| `CHANGELOG_LLM_ERROR_COOLDOWN_MS` | retry failed entries after this (default 3600000) |
| `CHANGELOG_ELI5_LIMIT` | plain-English lines per run (defaults to `CHANGELOG_LLM_LIMIT`) |
| `CHANGELOG_ELI5_CONCURRENCY` | parallel ELI5 calls (defaults to `CHANGELOG_LLM_CONCURRENCY`) |
| `CHANGELOG_ELI5=0` | disable the plain-English pass only, keep summaries |
| `CHANGELOG_LLM_CHURN=1` | also summarize lockfile/icon-only rows, from their raw diff (~1,900 extra calls) |

Priority order is user-visible first (models, releases, commands), then newest.
The prompt carries deterministic signals (category, files, stats, catalog and
command facts) so the model grounds in verifiable context; outputs are schema-
validated with one repair retry and 429 backoff. Prompt edits bump `PROMPT_V`
in `generator/lib/llm.mjs`, invalidating stale cache entries exactly once.

**The ELI5 pass** is a second, separate call per entry: 1-3 sentences of plain
English under the technical summary, for a reader who does not open code. It is
*not* extra fields in the summary prompt, because that would mean bumping
`PROMPT_V` and re-paying every summary that is already good, and because the
wording of a plain-English ask needs tuning without rewriting technical history.
So it has its own `ELI5_V`, its own keys in the same cache file
(`<sha>:eli5:v<N>:<hash>`), and its own budget. Its input is the finished summary
rather than the diff: no git work, no patch tokens, and the rules that matter
(hard jargon ban, no invented causes or numbers, no inflating small changes, and
a non-answer like "N/A" is rejected rather than cached as success) apply to text
rather than to raw code. It is keyed by the hash of the summary it explains, so a
re-summarized entry loses a stale line automatically, and `mergeChangelog` keeps
whichever side's line still matches the summary that survives the merge.

Every entry that gets a summary gets an ELI5, including brand-new commits: the
hourly pass runs over all entries rather than only the additions, and the loop's
drain sits outside the summary branch so a commit summarized in one pass is
explained in the same cycle.

**Full coverage is a command, not a hope.** `npm run enrich-all` (`--batch N`,
or `--batch 0` for everything left, plus `--push`) runs one pass: store any
missing diffs, spend N calls on summaries and N on plain-English lines, publish,
exit. It is resumable by construction — summaries are cached by SHA + prompt
version + diff hash, and a diff already on disk is never regenerated — so
looping it until a pass reports `0 summaries, 0 eli5` left drains the whole
history. One pass at a time is deliberate: the run holds the worktree lock, and
the gaps between passes are when the sync daemon gets to publish fresh upstream
commits.

AI-titled entries are badged `ai`. Without AI, or on API failure, the
rule-based summary is used: the site never depends on the LLM.

## Deploy on Cloudflare Pages (free)

1. Push this repo to GitHub.
2. Cloudflare Pages → connect repo → build command `node generator/cli.mjs build`,
   output dir `dist`.
3. Set the final URL as `SITE_URL` in the workflow env (for absolute links,
   RSS, sitemap) or edit `SITE.url` in `generator/lib/site.mjs`.
4. Enable Actions workflows (backstop), then run the sync loop — e.g. a user
   unit with `ExecStart=/usr/bin/node <repo>/generator/cli.mjs backfill --push`
   and `Restart=always`. Done: the site keeps itself fresh; the cron only covers
   the machine being offline.

## Site output

| route | content |
|---|---|
| `/` | the newest day in full: every entry pushed that UTC day (churn hidden by default), category chips, live HEAD + sync countdown |
| `/day/YYYY-MM-DD/` | one day of the timeline — the same full bodies and chips, one day per page; older/newer walk by date, and there is a jump-to-date select. `#sha` permalinks point here |
| `/release/1.0.NNN/` | entries since the previous version bump |
| `/archive/` | one list at a time — DAYS / RELEASES / CATEGORIES — each grouped into months that stay folded until opened (`<details>`, so no-JS gets the long version). `#releases`, `#categories` and `#days-m-YYYY-MM` deep-link into a view |
| `/changes/<category>/` | every change of one category, all time: compact rows, each linking to the full body on its day page (category tiles live on `/archive/#categories`; `/changes/` 301-redirects there) |
| `/search/` | client filter over pre-built JSON index |
| `/in-flight/` | every open upstream PR (the list endpoint is paginated), with diffstat + 120-line diff previews fetched a budgeted batch per run — `CHANGELOG_PR_CALLS`, default 25 unauthenticated (GitHub allows 60 calls/hr) or 500 when `GITHUB_TOKEN` is set, which finishes a list of 100+ PRs in one pass |
| `/feed.xml` | RSS of major + notable entries |
| `/feed-models.xml`, `/feed-releases.xml` | model-only / release-only RSS |
| `/models/` | model catalog timeline (live, retired, per-change history) |
| `/api/entries.json`, `/api/status.json` | raw data / deploy status API |

## Honest limitations

* Multiple private commits can be squashed into one public snapshot; entries
  describe the *net effect*, with commit + compare links to ground truth.
* Purely internal refactors show as area-level entries (they're real but less
  user-meaningful); lockfile/test-only snapshots are skipped.
* The pre–June 2026 history had real commit messages and is imported as-is
  (`kind: community`), including community PR references.
