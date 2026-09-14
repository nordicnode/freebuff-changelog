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
  └─ optional LLM rewrite (env-gated, per-commit cached forever, diff-grounded)
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
  RSS, sitemap, JSON API, `_headers` for edge caching.
* Incremental + idempotent: state tracks the last analyzed SHA; rewritten
  upstream history triggers a safe full rescan; AI summaries are keyed by
  SHA+patch-hash so each commit is summarized at most once, ever.

## Freshness path (an upstream commit → a reader seeing it)

| step | latency | knob |
|---|---|---|
| loop notices the new SHA | ≤ `WATCH_INTERVAL` (30s) | systemd unit env |
| analyze + merge-safe write | ~10–40s | — |
| new rows published **before** the LLM batch | ~1s | `commitAndPushData` |
| Workers build on push | ~20–60s | Cloudflare |
| edge/browser TTL on `/`, `/day/*` | ≤ 60s (+`stale-while-revalidate`) | `_headers` |
| its summary replaces the deterministic one | next batch, ahead of the backlog | `CHANGELOG_LLM_LIMIT` |

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
| `CHANGELOG_LLM_LIMIT` | max commits summarized per run (default 60) |
| `CHANGELOG_LLM_CONCURRENCY` | parallel API calls (default 5) |
| `CHANGELOG_LLM_ERROR_COOLDOWN_MS` | retry failed entries after this (default 3600000) |

Priority order is user-visible first (models, releases, commands), then newest.
The prompt carries deterministic signals (category, files, stats, catalog and
command facts) so the model grounds in verifiable context; outputs are schema-
validated with one repair retry and 429 backoff. Prompt edits bump `PROMPT_V`
in `generator/lib/llm.mjs`, invalidating stale cache entries exactly once.

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
| `/` | latest ~150 changes grouped by day, hero stats |
| `/day/YYYY-MM-DD/` | every change pushed that UTC day |
| `/release/1.0.NNN/` | entries since the previous version bump |
| `/archive/` | every day, release, category |
| `/search/` | client filter over pre-built JSON index |
| `/in-flight/` | open community PRs (via GitHub API, best effort) |
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
