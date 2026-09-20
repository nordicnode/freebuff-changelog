// generator/lib/versions.mjs - prompt versions and cache-key version parsing.
//
// Lives apart from llm.mjs so mergedata.mjs (which llm.mjs imports) can read
// the current versions without a circular import. llm.mjs re-exports these.

// Bump when buildPrompt changes so stale entries re-summarize exactly once
// (through `enrich-all --rewrite-stale`; the hourly sync leaves history alone).
// v8: audience classification, identifier-grounding rule, sequence items
// trimmed to title + first sentence, unsummarized siblings marked as such.
// v9: structured facts (constants old->new, env vars, flags, exports, test
// titles), PR review threads, glossary, per-topic `changes` for multi-area
// snapshots, and the userVisible/breaking/migration/confidence/unknowns fields.
// v10: map-reduce for large diffs (per-chunk drafts + fuse, validated against
// the full diff), per-claim verifier verdicts, grounding v2 (bare
// CONSTANT_CASE names, versions and --flags, plus ELI5 grounding),
// temperature 0, PR file-match stop-list + relevance gate, and [caution]
// marking for unverified release-window members.
export const PROMPT_V = 10

// v7: commit nature always supplied, audience handed over, no "you (the
// person...)" asides, template lines for test-only and docs-only rows.
export const ELI5_V = 7

// v8: the roll-up ask gained the anti-marketing rules the per-commit pass has.
export const RELEASE_ROLLUP_V = 8

export function cacheKeyVersion (key) {
  const m = /:(eli5:)?v(\d+):/.exec(String(key))
  if (!m) return null
  return { kind: m[1] ? 'eli5' : 'summary', v: Number(m[2]) }
}

export function isStaleCacheKey (key, { promptV = PROMPT_V, eli5V = ELI5_V } = {}) {
  const kv = cacheKeyVersion(key)
  if (!kv) return false
  return kv.kind === 'eli5' ? kv.v < eli5V : kv.v < promptV
}

// Cache keys carry their prompt version, so once the versions move on every key
// from an older ask is dead weight: nothing reads it (entries keep their own
// copy of the text) and every merge and read pays for it. Returns the count.
export function pruneStaleCache (cache, { promptV = PROMPT_V, eli5V = ELI5_V, keepShas = null } = {}) {
  if (!cache || typeof cache !== 'object') return 0
  let pruned = 0
  for (const k of Object.keys(cache)) {
    if (!isStaleCacheKey(k, { promptV, eli5V })) continue
    if (keepShas && keepShas.has(k.split(':')[0])) continue
    delete cache[k]
    pruned++
  }
  return pruned
}
