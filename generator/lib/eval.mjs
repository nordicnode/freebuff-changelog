// generator/lib/eval.mjs - summary-quality evaluation against a golden set.
//
// Every prompt change so far was judged by eye. This makes it measurable:
//   1. `eval --seed N` writes data/eval/golden.json from recent major/notable
//      rows. Audience, significance and the must-mention identifiers start as
//      the current mechanical/AI values; the reference summary is left EMPTY
//      on purpose: a reference seeded from the AI output being graded would
//      score imitation, not accuracy. Rows stay `verified: false` until a
//      human writes the reference and confirms the labels.
//   2. `eval` re-summarizes every golden row on the current prompt into a
//      scratch cache (never data/ai-summaries.json), scores the output, and
//      writes data/eval/results/<PROMPT_V>-<stamp>.json.
//   3. The report compares the run with the previous one, so a regression in
//      grounding rate, WHY rate or hype shows up as a number, not a feeling.
//
// Metrics (all 0..1 unless noted, each with the count of rows it actually
// scored - a metric measured on 1 row of 40 must not read like a trend):
//   grounded        share of rows with no unverified identifier (as recorded
//                   by the pipeline's own checker; the judge axis below is the
//                   independent measure)
//   pathGrounded    share of rows whose evidence names only listed files
//                   (rows citing no path are not counted)
//   whyRate         share of summaries with a visible cause clause
//   hypeFree        share of this run's titles and summaries free of hype
//                   words (the stored ELI5 belongs to another pass and
//                   version, so it is no longer scored here)
//   audienceAgree   share matching the golden audience (verified rows only)
//   sigAgree        share matching the golden significance (verified rows only)
//   mustMention     share of golden "must mention" identifiers present
//                   (coverage only: it never rewards naming the wrong things)
//   titleLenOk      share of titles <= 70 chars
//   structuredUsed  share of rows with structured facts that cite at least one
//   judge (1..5)    LLM-as-judge rubric, on by default: faithfulness,
//                   completeness, clarity (--no-judge opts out)
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readJson, writeJson, log, pool } from './util.mjs'
import {
  summarizeEntry, gatherEntryContext, findPrMeta, loadPrIndex, groupEntriesByDay, sequenceForEntry,
  getReleaseContextFor, bumpOnly, callLlm, cleanText, budgetPatch, ELI5_HYPE_ROLLUP_RE, WHY_RE,
  PROMPT_V, RELEASE_ROLLUP_V, formatGlossary, loadGlossary, structuredFactsCited
} from './llm.mjs'
import { hasStructuredFacts, formatStructuredFacts } from './analyze.mjs'

export { WHY_RE }

export function whyVisible (summary) {
  return WHY_RE.test(String(summary || ''))
}

// Identifiers a summary of this row ought to name: the deterministic ones.
export function mustMentionFor (e) {
  const out = new Set()
  for (const m of e.modelChanges?.added || []) out.add(m)
  for (const m of e.modelChanges?.removed || []) out.add(m)
  for (const c of e.cmdChanges?.added || []) out.add(c)
  for (const c of e.cmdChanges?.removed || []) out.add(c)
  if (e.version) out.add(e.version)
  if (e.freebuffVersion) out.add(e.freebuffVersion)
  // Strings only: an undefined name would poison mustMention with the value
  // undefined, and text.includes(undefined) then searches the literal word
  // "undefined" -- scoring "mentioned" for prose that merely says undefined.
  for (const c of (e.structured?.constants || []).slice(0, 3)) if (c && typeof c.name === 'string' && c.name) out.add(c.name)
  for (const v of (e.structured?.envVars || []).slice(0, 3)) if (typeof v === 'string' && v) out.add(v)
  for (const f of (e.structured?.flags || []).slice(0, 3)) if (typeof f === 'string' && f) out.add(f)
  return [...out].filter(x => typeof x === 'string' && x.length >= 2).slice(0, 8)
}

export async function seedGolden (entries, dataDir, { count = 40 } = {}) {
  const path = `${dataDir}/eval/golden.json`
  const prev = await readJson(path, { rows: [] })
  const keep = new Map((prev.rows || []).filter(r => r.verified).map(r => [r.sha, r]))
  const candidates = [...entries].filter(e => !e.noise && e.ai?.title && e.hasDiff).reverse()
  const pick = []
  const seen = new Set(keep.keys())
  // Mix: heaviest first, but at least a third minor rows so the set is not
  // only the easy, well-documented changes.
  const heavy = candidates.filter(e => e.significance !== 'minor' || e.ai?.significance !== 'minor')
  const light = candidates.filter(e => e.significance === 'minor' && e.ai?.significance === 'minor')
  const wantLight = Math.floor(count / 3)
  for (const e of heavy) { if (pick.length >= count - wantLight) break; if (!seen.has(e.sha)) { pick.push(e); seen.add(e.sha) } }
  for (const e of light) { if (pick.length >= count) break; if (!seen.has(e.sha)) { pick.push(e); seen.add(e.sha) } }
  const rows = [...keep.values(), ...pick.map(e => ({
    sha: e.sha,
    day: e.day,
    category: e.category,
    verified: false,
    // The AI title carries over as a review aid, but the reference summary
    // starts empty: grading a new summary against the old AI output of the
    // same pipeline measures imitation. A human writes it before verifying.
    reference: { title: e.ai.title, summary: '' },
    audience: e.ai.audience || null,
    significance: e.ai.significance || e.significance,
    mustMention: mustMentionFor(e),
    notes: ''
  }))]
  await mkdir(`${dataDir}/eval`, { recursive: true })
  await writeJson(path, { version: 1, updatedAt: new Date().toISOString(), rows })
  return { count: rows.length, kept: keep.size }
}

export function scoreRow (e, record, golden, corpusText = '') {
  const summary = record.summary || ''
  const text = `${record.title || ''} ${summary} ${record.evidence || ''}`
  const files = [...(e.files?.added || []), ...(e.files?.modified || []), ...(e.files?.removed || []), ...(e.files?.tests || [])]
  const evidencePaths = [...(record.evidence || '').matchAll(/(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|json|md|ya?ml)/g)].map(m => m[0])
  // A row that cites no path has not passed this check, it skipped it: null
  // keeps it out of the rate instead of inflating it with vacuous truth.
  const pathGrounded = evidencePaths.length ? evidencePaths.every(p => files.some(f => f.endsWith(p) || p.endsWith(f))) : null
  const must = golden?.mustMention || []
  const mentioned = must.filter(m => text.includes(m)).length
  // Score what this run wrote. The stored ELI5 belongs to another prompt
  // version and another pass; grading it here mixed two pipelines' records.
  const hype = ELI5_HYPE_ROLLUP_RE.test(record.title || '') || ELI5_HYPE_ROLLUP_RE.test(summary)
  const structuredCited = hasStructuredFacts(e.structured) ? structuredFactsCited(e.structured, text) : null
  return {
    sha: e.sha,
    grounded: !(record.ungrounded?.length),
    ungrounded: record.ungrounded || [],
    pathGrounded,
    why: whyVisible(summary),
    hypeFree: !hype,
    titleLen: (record.title || '').length,
    titleLenOk: (record.title || '').length <= 70,
    // Labels score whether or not a human has verified them: a seeded label is
    // still a fixed target, so prompt-to-prompt regression is visible before
    // verification. The row carries `verified` so the report can separate
    // human-confirmed agreement from seeded-label stability.
    verified: !!golden?.verified,
    audienceAgree: golden?.audience ? record.audience === golden.audience : null,
    sigAgree: golden?.significance ? record.significance === golden.significance : null,
    mustMention: must.length ? mentioned / must.length : null,
    structuredCited,
    confidence: record.confidence || null,
    hasEvidence: !!record.evidence,
    hasUnknowns: !!record.unknowns,
    changes: record.changes?.length || 0
  }
}

export function buildJudgePrompt (e, patch, record, golden) {
  return [
    'You are grading a changelog entry written from a git diff. Score 1-5 on three axes and explain briefly.',
    'faithfulness: every claim is supported by the diff, file list and notes (5 = fully; 1 = invented claims).',
    'completeness: the summary covers the substantive changes in the diff (5 = nothing important missing).',
    'clarity: a developer reading only the title and summary understands what changed and why it matters.',
    'Judge precision, not polish: a summary that names many things but states one wrong number, direction, or motive is unfaithful; a summary that states only the file names is incomplete.',
    'Output JSON: {"faithfulness": n, "completeness": n, "clarity": n, "issues": ["<short>"]}.',
    '',
    `Files: ${[...(e.files?.added || []), ...(e.files?.modified || []), ...(e.files?.removed || [])].join(', ')}`,
    golden?.verified && golden.reference?.summary ? `Human reference summary: ${golden.reference.summary}` : '',
    ...(hasStructuredFacts(e.structured) ? formatStructuredFacts(e.structured) : []),
    '',
    `Title: ${record.title}`,
    `Summary: ${record.summary}`,
    record.evidence ? `Evidence: ${record.evidence}` : '',
    '',
    'Diff:',
    '```diff',
    // The same prioritized budget the summarizer got: a flat head-slice cut
    // everything after the first files, so on big diffs the judge was grading
    // an entry against less of the change than the entry itself saw.
    budgetPatch(patch, 250000, 60000),
    '```'
  ].filter(Boolean).join('\n')
}

export function validateJudgeOut (out) {
  if (!out || typeof out !== 'object') throw new Error('judge output not an object')
  const n = (v) => { const x = Number(v); return x >= 1 && x <= 5 ? Math.round(x) : null }
  const r = { faithfulness: n(out.faithfulness), completeness: n(out.completeness), clarity: n(out.clarity), issues: Array.isArray(out.issues) ? out.issues.map(s => cleanText(String(s), 200)).slice(0, 5) : [] }
  if (r.faithfulness == null || r.completeness == null || r.clarity == null) throw new Error('judge output missing scores')
  return r
}

function mean (xs) {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
function rate (xs) {
  const v = xs.filter(x => typeof x === 'boolean')
  return v.length ? v.filter(Boolean).length / v.length : null
}
// Denominators: rate() and mean() skip the rows they cannot score, so a bare
// average hides how few rows it rests on. Report it: must-mention measured on
// one row of forty is not a trend.
const boolN = (xs) => xs.filter(x => typeof x === 'boolean').length
const numN = (xs) => xs.filter(x => typeof x === 'number' && Number.isFinite(x)).length

export function aggregate (rows) {
  return {
    n: rows.length,
    verifiedN: rows.filter(r => r.verified).length,
    grounded: rate(rows.map(r => r.grounded)),
    pathGrounded: rate(rows.map(r => r.pathGrounded)),
    whyRate: rate(rows.map(r => r.why)),
    hypeFree: rate(rows.map(r => r.hypeFree)),
    titleLenOk: rate(rows.map(r => r.titleLenOk)),
    audienceAgree: rate(rows.map(r => r.audienceAgree)),
    audienceAgreeVerified: rate(rows.map(r => r.verified ? r.audienceAgree : null)),
    sigAgree: rate(rows.map(r => r.sigAgree)),
    sigAgreeVerified: rate(rows.map(r => r.verified ? r.sigAgree : null)),
    mustMention: mean(rows.map(r => r.mustMention)),
    structuredUsed: rate(rows.map(r => r.structuredCited)),
    withEvidence: rate(rows.map(r => r.hasEvidence)),
    withUnknowns: rate(rows.map(r => r.hasUnknowns)),
    lowConfidence: rate(rows.map(r => r.confidence ? r.confidence === 'low' : null)),
    judge: {
      faithfulness: mean(rows.map(r => r.judge?.faithfulness)),
      completeness: mean(rows.map(r => r.judge?.completeness)),
      clarity: mean(rows.map(r => r.judge?.clarity))
    },
    counts: {
      grounded: boolN(rows.map(r => r.grounded)),
      pathGrounded: boolN(rows.map(r => r.pathGrounded)),
      whyRate: boolN(rows.map(r => r.why)),
      hypeFree: boolN(rows.map(r => r.hypeFree)),
      titleLenOk: boolN(rows.map(r => r.titleLenOk)),
      audienceAgree: boolN(rows.map(r => r.audienceAgree)),
      sigAgree: boolN(rows.map(r => r.sigAgree)),
      mustMention: numN(rows.map(r => r.mustMention)),
      structuredUsed: boolN(rows.map(r => r.structuredCited)),
      withEvidence: boolN(rows.map(r => r.hasEvidence)),
      withUnknowns: boolN(rows.map(r => r.hasUnknowns)),
      lowConfidence: rows.filter(r => r.confidence).length,
      judge: numN(rows.map(r => r.judge?.faithfulness))
    }
  }
}

export async function runEval (entries, dataDir, env, { repoDir = null, getPatch, getFullPatch = null, limit = 0, judge = true, concurrency = 3 } = {}) {
  const golden = await readJson(`${dataDir}/eval/golden.json`, null)
  if (!golden?.rows?.length) throw new Error('data/eval/golden.json missing or empty: run `eval --seed 40` first')
  const bySha = new Map(entries.map(e => [e.sha, e]))
  const targets = golden.rows.map(r => ({ golden: r, entry: bySha.get(r.sha) })).filter(t => t.entry).slice(0, limit > 0 ? limit : undefined)
  const prIndex = await loadPrIndex(dataDir)
  const byDay = groupEntriesByDay(entries)
  const posIndex = new Map(entries.map((x, i) => [x.sha, i]))
  const ctxCache = new Map()
  const glossary = formatGlossary(await loadGlossary(dataDir))
  const rows = []
  const outputs = {}
  await pool(targets.map(({ golden: g, entry: e }) => async () => {
    try {
      const patch = await getPatch(e)
      if (!patch) { log(`[eval] ${e.sha.slice(0, 8)}: no patch, skipped`); return }
      const fullPatch = getFullPatch ? await getFullPatch(e).catch(() => '') : ''
      const hit = bumpOnly(e) ? getReleaseContextFor(entries, e, posIndex, ctxCache) : null
      const relText = hit?.text || ''
      const context = await gatherEntryContext(e, patch, { repoDir, entries, fullPatch })
      const probe = { ...e, structured: context.structured }
      const { record } = await summarizeEntry({ entry: probe, patch, relText, sequence: sequenceForEntry(byDay, e, 25), prMeta: findPrMeta(e, prIndex), glossary, context, env })
      const score = scoreRow(probe, record, g)
      if (judge) {
        try {
          score.judge = await callLlm(buildJudgePrompt(e, patch, record, g), { ...env, LLM_MODEL: env.LLM_JUDGE_MODEL || env.LLM_VERIFY_MODEL || env.LLM_MODEL }, 1, validateJudgeOut)
        } catch (err) { log(`[eval] judge failed for ${e.sha.slice(0, 8)}: ${err.message}`) }
      }
      rows.push(score)
      outputs[e.sha] = record
      log(`[eval] ${e.sha.slice(0, 8)} grounded=${score.grounded} why=${score.why} hypeFree=${score.hypeFree}${score.judge ? ` judge=${score.judge.faithfulness}/${score.judge.completeness}/${score.judge.clarity}` : ''}`)
    } catch (err) {
      log(`[eval] ${e.sha.slice(0, 8)} failed: ${err.message}`)
      rows.push({ sha: e.sha, failed: true, error: String(err.message).slice(0, 200) })
    }
  }), concurrency)
  const scored = rows.filter(r => !r.failed)
  const report = {
    promptV: PROMPT_V,
    rollupV: RELEASE_ROLLUP_V,
    model: env.LLM_MODEL || '',
    modelMajor: env.LLM_MODEL_MAJOR || '',
    at: new Date().toISOString(),
    golden: { total: golden.rows.length, verified: golden.rows.filter(r => r.verified).length, evaluated: scored.length, failed: rows.length - scored.length },
    metrics: aggregate(scored),
    rows,
    outputs
  }
  const dir = `${dataDir}/eval/results`
  await mkdir(dir, { recursive: true })
  const previous = await latestResult(dir)
  // Zero-padded so `010-…` sorts after `009-…` once the prompt reaches v10.
  await writeJson(`${dir}/${String(PROMPT_V).padStart(3, '0')}-${report.at.replace(/[:.]/g, '-')}.json`, report)
  report.previous = previous ? { promptV: previous.promptV, at: previous.at, model: previous.model, metrics: previous.metrics } : null
  return report
}

export async function latestResult (dir) {
  if (!existsSync(dir)) return null
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  if (!files.length) return null
  // Newest by the run's own timestamp, not by filename, so older unpadded
  // names and newer padded ones compare correctly.
  const docs = (await Promise.all(files.map(f => readJson(`${dir}/${f}`, null)))).filter(Boolean)
  docs.sort((a, b) => String(a.at || '') < String(b.at || '') ? 1 : -1)
  return docs[0] || null
}

const pct = (v) => (v == null ? '   -' : `${String(Math.round(v * 100)).padStart(3)}%`)
const num = (v) => (v == null ? '  -' : v.toFixed(2))

export function formatEvalReport (r) {
  const p = r.previous?.metrics
  const c = r.metrics.counts || {}
  // n= shows only when a metric scored fewer rows than the run: a rate over
  // 1 of 40 rows reads exactly like a rate over 40 unless you say otherwise.
  const line = (label, cur, prev, fmt = pct, n = null) => {
    const d = cur != null && prev != null ? cur - prev : null
    const delta = d == null ? '' : `  (${d >= 0 ? '+' : ''}${fmt === pct ? `${Math.round(d * 100)}pt` : d.toFixed(2)})`
    const part = n != null && n !== r.metrics.n ? `  n=${n}` : ''
    return `  ${label.padEnd(20)} ${fmt(cur)}${p ? `   prev ${fmt(prev)}${delta}` : ''}${part}`
  }
  const m = r.metrics
  const out = [
    `[eval] prompt v${r.promptV} · model ${r.model}${r.modelMajor ? ` (+${r.modelMajor} for heavy rows)` : ''} · ${r.golden.evaluated}/${r.golden.total} rows (${r.golden.verified} human-verified, ${r.golden.failed} failed)`,
    r.previous ? `       compared with prompt v${r.previous.promptV} run at ${r.previous.at}` : '       no previous run to compare with',
    line('grounded', m.grounded, p?.grounded, pct, c.grounded),
    line('path grounded', m.pathGrounded, p?.pathGrounded, pct, c.pathGrounded),
    line('why visible', m.whyRate, p?.whyRate, pct, c.whyRate),
    line('hype free', m.hypeFree, p?.hypeFree, pct, c.hypeFree),
    line('title <= 70', m.titleLenOk, p?.titleLenOk, pct, c.titleLenOk),
    line('with evidence', m.withEvidence, p?.withEvidence, pct, c.withEvidence),
    line('with unknowns', m.withUnknowns, p?.withUnknowns, pct, c.withUnknowns),
    line('low confidence', m.lowConfidence, p?.lowConfidence, pct, c.lowConfidence),
    line('structured cited', m.structuredUsed, p?.structuredUsed, pct, c.structuredUsed),
    line('must-mention', m.mustMention, p?.mustMention, pct, c.mustMention),
    line(`audience agree${m.verifiedN ? ` (${m.verifiedN}v)` : '*'}`, m.audienceAgree, p?.audienceAgree, pct, c.audienceAgree),
    line(`significance agree${m.verifiedN ? ` (${m.verifiedN}v)` : '*'}`, m.sigAgree, p?.sigAgree, pct, c.sigAgree)
  ]
  if (m.judge.faithfulness != null) {
    out.push(line('judge faithfulness', m.judge.faithfulness, p?.judge?.faithfulness, num, c.judge), line('judge completeness', m.judge.completeness, p?.judge?.completeness, num, c.judge), line('judge clarity', m.judge.clarity, p?.judge?.clarity, num, c.judge))
  }
  out.push(`  * golden labels; ${m.verifiedN} of ${r.metrics.n} rows human-verified (v), the rest scored against seeded labels for regression`)
  const bad = r.rows.filter(x => !x.failed && (!x.grounded || !x.hypeFree || x.pathGrounded === false)).slice(0, 10)
  if (bad.length) {
    out.push('  rows to look at:')
    for (const x of bad) out.push(`    ${x.sha.slice(0, 8)}${x.ungrounded?.length ? ` ungrounded: ${x.ungrounded.slice(0, 3).join(', ')}` : ''}${!x.pathGrounded ? ' evidence names an unlisted path' : ''}${!x.hypeFree ? ' hype' : ''}`)
  }
  return out.join('\n')
}
