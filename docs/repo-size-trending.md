# Repo-size trending

The `history-size-audit` workflow (`.github/workflows/history-compaction.yml`)
is dispatch-only and currently only **prints** the repo size -- it writes no
record, so growth is invisible between runs. This file defines the metric to
track so a future change can record it with minimal work.

## The metric

One reading = one JSON line with:

| Field | Source |
|---|---|
| `ts` | UTC ISO-8601 of the reading |
| `sizeKiB` | `gh api repos/${GITHUB_REPOSITORY} --jq .size` (what the audit already fetches; includes all history) |
| `dataFiles` | tracked file count under `data/` (`git ls-files data/ \| wc -l`; ~12.9k as of 2026-10-06: ~10.9k diffs, ~1.1k evidence, ~750 changelog shards) |
| `overBudget` / `nearBudget` | counts from `findOverBudget` in `generator/lib/sizebudget.mjs` (warn 60 MiB, max 85 MiB per file) |
| `dataCommits7d` | `git log --since="7 days ago" --oneline \| wc -l` on the data path (churn rate; ~3.3k/week as of 2026-10-06) |

## Proposed record

`reports/repo-size-history.jsonl`, one line per reading, committed by the
audit run. The workflow would need `contents: write` (it currently has
`contents: read`) to append and push; that permission change is an owner
decision and is **not** made here. Until then, record readings manually when
running the dispatch.

## Why it matters

`data/` commits land every few minutes (~15 MiB/day of history churn per the
deploy workflow's comments). The tracked-file budget (`sizebudget.mjs`) guards
single pushes, but nothing watches the slope. The trend line is the input to
the [data-branch migration decision](data-branch-migration.md): it shows
whether the slope justifies the move.
