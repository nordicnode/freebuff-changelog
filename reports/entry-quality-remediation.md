# Entry quality remediation — 2026-10-01

## Observed failures

- The public Oct 1 page printed two independently rendered warnings for an unavailable technical verifier. This was an outage, not a negative semantic verdict.
- Stored `ai-summaries.json` requests show verifier HTTP 504s with repeated identical prompt hashes. The Oct 1 health bucket recorded 35 verifier-unavailable outcomes out of 36 summarized entries; these are ledger events, not a unique-entry census.
- `dfec4965e1fc` (Freebuff 0.2.9) changes 26 files, with 17 meaningful files and +1193/−105 lines. It has no stored AI summary. Its writer failure stubs show HTTP 504s and deadline interruptions. The public sentence was a mechanical fallback, not a successful model generation.
- Release windows were enabled only for nearly empty bumps. Mixed code/version releases missed that evidence path.
- The release plain-English prompt placed `Date:` after its window. The delivered-evidence extractor starts at `Date:`, so pure roll-ups could pass an empty evidence bundle to their checker.
- Deferred verification rejected records when a release/context cache key changed, even if their original evidence bundle and source patch were intact. Multiple records for one SHA also needed a published-artifact guard.
- Plain-English retry accounting treated every missing parsed verdict as an unanswered gateway call, including malformed model replies, and omitted release framing on rechecks.

## Changes

1. Gateway verification uses one different, compact framing after failure, preserving source material and claim-coverage validation. Model identities/routing are unchanged. This is not a fix for an upstream provider outage.
2. Pending-review rows retain `unavailable` internally, bounded confidence and demoted actions. Reader-facing outage-only alarms become quiet provenance notes; factual objections still produce warnings and badges. The duplicate site-only verifier sentence is removed.
3. Reviews that only encountered gateway failures remain eligible with exponential cooldowns capped at six hours and existing cycle limits. Malformed answers consume verdict tries. An explicit operator error cap remains supported.
4. Deferred review prioritizes the currently published artifact, reserves capacity ahead of healing, and can use its hash-validated original evidence bundle despite a changed context key. Failed retry bookkeeping reaches the entry as well as the cache.
5. Release windows now cover mixed releases. Plain-English roll-ups contain the release commit's own source hunks and start their evidence region before the window. Both checker framings accept own-hunk evidence.
6. Functional release summaries cannot satisfy validation with only manifest/publish/file-inventory boilerplate. This check covers single-pass and map/reduce fusion. Prompts bar generic lists of unchanged repository capabilities.
7. Unavailable member AI prose is not reused as release evidence: mechanical facts are substituted. Discredited claims remain excluded.
8. A plain-English objection gets one rewrite; replacement text requires a passing exact-text check. An outage does not clear the original objection.
9. Releases missing AI text get a read-only build fallback describing sampled changed test assertions, explicitly as assertions rather than live availability. This improves the linked entry immediately on the next build without inventing features or rewriting stored history.

## Validation

- Full offline suite: **386 tests, 385 passed, 1 intentionally skipped, 0 failed**.
- Generator syntax checks and `npm run build` passed.
- Targeted regressions cover mixed release input, nonempty delivered roll-up evidence, boilerplate rejection, 504 recovery with a different prompt, changed-key review, discarded prose exclusion, reader disclosure, mechanical window substitution, exact-text explanation repair, and malformed-reply accounting.
- The built Oct 1 page was inspected: the original duplicate warning is absent; real stored plain-English objections remain visible; the 0.2.9 fallback contains explicit changed-test details.
- One pre-existing test contradicted the existing forward-only `eli5Eligible` implementation. Its expectation now reflects admission-controlled spending rather than implicitly authorizing historical rewriting. No production eligibility gate was widened by that test correction.

## Production boundaries

No provider calls, generated-data edits, historical regeneration, commits, pushes, workflow dispatches, or deployment were performed. Existing stored flagged explanations remain flagged until a successful repair or human correction. The public site is unchanged until these code changes are promoted and deployed.

The upstream gateway's live health is unproven. Offline tests prove the recovery and validation paths, not that a third-party endpoint is available or that every generated claim is correct. A bounded, approved production repair can regenerate named affected rows through the existing sync dispatch `regen` input after the new runtime is promoted. Do not run workstation generation using the relay key or perform an automatic historical backfill.
