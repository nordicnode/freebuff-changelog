# Freebuff Changelog

[![Version](https://freebuff-changelog.nordicnode.workers.dev/badge/version.svg)](https://freebuff-changelog.nordicnode.workers.dev)
[![Models](https://freebuff-changelog.nordicnode.workers.dev/badge/models.svg)](https://freebuff-changelog.nordicnode.workers.dev/models/)
[![Status](https://freebuff-changelog.nordicnode.workers.dev/badge/status.svg)](https://freebuff-changelog.nordicnode.workers.dev)
[![Changes](https://freebuff-changelog.nordicnode.workers.dev/badge/changes.svg)](https://freebuff-changelog.nordicnode.workers.dev/archive/)

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
node generator/cli.mjs freshness                                # CI gate: fail if data/changelog.json is older than the site's own [stale] threshold
node generator/cli.mjs eval --seed 40 && node generator/cli.mjs eval   # summary-quality evaluation (LLM judge on by default, --no-judge opts out)
node generator/cli.mjs override <sha>                             # print a ready-to-edit correction draft; add --title/--summary/--eli5/... to write it, --clear to drop it
```

## How It Works

1. **Fetch & Diff**: Pulls upstream snapshots and diffs parent commits to isolate individual changes.
2. **Deterministic Extraction**: Extracts model lineup changes (README tables), version bumps (`package.json`), slash commands, and developer comments.
3. **Classification**: Categorizes by area and significance. Churn commits (lockfiles, assets) are dimmed in the UI rather than dropped.
4. **AI Enrichment (Optional)**: Adds technical summaries and ELI5 plain-English explanations, cached by SHA and diff hash. Every summary carries an **evidence** citation, an **audience** (`end-users`, `advertisers`, `operators`, `maintainers`) and passes an **identifier-grounding check**: backticked names, bare `CONSTANT_CASE` names, camelCase/PascalCase names in prose, versions and `--flags`, plus every multi-digit number the summary states, that do not appear as whole words in the diff or source context trigger one repair pass and are otherwise recorded as `ungrounded` and shown as unverified (a truncated prefix like `CODEBUFF_MO` fails against `CODEBUFF_MODELS`; a dotted name counts as present when the corpus nests it as an object literal, so `page.url` is grounded by `page: { url: page }`; digit separators are normalized, so a diff's `12_500` grounds "12500"; a row that still ships an ungrounded name cannot self-report `confidence: high`; the ELI5 line is grounded the same way and parks instead of storing a leak). Everything the prompt shows the model is in the grounding corpus, and everything in the corpus the model is shown - sibling titles, lineage summaries - grounds a copied name. PRs matched by touched files pass an LLM relevance gate before their description enters the prompt. Source context is tiered by diff size (a one-line change does not get four full files). Test-only and docs-only rows get a fixed plain-English line without an API call.
5. **Static Generation**: Builds zero-JS, pre-rendered HTML/CSS to `dist/` with instant revalidation.

### What the model is given

- **Structured facts** (`extractStructuredFacts`): constants whose value changed (`X: 300 -> 500`), environment variables newly read, CLI flags introduced, exports added/removed, and the titles of new tests (test hunks themselves stay out of the prompt). Extracted mechanically from the full stored diff (the richer set always replaces the narrow analyze-stage one), then `pruneKnownInputs` `git grep`s each "new" env var, flag, and test title against the base rev, so relocated code and renamed tests are not claimed as new inputs (lookups fail open). Copied into the prompt verbatim, added to the grounding corpus, and rendered as chips on the card. `repair-entries` backfills them for stored rows.
- **PR context**: description and up to six review comments. Sync commits are squashes, so their PR is recovered by **file-set matching** against `data/merged-prs.json` (≥2 shared files, ≥60% of the PR's known files, within 14 days); matched PRs are marked `?` on the card and "likely, not certain" in the prompt.
- **Glossary** (`data/glossary.json`): plain-English meanings for internal terms, injected into both passes. `glossary --discover` adds candidate terms from upstream docs headings (empty definitions are never injected).
- **Multi-topic snapshots** (≥2 areas or ≥8 files) are asked for a per-topic `changes` list in addition to the prose summary.
- **Structured output**: `userVisible`, `breaking`, `migration`, `newEnvVars`, `newFlags`, `confidence`, `unknowns`. Lists are grounded like identifiers; `[BREAKING]` and `[LOW CONFIDENCE]` badges, an ACTION line and a NOT IN THE DIFF line render from them.
- **Diff ordering**: when the diff exceeds the budget, source files go first, then docs/config, then tests, then snapshots and generated files (smaller first within a tier). Diffs over ~150KB skip truncation entirely: per-chunk drafts are fused into the entry (map-reduce, `CHANGELOG_LLM_MAPREDUCE=0` disables). Chunk readers get the architecture map, domain lexicon and structured facts; the fuse gets a per-file digest of the whole diff (line counts plus sample added lines) to referee draft conflicts, and the final entry is grounded against the full corpus regardless of which chunk a name came from.
- **Tiered models**: set `LLM_MODEL_MAJOR` to route major/notable rows, catalog and command changes, security-relevant rows, release roll-ups and multi-topic snapshots to a stronger model while `minor` stays on `LLM_MODEL`.

### Quality controls

- **Evaluation harness**: `eval --seed 40` writes `data/eval/golden.json` from recent rows: deterministic must-mention identifiers are seeded, but reference summaries start **empty** (grading a new summary against the pipeline's own old output measures imitation, not accuracy) and rows stay `verified: false` until a human writes the reference and confirms the labels. `eval [--limit N]` re-summarizes the golden rows on the current prompt into a scratch cache, scores grounding, path grounding (rows citing no paths are not counted as passes), WHY rate, hype of the current run's own text, title length, must-mention coverage, structured-fact use and (verified rows only) audience/significance agreement, and runs the LLM-as-judge rubric (`LLM_JUDGE_MODEL`; faithfulness/completeness/clarity graded against the same prioritized diff budget and structured facts the summarizer saw) unless `--no-judge`. Every rate reports its denominator (`n=` when fewer rows scored than ran), results land in `data/eval/results/`, and the table compares against the previous run. `.github/workflows/eval-weekly.yml` runs it every Tuesday and commits the result file, so `/stats/` (GOLDEN-SET EVAL card) always shows a real number rather than an unaudited claim; it was manual-only before, and the results directory stayed empty for months.
- **Report link**: every card has a `report` link that opens a prefilled issue (`CHANGELOG_ISSUES_URL`); fixes land in `data/overrides.json`.
- **Gave-up rows** (AI title identical to the mechanical label) re-queue automatically.

- **Prompt versions**: `PROMPT_V` / `ELI5_V` / `RELEASE_ROLLUP_V` in `generator/lib/llm.mjs`. Bumping one re-summarizes affected rows once. Rows on an older prompt are left alone by the hourly sync; `enrich-all --rewrite-stale` refreshes them, heaviest first.
- **Anti-marketing**: release roll-ups and single rows are rejected (and repaired) when they contain hype ("smarter", "faster", "seamless", "together, these changes make...").
- **Second-model verifier** (on by default): `LLM_VERIFY_MODEL` checks per-claim support for major/notable, multi-topic and ungrounded rows (`CHANGELOG_LLM_VERIFY=all` checks every row, `0` disables); one repair, then the row is stored with `verify: passed|flagged`, with the outstanding objections kept as `verifyClaims` (a reader can see which sentence a reviewer flagged). Names the prompt showed only through a same-day sibling's title are handed to the verifier as attribution cautions, so a claim that silently borrows a sibling's motive is an objection, not a paraphrase. Constant changes are direction-checked deterministically (`from -> to` stated backwards is a `valueErrors` repair), and a row that still ships dirty gets one rewrite on `LLM_MODEL_MAJOR` before it goes out (`CHANGELOG_LLM_ESCALATE=0` disables).
- **Breaking-claim self-check**: `breaking` and `migration` claims are the loudest text an entry can emit, so a second independent read answers only those two fields; a claim the same model cannot reproduce from the same diff is demoted to `unknowns` (`CHANGELOG_LLM_SELFCHECK=0` disables). Consistency is one-sided evidence: a passed probe is not proof, but a failed one reliably catches single-read fabrications.
- **Human overrides**: `data/overrides.json` (`{ "<sha or 12-char prefix>": { "title", "summary", "eli5", "significance", "evidence", "audience", "note" } }`) is applied at build time on every surface and survives re-summarization. `override <sha>` authors one: run it bare for a draft pre-filled with the current rendered values, then with `--title`/`--summary`/... to write, `--clear` to drop. Overridden rows show an `[EDITED]` badge.
- **/stats/ quality panel**: prompt-version coverage, evidence coverage, unverified identifiers, hype and preamble counts, audience split. Recomputed every build.
- **Deterministic weight**: a bump-only row is now `notable` (was `major`); `major` is reserved for model catalog changes and bumps that also ship code. Every weight carries a `significanceReason` shown in the badge tooltip. Stored rows keep their old weight until `repair-entries` is run once.

## Site & Feeds

- **Timeline**: Daily changelog views (`/day/YYYY-MM-DD/`), releases (`/release/1.0.NNN/`), model tracker (`/models/`), and live metrics (`/stats/`). The front-page filter narrows by area, impact and audience; `/search/` filters by category, impact range ("notable + major" is inclusive), audience and releases. Badge tags link to the complete `/changes/<slice>/` list behind them.
- **Feeds**: `/feed.xml` (all changes), `/feed-major.xml` (major only), `/feed-models.xml`, `/feed-releases.xml`, `/feed-security.xml` (trust, checksums, credentials, privacy), `/feed-weekly.xml` (one item a week), `/feed-<category>.xml` (e.g. `/feed-cli.xml`, `/feed-sdk.xml`), `/feed-audience-<audience>.xml` (who the change is for), `/feed.json` (JSON Feed 1.1). Every feed the site writes is bundled in `/feeds.opml`, and `/subscribe/` is "everything I care about": check what you follow and take the selection as a personal OPML (or copy the feed URLs).
- **API**: `/api/entry/<sha>[.json]` serves one entry's machine-readable record (title, summary, plain English, significance, audience, files, stats, release it shipped in, links), `/api/entries.json` the newest 60, `/api/days.json` the day index, `/api/status.json` the build stamp. Records are sharded per day under `api/records/` and sliced by `worker.js` (or `npm run preview` locally), because per-entry files would blow the Workers asset cap.
- **Date ranges**: `/from/<date>/to/<date>/` renders every change between two dates on one shareable page (assembled client-side from the day cards); `/range/` is the pick-the-dates front door.
- **Release notes as markdown**: every release page carries `notes.md` (plain GitHub-release markdown) and `?format=md` serves it as `text/markdown` for tools and feeds.
- **Weekly digests**: `/week/YYYY-Www/` lists a week's releases, model catalog moves, security-relevant rows and the heaviest work, with one-click Discord copy. Deterministic, no LLM.
- **Shipped in**: every card names the first release (per version track) that carried the commit, derived from the bump rows at build time. Model pages say **first shipped in** which release introduced the model, and link its **lineage**: the family's generation chain (`DeepSeek V4 Pro 07/31 -> DeepSeek V4 Pro -> ...`, grouped deterministically from the catalog names, with `/models/lineage/<family>/` pages listing every generation).
- **Evidence**: each AI summary has a collapsed *Evidence* block citing the diff, plus any identifiers the grounding check could not verify. Evidence and file paths are searchable on `/search/`.
- **In-flight previews**: open PRs on `/in-flight/` carry an AI preview ("what it proposes") written from the description and the stored diff preview, a few per run (`CHANGELOG_PR_LLM_LIMIT`). Merged PRs are remembered in `data/merged-prs.json` so the sync commit that lands them still gets its PR context.
- **Discord**: Every entry includes one-click Discord markdown copy (≤ 2,000 chars). Feeds support MonitoRSS and webhooks natively.
- **Release roll-ups**: version-label rows (both the `1.0.x` CLI line and the `0.0.x` free-app line) explain the user-visible changes shipped since the previous bump of the same line, fed from the already-written titles and summaries in that window (up to 200 entries, 200k characters). A member whose own summary carries ungrounded identifiers is dropped from the window entirely (its deterministic model/command events still count, and the roll-up is told how many items were omitted), so a bad summary cannot launder its names into the release story; review-flagged members travel with a `[caution]` marker the roll-up must hedge or omit. Rows with an empty window keep the honest housekeeping line.
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
| `CHANGELOG_LLM_VERIFY` | `1` | Verifier for summaries: `1` (default) checks major/notable, multi-topic and ungrounded rows; `all` checks every row; `0` disables |
| `CHANGELOG_LLM_MAPREDUCE` | `1` | `0` disables map-reduce (per-chunk drafts + fuse) for diffs over ~150KB (`CHANGELOG_LLM_MAPREDUCE_THRESHOLD`) |
| `CHANGELOG_PR_GATE` | `1` | `0` keeps file-set-matched PR context without the LLM relevance check |
| `LLM_VERIFY_MODEL` | `LLM_MODEL` | Model for the verifier pass |
| `LLM_MODEL_MAJOR` | — | Stronger model for heavy rows (major/notable, catalog, security, roll-ups, multi-topic) |
| `LLM_JUDGE_MODEL` | `LLM_VERIFY_MODEL` | Model for the eval judge (on by default; `--no-judge` opts out) |
| `CHANGELOG_ISSUES_URL` | this repo's `issues/new` | Base URL for the per-card report link |
| `CHANGELOG_PR_LLM` | `1` | AI previews for open PRs (`0` disables) |
| `CHANGELOG_PR_LLM_LIMIT` | `5` | Open-PR previews per run |
| `CHANGELOG_LLM_ESCALATE` | `1` | One rewrite of a still-dirty entry on `LLM_MODEL_MAJOR` before it ships (`0` disables) |
| `CHANGELOG_LLM_SELFCHECK` | `1` | Second read demotes unconfirmed `breaking`/`migration` claims (`0` disables) |
| `CHANGELOG_LLM_CONCURRENCY` | `2` | Summaries in flight (the RPM limiter stays the real bound; up to 6) |
| `CHANGELOG_DIST_SKIP_CHURN_DIFFS` | `0` | `1` leaves lockfile-only diffs out of `dist/` (cards fall back to the GitHub link) |
| `CHANGELOG_DIST_DIFF_MONTHS` | all | Ship only the last N months of stored diffs to `dist/` |
| `SITE_URL` | — | Base URL for RSS and sitemaps |
| `CHANGELOG_SYNC_STALE_MIN` | `5` | How long the loop lets data sit before re-analyzing upstream, even when the upstream head has not moved. Everything that reports freshness is stated in these terms: the site's `[fresh]`/`[stale Nm]` badge and `cli.mjs freshness` both call data stale past **2x** this (one overdue pass is a sync in flight; two means the loop is not running). |

## Deployment

Deploy `dist/` to **Cloudflare Workers** (static assets plus one thin route script: badges are pre-rendered SVGs) **without Cloudflare-side builds**:

- `worker.js` (wired through `main` in `wrangler.json`, `run_worker_first`) answers only the routes a static file cannot vary per request -- `/api/entry/<sha>.json` and `/release/<v>/?format=md` -- and falls through to the asset server (which still applies `_redirects`/`_headers`) for everything else. `npm run preview` serves the same routes locally through the shared `dynamicRoute()` handler in `generator/cli.mjs`, so preview and deploy cannot drift.
- Cloudflare dashboard: Workers & Pages -> `freebuff-changelog` -> Settings -> Builds -> disconnect git / disable automatic builds. The daemon pushes data every few minutes and every push would otherwise bill a Workers Build.
- `.github/workflows/deploy.yml` builds `dist/` on GitHub Actions (free for this public repo) and uploads it with `wrangler deploy`, a direct asset upload that consumes zero build minutes. Needs repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and variable `CLOUDFLARE_ACCOUNT_ID`. Without the token the workflow still smoke-checks the build and skips the upload. It rebuilds on every push to `data/`, so those pushes must be made with a token that can start workflows: GitHub never starts a run for a push made with the default `GITHUB_TOKEN`, and `changelog-sync.yml` therefore pushes with `CHANGELOG_GITHUB_TOKEN` (Contents: write) after verifying it can write, falling back to the 30-minute schedule otherwise. Do not add a second `workflow_run` trigger for the sync: it fires on every completed cycle, and the shared `cancel-in-progress` concurrency would cancel the in-flight push deploy each time.
- Continuous updates run entirely on GitHub Actions: `.github/workflows/changelog-sync.yml` is a self-perpetuating relay that polls upstream every 30s in ~12-minute cycles, pushes `data/`, and dispatches the next run. `npm run backfill --push` runs the identical loop locally, but nothing depends on it. The relay dispatch runs on `if: always()`: a failed cycle is exactly when a retry is needed, and gating the next run on the last one's success turned one bad cycle into a silent outage down to the watchdog's 10-minute cadence.
- **Staleness fails CI.** A dead sync loop used to be invisible from GitHub's side: every cycle logged its error, exited 0, and deploy.yml green-lit a build of the frozen data, so the only witness was the `[stale 16m]` badge readers saw. Now the loop aborts once its failures stretch over the freshness budget (instead of spending 12 minutes publishing nothing), and deploy.yml finishes with `node generator/cli.mjs freshness` -- after the upload, never before it, so the gate can never withhold a good deploy -- which fails the run on data older than the badge would call stale. The only exemption is a *deliberate* pause: the gate stands down while `changelog-sync` itself is disabled, which is how `history-compaction.yml` drains the relay for up to ~24 minutes before it rewrites history.
- History stays bounded by `.github/workflows/history-compaction.yml`: a weekly (size-gated) job squashes `main` to a single commit whose tree is byte-for-byte the current one. Every commit here is derived bot data (~15 MiB/day), so the *history* carries no information the *tree* does not -- but its growth is what makes clones and full-depth checkouts slow, and it would hit GitHub's 1 GiB repo warning within months at this cadence. The job verifies the new tree hash equals the old one before force-pushing, refuses to run while a sync cycle is alive (it disables and drains `changelog-sync.yml` first, then re-enables it), and no-ops when the repo is below the size threshold or already freshly squashed. The squashed push uses the workflow token, which starts no deploy (content is unchanged). Requires `main` to be unprotected (or to allow Actions force-push). **After a compaction, older clones diverge: `git fetch origin && git reset --hard origin/main` (commit your own work first) re-anchors with zero content loss.**
- `.github/workflows/eval-weekly.yml` runs the golden-set eval on a Tuesday schedule (and on demand, with the judge pass optional) and commits only `data/eval/results/`, tagged `[skip ci]`: the numbers feed the `/stats/` card on the next regular deploy rather than costing one of their own.
