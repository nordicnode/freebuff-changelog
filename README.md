# Freebuff Changelog

Unofficial changelog generator and static site for [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff).

Upstream commits are squashed into opaque `Sync public snapshot` commits with no release notes. This tool reconstructs an accurate changelog directly from the **git diff behind every public commit**.

## Quickstart

Requires **Node.js ≥ 20.11** (zero npm dependencies).

```bash
npm run build     # Build static site to dist/
npm run preview   # Serve locally at http://localhost:8788
npm test          # Run test suite
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

## Configuration

Set via environment variables:

| Variable | Default | Description |
|---|---|---|
| `CHANGELOG_LLM` | `0` | Enable AI enrichment (`1`) |
| `LLM_API_KEY` | — | OpenAI-compatible API key |
| `LLM_MODEL` | — | Model identifier (e.g. `gpt-4o-mini`) |
| `LLM_API_BASE` | `https://api.openai.com/v1` | API endpoint URL |
| `CHANGELOG_LLM_LIMIT` | `60` | Max commits summarized per run |
| `CHANGELOG_ELI5` | `1` | Enable plain-English explanations |
| `SITE_URL` | — | Base URL for RSS and sitemaps |

## Deployment

Deploy `dist/` to **Cloudflare Pages**:
- **Build command**: `node generator/cli.mjs build`
- **Output directory**: `dist`
- Run continuous updates via `npm run backfill --push` (systemd) or GitHub Actions (`.github/workflows/changelog-sync.yml`).
