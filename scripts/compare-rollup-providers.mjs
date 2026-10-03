// scripts/compare-rollup-providers.mjs - does the dedicated roll-up provider
// write a better day digest than the primary one?
//
//   node scripts/compare-rollup-providers.mjs [days] [--primary-only|--stage-only]
//
// For each of the N newest settled days it asks BOTH providers for the same
// material, records the answer *before* de-duplication (the number that says
// how much a model restates a change on its own), applies the same validator
// both ways get in production, and prints the two digests side by side. Nothing
// is written to data/: this measures, the `rollups` command publishes.
//
// Budgets: the stage route carries its own (20/min, 3 in flight, 500/hour,
// 2,500/day); the primary carries the project contract. 2 calls per day.

import { existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
if (existsSync(resolve(ROOT, '.env')) && typeof process.loadEnvFile === 'function') process.loadEnvFile(resolve(ROOT, '.env'))

const { loadChangelog } = await import('../generator/lib/changelog-store.mjs')
const { callScopedLlm, rollupLlmEnv } = await import('../generator/lib/llm.mjs')
const {
  ROLLUP_MAX_BULLETS, buildRollupPrompt, digestibleMaterial, nearDuplicate,
  rollupInput, validateRollupOut
} = await import('../generator/lib/rollup.mjs')

const argv = process.argv.slice(2)
const daysArg = Number(argv.find(a => /^\d+$/.test(a))) || 3
const primaryOnly = argv.includes('--primary-only')
const stageOnly = argv.includes('--stage-only')
const modelFlag = argv.indexOf('--model')
const modelOverride = modelFlag !== -1 ? argv[modelFlag + 1] : null
// --legacy-prompt: ask with the prompt as it was before v4 (no change count in
// the header, no one-bullet-per-change rules), so the duplicate rate of the old
// behaviour can be measured against the new one on the same days.
const legacyPrompt = argv.includes('--legacy-prompt')

const stageEnv = rollupLlmEnv(process.env)
if (!stageEnv) throw new Error('no day roll-up provider configured (CHANGELOG_ROLLUP_LLM_API_BASE + _API_KEY)')
// --model: try a different model on the same stage route without touching .env.
if (modelOverride) stageEnv.LLM_MODEL = modelOverride
const primaryEnv = { ...process.env }
for (const k of Object.keys(primaryEnv)) if (k.startsWith('CHANGELOG_ROLLUP_LLM_')) delete primaryEnv[k]

const routes = [
  !stageOnly && { name: 'primary', env: primaryEnv },
  !primaryOnly && { name: 'rollup', env: stageEnv }
].filter(Boolean)

// How much of the answer a model wrote twice, before the validator touches it:
// bullets collapsed by near-duplicate clustering, plus any left over after one
// bullet per change. Both are counted on the raw answer, because production
// collapses them -- this is what each provider *wanted* to ship.
function duplicateStats (raw, limit) {
  const clusters = []
  for (const b of raw) {
    const hit = clusters.find(c => c.some(x => nearDuplicate(x, b)))
    if (hit) hit.push(b)
    else clusters.push([b])
  }
  const restatements = raw.length - clusters.length
  const overLimit = Math.max(0, clusters.length - limit)
  // What the validator before v4 would have caught: exact normalized strings
  // only. The gap between the two is what shipped as duplicate bullets.
  const exact = new Set(raw.map(b => String(b).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))
  return { clusters: clusters.length, restatements, overLimit, exactRestatements: raw.length - exact.size, pairs: clusters.filter(c => c.length > 1) }
}

const doc = await loadChangelog(resolve(ROOT, 'data'))
const byDay = new Map()
for (const e of doc?.entries || []) {
  const day = e.day || String(e.date || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
  if (!byDay.has(day)) byDay.set(day, [])
  byDay.get(day).push(e)
}
const today = new Date().toISOString().slice(0, 10)
const pending = [...byDay.entries()]
  .filter(([day]) => day < today)
  .map(([day, entries]) => ({ day, entries, material: digestibleMaterial(entries) }))
  .filter(d => d.material.length > 0)
  .sort((a, b) => (a.day < b.day ? 1 : -1))
  .slice(0, daysArg)

const rows = []
for (const { day, entries, material } of pending) {
  const input = rollupInput(day, entries)
  let prompt = buildRollupPrompt(day, input)
  if (legacyPrompt) {
    prompt = prompt.replace(/, \d+ changes\b/, '').split('\n')
      .filter(l => !/^- One bullet per change, and one change per bullet\./.test(l) && !/^- If the same change appears twice in the material/.test(l))
      .join('\n')
  }
  const limit = Math.min(ROLLUP_MAX_BULLETS, material.length)
  console.log(`\n=== ${day}: ${material.length} change(s), at most ${limit} bullet(s) ===`)
  for (const route of routes) {
    let raw = []
    let kept = []
    const started = Date.now()
    let error = null
    try {
      const res = await callScopedLlm(prompt, route.env, out => {
        raw = Array.isArray(out?.bullets) ? out.bullets : []
        return validateRollupOut(out, { limit })
      }, { stage: 'day-rollup' })
      kept = res.out.bullets
    } catch (err) {
      error = String(err?.message || err).split('\n')[0].slice(0, 160)
    }
    const stats = duplicateStats(raw, limit)
    rows.push({
      day, route: route.name, model: route.env.LLM_MODEL, provider: route.env.LLM_API_BASE,
      ms: Date.now() - started, error, changes: material.length, limit,
      raw: raw.length, restatements: stats.restatements, exactRestatements: stats.exactRestatements, overLimit: stats.overLimit,
      pairs: stats.pairs, kept: kept.length, bullets: kept, rawBullets: raw
    })
    const line = error
      ? `  ${route.name.padEnd(7)} FAILED: ${error}`
      :      `  ${route.name.padEnd(7)} ${route.env.LLM_MODEL} @ ${route.env.LLM_API_BASE}  raw ${raw.length}, restated ${stats.restatements} (old rule would have let ${stats.exactRestatements} through), over the limit ${stats.overLimit} -> kept ${kept.length} (${Date.now() - started}ms)`
    console.log(line)
    for (const pair of stats.pairs) console.log(`      dup pair: "${pair[0]}" | "${pair.slice(1).join('" | "')}"`)
  }
}

// ---------------------------------------------------------------------------------
const by = (name) => rows.filter(r => r.route === name)
const agg = (name) => {
  const rs = by(name)
  return {
    calls: rs.length,
    failed: rs.filter(r => r.error).length,
    raw: rs.reduce((n, r) => n + r.raw, 0),
    restatements: rs.reduce((n, r) => n + r.restatements, 0),
    exactRestatements: rs.reduce((n, r) => n + r.exactRestatements, 0),
    overLimit: rs.reduce((n, r) => n + r.overLimit, 0),
    kept: rs.reduce((n, r) => n + r.kept, 0),
    changes: rs.reduce((n, r) => n + r.changes, 0)
  }
}

const md = []
md.push('# Day roll-up: primary provider vs dedicated roll-up provider', '')
md.push(`Generated ${new Date().toISOString()} over ${pending.map(p => p.day).join(', ')}${legacyPrompt ? ' (legacy prompt: the rules added in v4 removed)' : ''}.`, '')
md.push('`raw` is the answer before de-duplication; `restated` counts bullets that say the same change as an earlier bullet under the v4 rule; `old` counts only exact-string repeats, which is what the validator before v4 would have let through; `over` counts bullets beyond one per change.', '')
md.push('| route | model @ provider | calls | failed | raw | restated | old | over | kept | changes |')
md.push('|---|---|---|---|---|---|---|---|---|---|')
for (const name of routes.map(r => r.name)) {
  const a = agg(name)
  const r = by(name)[0]
  md.push(`| ${name} | \`${r?.model || '-'}\` @ \`${r?.provider || '-'}\` | ${a.calls} | ${a.failed} | ${a.raw} | ${a.restatements} | ${a.exactRestatements} | ${a.overLimit} | ${a.kept} | ${a.changes} |`)
}
md.push('')
for (const { day } of pending) {
  md.push(`## ${day}`, '')
  for (const r of rows.filter(x => x.day === day)) {
    md.push(`### ${r.route} (${r.model})`, '')
    if (r.error) md.push(`FAILED: ${r.error}`, '')
    for (const b of r.bullets) md.push(`- ${b}`)
    md.push('')
  }
}
await mkdir(resolve(ROOT, 'reports'), { recursive: true })
const outPath = resolve(ROOT, 'reports', `rollup-providers-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
await writeFile(outPath, md.join('\n') + '\n')
console.log(`\nreport: ${outPath}`)
