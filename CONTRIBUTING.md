# Contributing to freebuff-changelog

This repo is mostly automated: a relay workflow polls upstream, generates
deterministic entries, and optionally enriches them with an LLM. Human
contributions are code, docs, prompt, and style changes — never hand-edited data.

## Ground rules

- **Branch from `main`, open a PR.** Nothing merges via direct push except the
  relay's own data commits. Never stack a PR branch on another open PR branch.
- **Zero runtime dependencies.** `package.json` has no `dependencies` and it
  stays that way. Build/CI tooling must not leak into the generator or the Worker.
- **Tests never spend money.** `npm test` and `npm run build` never call an LLM.
  Keep it that way: gate any paid path behind `CHANGELOG_LLM=1` and default it off.
- **`data/` is generated.** Don't hand-edit entries, summaries, or caches. To
  correct published text, use `node generator/cli.mjs override <sha>` (writes
  `data/overrides.json`, applied at build time) or open a data-correction issue.

## Local checks

```bash
node --version        # 22+
npm test              # offline suite, no LLM calls
npm run build         # reads stored data; writes ignored dist/ only
npm run preview       # optional local preview on port 8788
```

Run `node --check` on any file you touch. CI (`generator-check`) runs syntax,
build, the deploy-envelope check, and the offline suite.

## Prompts and eval

Summary/ELI5 prompt changes are covered by the golden set:
`node generator/cli.mjs eval --seed 40` refreshes `data/eval/golden.json`,
`node generator/cli.mjs eval` audits stored artifacts offline. `eval-weekly`
runs the audit on Tuesdays; keep its gate green.

## Site style

- Match the existing code: plain Node.js, no frameworks. Comment the *why*
  where it isn't obvious.
- Site CSS lives in `generator/lib/style.mjs`; client JS is inline in
  `generator/lib/site.mjs`. If your JS adds a visual hook (class, chip,
  animation), the stylesheet must define it — see the `.fresh-chip`
  regression test in `generator/test/site.test.mjs`.
- Keep the terminal aesthetic: amber/cyan/green on dark, `var(--t-xs)` for badges.
- Keep layouts consistent site-wide; don't change a page's box width to fix
  alignment — center content inside the existing width.

## Reporting issues

Use the issue templates. For a wrong summary or explanation, the
data-correction template routes to the override workflow. Include the entry's
`/c/<sha>` permalink so the row can be found.
