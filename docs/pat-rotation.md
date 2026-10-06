# Rotating `CHANGELOG_GITHUB_TOKEN`

`CHANGELOG_GITHUB_TOKEN` is a GitHub personal access token stored as a
**repo Actions secret** on `nordicnode/freebuff-changelog`
(Settings → Secrets and variables → Actions). It is the relay's credential
for talking to the GitHub API as something other than the default
`GITHUB_TOKEN`. Never in this repo (public), never in `.env` examples.

## What breaks without it

The relay degrades rather than dies, and most of the degradation is quiet:

1. **Deploy cadence drops.** Data pushes fall back to the default
   `GITHUB_TOKEN`, and GitHub refuses to start workflow runs for pushes made
   with it -- so `deploy-site`'s push trigger goes dead and the site refreshes
   only on its 30-minute schedule. The auth step
   (`changelog-sync.yml`, "Authenticate data pushes so they trigger
   deploy.yml") proves the token can push before using it, and the
   "Fail on silent push-auth degradation" step turns the fallback red so PAT
   expiry is a failure, not a warning nobody watches.
2. **GitHub API calls lose their credential.** `generator/cli.mjs` uses
   `CHANGELOG_GITHUB_TOKEN || GITHUB_TOKEN` for calls like the traffic
   metrics fetch, and the workflow uses the PAT for `gh run list` /
   `gh workflow run`. Without it those calls run on the default token's
   quota and permissions instead.
3. **The relay chain breaks.** The "Dispatch next relay cycle" step uses the
   token for `gh run list` / `gh workflow run`. A PAT missing the Actions
   scope fails the dispatch on every run, and the relay drops to the
   ≤10-minute watchdog cadence.

Required scopes: **Contents: write + Actions: read/write**. A Contents-only
PAT passes the push probe and still downgrades the relay to watchdog cadence.

## Rotation procedure

1. Create the new token with Contents: write and Actions: read/write on this
   repo only. Do not reuse the relay's token anywhere else, and do not widen
   its scopes "just in case".
2. Set it: `gh secret set CHANGELOG_GITHUB_TOKEN` and paste the new value
   when prompted.
3. Verify the token can push before the next cycle depends on it:
   `GH_TOKEN='<new-token>' gh api repos/nordicnode/freebuff-changelog --jq .permissions.push`
   must print `true`. (This is the same probe the workflow's auth step runs.)
4. Confirm the next `changelog-sync` run: the "Authenticate data pushes"
   step should log `Data pushes now authenticate with CHANGELOG_GITHUB_TOKEN`
   and the run must have **no** push-auth warning or the
   "Fail on silent push-auth degradation" error.
5. Confirm a data commit from that cycle starts a `deploy-site` run (push
   trigger), not just the 30-minute schedule.
6. Only then revoke the old token.

If anything in step 4-5 looks wrong, the old token still works until it is
revoked in step 6 -- rotation is safe to redo.

## Precedent: the Ask-the-AI key

`ASK_LLM_API_KEY` rotates the same way at the secret level
(`gh secret set ASK_LLM_API_KEY`), but the Worker binding is sticky: after
setting the new value, run `deploy-site` with the **`rebind_ask_key`**
workflow input, because the binding step otherwise skips an already-bound
secret and the `/api/ask` probe only proves a binding exists, not that the
key is current. `CHANGELOG_GITHUB_TOKEN` needs no rebind -- every
`changelog-sync` run re-proves and re-applies it -- so a plain secret
rotation is enough.
