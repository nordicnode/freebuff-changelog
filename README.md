# Freebuff Changelog — unofficial changelog generator + static site

Tracks what actually ships in [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff),
a project whose public repo is a **mirror**: a bot pushes opaque
`Sync public snapshot from freebuff-private` commits, so the community sees no
changelog, no release notes, and no commit messages.

This project reconstructs an accurate changelog from the one source of truth
that remains: **the diff behind every public commit**.

## How it works

```
github.com/CodebuffAI/freebuff (hourly cron, zero secrets required)
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

* `generate` runs hourly in GitHub Actions (`.github/workflows/changelog-sync.yml`)
  and pushes updated `data/` back — that push triggers the Pages build.
* `build` renders a **fully static site**: one inline stylesheet, zero client JS
  except the search page, system fonts, pre-rendered day/release/archive pages,
  RSS, sitemap, JSON API, `_headers` for edge caching.
* Incremental + idempotent: state tracks the last analyzed SHA; rewritten
  upstream history triggers a safe full rescan; AI summaries are keyed by
  SHA+patch-hash so each commit is summarized at most once, ever.

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

AI-titled entries are badged `ai`. Without AI, or on API failure, the
rule-based summary is used — the site never depends on the LLM.

## Deploy on Cloudflare Pages (free)

1. Push this repo to GitHub.
2. Cloudflare Pages → connect repo → build command `node generator/cli.mjs build`,
   output dir `dist`.
3. Set the final URL as `SITE_URL` in the workflow env (for absolute links,
   RSS, sitemap) or edit `SITE.url` in `generator/lib/site.mjs`.
4. Enable Actions workflows. Done — site self-updates hourly.

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
| `/changelog.json`, `/api/entries.json` | raw data / API |

## Honest limitations

* Multiple private commits can be squashed into one public snapshot; entries
  describe the *net effect*, with commit + compare links to ground truth.
* Purely internal refactors show as area-level entries (they're real but less
  user-meaningful); lockfile/test-only snapshots are skipped.
* The pre–June 2026 history had real commit messages and is imported as-is
  (`kind: community`), including community PR references.
