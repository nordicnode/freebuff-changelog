# Freebuff Changelog

[![Version](https://changelog.freebuff.dev/badge/version.svg)](https://changelog.freebuff.dev)
[![Models](https://changelog.freebuff.dev/badge/models.svg)](https://changelog.freebuff.dev/models/)
[![Status](https://changelog.freebuff.dev/badge/status.svg)](https://changelog.freebuff.dev)
[![Changes](https://changelog.freebuff.dev/badge/changes.svg)](https://changelog.freebuff.dev/archive/)

Unofficial changelog generator and static site for [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff).

Upstream commits are squashed into opaque `Sync public snapshot` commits with no release notes. This tool reconstructs an accurate changelog directly from the **git diff behind every public commit**.

## Quickstart

Requires **Node.js ≥ 20.11** (zero npm dependencies).

```bash
npm run build     # Build static site to dist/
npm run preview   # Serve locally at http://localhost:8788
npm test          # Run test suite
npm run broadcast # Broadcast new commits to Discord webhook (--dry-run)
npm run generate  # Analyze upstream repo -> data/
npm run backfill  # Run continuous sync daemon (--push)
```

## How It Works

1. **Fetch & Diff**: Pulls upstream snapshots and diffs parent commits to isolate individual changes.
2. **Deterministic Extraction**: Extracts model lineup changes (README tables), version bumps (`package.json`), slash commands, and developer comments.
3. **Classification**: Categorizes by area and significance. Churn commits (lockfiles, assets) are dimmed in the UI rather than dropped.
4. **AI Enrichment (Optional)**: Adds technical summaries and ELI5 plain-English explanations, cached by SHA and diff hash.
5. **Static Generation**: Builds zero-JS, pre-rendered HTML/CSS to `dist/` with instant revalidation.

## Site & Feeds

- **Timeline**: Daily changelog views (`/day/YYYY-MM-DD/`), releases (`/release/1.0.NNN/`), model tracker (`/models/`), and live metrics (`/stats/`).
- **Feeds**: `/feed.xml` (all changes), `/feed-major.xml` (major only), `/feed-models.xml`, `/feed-releases.xml`, `/feed.json` (JSON Feed 1.1).
- **Discord**: Every entry includes one-click Discord markdown copy (≤ 2,000 chars). Feeds support MonitoRSS and webhooks natively.
- **Release roll-ups**: version-label rows (both the `1.0.x` CLI line and the `0.0.x` free-app line) explain the user-visible changes shipped since the previous bump of the same line, fed from the already-written titles and summaries in that window (up to 100 entries). Rows with an empty window keep the honest housekeeping line.
- **Story context**: Same-day entries linked by specific files or identifiers can show an access-change headline and cross-note beside their plain-English explanations. Notes are derived from explicit recorded evidence at build time and included in feeds and Discord exports; they do not rewrite cached summaries. Detection is conservative and does not cover every wording or cross-day story. ELI5 prompt v4 also preserves evidence-backed eligibility changes and effective dates; existing explanations refresh through the normal enrichment budget.
- **Keyboard Navigation**: Vim-style shortcuts (`j`/`k`, `o`, `d`, `c`, `n`/`p`, `/`, and `?` for cheat sheet).

## Configuration

Set via environment variables:

| Variable | Default | Description |
|---|---|---|
| `CHANGELOG_LLM` | `0` | Enable AI enrichment (`1`) |
| `LLM_API_KEY` | — | OpenAI-compatible API key |
| `LLM_MODEL` | — | Model identifier (e.g. `gpt-4o-mini`) |
| `LLM_API_BASE` | `https://api.openai.com/v1` | API endpoint URL |
| `LLM_TIMEOUT_MS` | `60000` | Per-request timeout in milliseconds, including response-body reads, for summaries and ELI5. Set `300000` for slow models (5 minutes per attempt). Invalid values fall back to the default. |
| `CHANGELOG_LLM_LIMIT` | `60` | Max commits summarized per run |
| `CHANGELOG_ELI5` | `1` | Enable plain-English explanations |
| `SITE_URL` | — | Base URL for RSS and sitemaps |

## Deployment

Deploy `dist/` to **Cloudflare Pages**:
- **Build command**: `node generator/cli.mjs build`
- **Output directory**: `dist`
- Run continuous updates via `npm run backfill --push` (systemd) or GitHub Actions (`.github/workflows/changelog-sync.yml`).
