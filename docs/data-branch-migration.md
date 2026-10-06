# Plan: move `data/` to an orphan branch

**Status: plan only. Do not execute without owner review and approval.**

## Problem

`data/` holds ~12.9k tracked files (10.9k diffs, 1.1k evidence, ~750 changelog
shards, pr-diffs, rollups) and the relay commits to it every few minutes
(~3.3k commits/week, ~15 MiB/day of history churn). Every `main` clone carries
that churn, `git log` on main is a data log with code commits sprinkled in,
and the repo's growth slope is unbounded by design (forward-only, nothing is
ever rewritten).

## What the move does and does not fix

- **Does fix:** `main` history stops churning; code review, `git log`,
  bisect, and shallow code checkouts become cheap; data commits no longer
  compete with code pushes for the deploy trigger.
- **Does not fix:** total repo size. GitHub's repo `.size` and the
  100 MiB/file push limit are **per-repo, not per-branch** -- the objects
  still live in the same repo. If the goal is shrinking `.size`, this plan
  is the wrong tool; that needs compaction (currently forbidden by policy)
  or moving blobs out of git entirely.

## Policy gate

`.github/workflows/history-compaction.yml` states: *"No orphan branches,
force pushes, workflow disabling or automatic compaction are permitted"* and
*"Any future migration requires a reviewed archive and explicit remote-SHA
lease."* This plan satisfies that by: (1) owner review of this document,
(2) a recorded pre-cutover `main` SHA (the lease -- nothing is force-pushed),
(3) the old layout restorable from that SHA (see Rollback).

## Design

- New orphan branch **`data`**, rooted at one commit containing the exact
  `data/` tree from `main` at cutover. No code, no workflows on it.
- `main` keeps code, workflows, `wrangler.json`, `worker.js`, docs. After
  cutover, `main` carries no `data/` tree.
- `data/overrides.json` lives on the `data` branch (it is data); the
  `override` CLI command must target the data-branch checkout.

## Workflow changes

**changelog-sync.yml** (relay): needs code (from `main`) *and* data (from the
`data` branch) in one working tree. Check out `main`, then fetch and check out
the `data` branch into `data/` (second `actions/checkout` with `ref: data`
and `path`, or a `git worktree`). `commitAndPushData` pushes to the `data`
branch instead of `main`. The push-auth probe (`CHANGELOG_GITHUB_TOKEN`,
Contents: write) is unchanged, but it must prove push to the `data` branch.

**deploy.yml** (deploy-site): trigger changes from `push: branches: [main,
master], paths: ['data/**', ...]` to `push: branches: [data]` for data
deploys (plus `main`/`master` for code/generator/wrangler changes -- keep the
path filter for those). The build step merges the two trees the same way the
relay does (checkout `main`, overlay `data` branch). The CHANGELOG_GITHUB_TOKEN
push-trigger mechanism is unchanged: data-branch pushes made with the PAT
still start workflow runs; pushes with the default `GITHUB_TOKEN` still do not.
The 30-minute schedule safety net and the freshness gate are untouched.

**generator-check.yml**: code-only; unchanged. Note the tracked-file size
budget (`sizebudget.mjs`, `assertDataSizeBudget`) currently runs in CI
against the working tree -- after the split it must run where a data tree
exists (relay run or a check job that also overlays the `data` branch), or it
goes blind.

**eval-weekly.yml**, retention, deploy envelope: unchanged; they operate on
the merged tree.

## Cutover steps

1. **Record the lease:** note the current `main` SHA. Pause the relay
   (let the watchdog hold; do not disable the workflow).
2. **Create the branch:** `git checkout --orphan data <main-SHA>`,
   remove everything except `data/`, commit, push `data`. Verify the tree
   matches `main`'s `data/` exactly (`git diff <main-SHA> data -- data/`).
3. **Update the workflows** on `main` (PR, green `generator-check`): two-tree
   checkout in relay and deploy, new deploy trigger, budget check placement.
4. **Dry run:** dispatch one `changelog-sync` cycle against the new layout;
   confirm it commits to the `data` branch and that the commit starts a
   `deploy-site` run via the push trigger.
5. **Verify the deploy:** check the live `/api/status.json` head SHA and
   `generatedAt` advance past the cutover; confirm the freshness gate is
   green.
6. **Remove `data/` from `main`** (one commit). Confirm the next relay cycle
   and the next code push both behave.
7. **Monitor** one full day: relay cadence, deploy queue depth, freshness
   gate, and the [size trend](repo-size-trending.md).

## Rollback

Everything is additive until step 6, so rollback before step 6 is just
reverting the workflow PR. After step 6: revert the workflow commits on
`main`, restore the `data/` tree from the recorded pre-cutover SHA
(`git checkout <lease-SHA> -- data/`), push to `main`, and re-point the
relay at `main`. The `data` branch remains as the archive; delete it only
after a week of healthy operation on the old layout. No force-push is ever
needed in either direction.

## Risks

- **Deploy trigger misconfiguration** is the top risk: if the `data`-branch
  push trigger is wrong, the site silently drops to the 30-minute schedule
  (the failure mode the PAT runbook already documents). Mitigation: step 4-5
  verification before removing `data/` from `main`.
- **Split-brain writes:** a relay run against the old layout writing to
  `main`'s `data/` after cutover. Mitigation: the pause in step 1 and the
  single-PR workflow change.
- **Checkout complexity:** two refs in both relay and deploy; shallow clones
  must fetch the `data` branch too, or the build sees an empty `data/`.
  Mitigation: fail the build loudly if `data/changelog.json` is missing.
- **Size limits unchanged:** per-repo `.size` keeps growing at the same rate;
  this plan must not be sold as a size fix (see above).
- **Overrides confusion:** `data/overrides.json` moves with the data; anyone
  running `override` against a plain `main` checkout will write to a
  `data/` that no longer deploys. Mitigation: the command should refuse when
  the data branch is not overlaid (error message naming the branch).
