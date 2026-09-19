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

# Maintenance
node generator/cli.mjs enrich-all --batch 200 --rewrite-stale   # refresh rows summarized under an older prompt, major first
node generator/cli.mjs repair-entries [--push]                  # recompute commitNature / significance / security tag on stored rows
node generator/cli.mjs prune-cache [--push]                     # drop ai-summaries.json keys from retired prompt versions
node generator/cli.mjs glossary [--discover]                    # plain-English term definitions injected into prompts
node generator/cli.mjs eval --seed 40 && node generator/cli.mjs eval --judge   # summary-quality evaluation
```

## How It Works

1. **Fetch & Diff**: Pulls upstream snapshots and diffs parent commits to isolate individual changes.
2. **Deterministic Extraction**: Extracts model lineup changes (README tables), version bumps (`package.json`), slash commands, and developer comments.
3. **Classification**: Categorizes by area and significance. Churn commits (lockfiles, assets) are dimmed in the UI rather than dropped.
4. **AI Enrichment (Optional)**: Adds technical summaries and ELI5 plain-English explanations, cached by SHA and diff hash. Every summary carries an **evidence** citation, an **audience** (`end-users`, `advertisers`, `operators`, `maintainers`) and passes an **identifier-grounding check**: backticked names that do not appear in the diff or source context trigger one repair pass and are otherwise recorded as `ungrounded` and shown as unverified. Source context is tiered by diff size (a one-line change does not get four full files). Test-only and docs-only rows get a fixed plain-English line without an API call.
5. **Static Generation**: Builds zero-JS, pre-rendered HTML/CSS to `dist/` with instant revalidation.

### What the model is given

- **Structured facts** (`extractStructuredFacts`): constants whose value changed (`X: 300 -> 500`), environment variables newly read, CLI flags introduced, exports added/removed, and the titles of new tests (test hunks themselves stay out of the prompt). Extracted mechanically from the full stored diff, copied into the prompt verbatim, added to the grounding corpus, and rendered as chips on the card. `repair-entries` backfills them for stored rows.
- **PR context**: description and up to six review comments. Sync commits are squashes, so their PR is recovered by **file-set matching** against `data/merged-prs.json` (≥2 shared files, ≥60% of the PR's known files, within 14 days); matched PRs are marked `?` on the card and "likely, not certain" in the prompt.
- **Glossary** (`data/glossary.json`): plain-English meanings for internal terms, injected into both passes. `glossary --discover` adds candidate terms from upstream docs headings (empty definitions are never injected).
- **Multi-topic snapshots** (≥2 areas or ≥8 files) are asked for a per-topic `changes` list in addition to the prose summary.
- **Structured output**: `userVisible`, `breaking`, `migration`, `newEnvVars`, `newFlags`, `confidence`, `unknowns`. Lists are grounded like identifiers; `[BREAKING]` and `[LOW CONFIDENCE]` badges, an ACTION line and a NOT IN THE DIFF line render from them.
- **Diff ordering**: when the diff exceeds the budget, source files go first, then docs/config, then tests, then snapshots and generated files (smaller first within a tier).
- **Tiered models**: set `LLM_MODEL_MAJOR` to route major/notable rows, catalog and command changes, security-relevant rows, release roll-ups and multi-topic snapshots to a stronger model while `minor` stays on `LLM_MODEL`.

### Quality controls

- **Evaluation harness**: `eval --seed 40` writes `data/eval/golden.json` from recent rows (labels start as the current AI output, `verified: false` until a human checks them). `eval [--limit N] [--judge]` re-summarizes the golden rows on the current prompt into a scratch cache, scores grounding, path grounding, WHY rate, hype, title length, must-mention coverage, structured-fact use and (verified rows only) audience/significance agreement, optionally adds an LLM-as-judge rubric (`LLM_JUDGE_MODEL`), writes `data/eval/results/`, and prints a before/after table against the previous run.
- **Report link**: every card has a `report` link that opens a prefilled issue (`CHANGELOG_ISSUES_URL`); fixes land in `data/overrides.json`.
- **Gave-up rows** (AI title identical to the mechanical label) re-queue automatically.

- **Prompt versions**: `PROMPT_V` / `ELI5_V` / `RELEASE_ROLLUP_V` in `generator/lib/llm.mjs`. Bumping one re-summarizes affected rows once. Rows on an older prompt are left alone by the hourly sync; `enrich-all --rewrite-stale` refreshes them, heaviest first.
- **Anti-marketing**: release roll-ups and single rows are rejected (and repaired) when they contain hype ("smarter", "faster", "seamless", "together, these changes make...").
- **Second-model verifier** (optional): `CHANGELOG_LLM_VERIFY=1` asks `LLM_VERIFY_MODEL` to list claims the diff does not support for `major`/`notable` rows; one repair, then the row is stored with `verify: passed|flagged`.
- **Human overrides**: `data/overrides.json` (`{ "<sha or 12-char prefix>": { "title", "summary", "eli5", "significance", "evidence", "audience", "note" } }`) is applied at build time on every surface and survives re-summarization. Overridden rows show an `[EDITED]` badge.
- **/stats/ quality panel**: prompt-version coverage, evidence coverage, unverified identifiers, hype and preamble counts, audience split. Recomputed every build.
- **Deterministic weight**: a bump-only row is now `notable` (was `major`); `major` is reserved for model catalog changes and bumps that also ship code. Every weight carries a `significanceReason` shown in the badge tooltip. Stored rows keep their old weight until `repair-entries` is run once.

## Site & Feeds

- **Timeline**: Daily changelog views (`/day/YYYY-MM-DD/`), releases (`/release/1.0.NNN/`), model tracker (`/models/`), and live metrics (`/stats/`).
- **Feeds**: `/feed.xml` (all changes), `/feed-major.xml` (major only), `/feed-models.xml`, `/feed-releases.xml`, `/feed-security.xml` (trust, checksums, credentials, privacy), `/feed-weekly.xml` (one item a week), `/feed-<category>.xml` (e.g. `/feed-cli.xml`, `/feed-sdk.xml`), `/feed.json` (JSON Feed 1.1).
- **Weekly digests**: `/week/YYYY-Www/` lists a week's releases, model catalog moves, security-relevant rows and the heaviest work, with one-click Discord copy. Deterministic, no LLM.
- **Shipped in**: every card names the first release (per version track) that carried the commit, derived from the bump rows at build time.
- **Evidence**: each AI summary has a collapsed *Evidence* block citing the diff, plus any identifiers the grounding check could not verify. Evidence and file paths are searchable on `/search/`.
- **In-flight previews**: open PRs on `/in-flight/` carry an AI preview ("what it proposes") written from the description and the stored diff preview, a few per run (`CHANGELOG_PR_LLM_LIMIT`). Merged PRs are remembered in `data/merged-prs.json` so the sync commit that lands them still gets its PR context.
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
| `CHANGELOG_ELI5_TEMPLATES` | `1` | Fixed plain-English line for test-only/docs-only rows (no API call); `0` sends them to the model |
| `CHANGELOG_LLM_REWRITE_STALE` | `0` | `1` re-queues rows summarized under an older prompt (same as `enrich-all --rewrite-stale`) |
| `CHANGELOG_LLM_VERIFY` | `0` | `1` runs the second-model verifier on major/notable summaries |
| `LLM_VERIFY_MODEL` | `LLM_MODEL` | Model for the verifier pass |
| `LLM_MODEL_MAJOR` | — | Stronger model for heavy rows (major/notable, catalog, security, roll-ups, multi-topic) |
| `LLM_JUDGE_MODEL` | `LLM_VERIFY_MODEL` | Model for `eval --judge` |
| `CHANGELOG_ISSUES_URL` | this repo's `issues/new` | Base URL for the per-card report link |
| `CHANGELOG_PR_LLM` | `1` | AI previews for open PRs (`0` disables) |
| `CHANGELOG_PR_LLM_LIMIT` | `5` | Open-PR previews per run |
| `CHANGELOG_DIST_SKIP_CHURN_DIFFS` | `0` | `1` leaves lockfile-only diffs out of `dist/` (cards fall back to the GitHub link) |
| `CHANGELOG_DIST_DIFF_MONTHS` | all | Ship only the last N months of stored diffs to `dist/` |
| `SITE_URL` | — | Base URL for RSS and sitemaps |

## Deployment

Deploy `dist/` to **Cloudflare Pages**:
- **Build command**: `node generator/cli.mjs build`
- **Output directory**: `dist`
- Run continuous updates via `npm run backfill --push` (systemd). The GitHub Actions workflow (`.github/workflows/changelog-sync.yml`) is a **backstop only**: scheduled runs drift by hours and it defaults to `CHANGELOG_LLM_LIMIT=10`, so nothing should depend on it for freshness or for working through the summary backlog.
