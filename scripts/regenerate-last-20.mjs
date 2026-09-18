// scripts/regenerate-last-20.mjs - Regenerates the last 20 changelog entries
// with the enhanced pipeline: -U25 diffs, module headers, PR descriptions,
// sequence window 25, domain lexicon, and anti-hallucination constraints.
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { git, readJson, writeJson, writeText, log, pool, shortHash, eli5Source } from '../generator/lib/util.mjs'
import {
  extractCleanDiff,
  extractFileHeaders,
  discoverMonorepoArchitecture,
  formatArchitectureMap,
  EMPTY_TREE
} from '../generator/lib/analyze.mjs'
import {
  buildPrompt,
  buildEli5Prompt,
  validateLlmOut,
  normalizeEli5,
  eli5Notes,
  findPrMeta,
  loadPrIndex,
  groupEntriesByDay,
  sequenceForEntry,
  bumpOnly,
  collectReleaseContext,
  formatReleaseContext,
  cacheKey,
  eli5Key,
  PROMPT_V,
  ELI5_V,
  RELEASE_ROLLUP_V,
  ELI5_ROLLUP_MAX_CHARS,
  ELI5_MAX_CHARS,
  callLlm
} from '../generator/lib/llm.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(resolve(ROOT, '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(resolve(ROOT, '.env'))
}
const DATA = resolve(ROOT, 'data')
const CACHE = resolve(ROOT, '.cache')
const REPO_DIR = resolve(CACHE, 'freebuff')

async function baseShaFor (e) {
  if (e.prevSha) return e.prevSha
  const parent = (await git(['rev-parse', '--verify', '--quiet', `${e.sha}^`], REPO_DIR, { allowFail: true }))?.trim()
  return parent || EMPTY_TREE
}

async function main () {
  const env = process.env
  if (!env.LLM_API_KEY) {
    throw new Error('LLM_API_KEY is required in .env')
  }

  log('Loading changelog data and PR index...')
  const doc = await readJson(`${DATA}/changelog.json`, null)
  if (!doc?.entries?.length) throw new Error('data/changelog.json missing')
  const aiCache = await readJson(`${DATA}/ai-summaries.json`, {})
  const prIndex = await loadPrIndex(DATA)
  const byDayEntries = groupEntriesByDay(doc.entries)
  const archMap = formatArchitectureMap(await discoverMonorepoArchitecture(REPO_DIR))

  const posIndex = new Map(doc.entries.map((x, i) => [x.sha, i]))
  const ctxCache = new Map()
  const releaseOf = (e) => {
    if (!bumpOnly(e)) return null
    let hit = ctxCache.get(e.sha)
    if (!hit) {
      const ctx = collectReleaseContext(doc.entries, e, { index: posIndex })
      hit = { ctx, text: formatReleaseContext(ctx, e) }
      ctxCache.set(e.sha, hit)
    }
    return hit.text ? hit : null
  }

  // Select last 20 meaningful entries
  const meaningful = doc.entries.filter(e => !e.noise)
  const targets = meaningful.slice(-20)
  log(`Selected ${targets.length} entries for regeneration (from ${targets[0].sha.slice(0, 8)} to ${targets[targets.length - 1].sha.slice(0, 8)})`)

  let completedCount = 0
  let failedCount = 0

  async function processEntry(e, index) {
    const num = index + 1
    const short = e.sha.slice(0, 8)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`[${num}/${targets.length}] Preparing context for ${short} (${e.date.slice(0, 10)})...`)
        const base = await baseShaFor(e)
        let patch = await extractCleanDiff(REPO_DIR, base, e.sha, 250000, !e.testOnly, 25)
        if (!patch.trim() && !e.testOnly) {
          patch = await extractCleanDiff(REPO_DIR, base, e.sha, 250000, false, 25)
        }
        if (patch.trim()) {
          await writeText(`${DATA}/diffs/${e.sha}.diff`, patch)
        }

        const files = [...(e.files?.modified || []), ...(e.files?.added || [])]
        const fileHeaders = await extractFileHeaders(REPO_DIR, e.sha, files)
        const sequence = sequenceForEntry(byDayEntries, e, 25)
        const prMeta = findPrMeta(e, prIndex)
        const hit = bumpOnly(e) ? releaseOf(e) : null
        const relText = hit?.text || ''

        log(`[${num}/${targets.length}] ${short}: ${fileHeaders.length} headers, diff ${patch.length} bytes, PR #${prMeta?.number || 'none'}`)

        // 1. Technical summary pass
        const summaryPrompt = buildPrompt(e, patch, {
          releaseCtx: relText,
          sequence,
          prMeta,
          architectureMap: archMap,
          fileHeaders
        })
        log(`[${num}/${targets.length}] Calling LLM for summary: ${short}...`)
        const rawSummary = await callLlm(summaryPrompt, env)
        const cleanSummary = validateLlmOut(rawSummary, e.significance || 'minor')

        // Attach to entry in-memory for ELI5 pass
        const sKey = cacheKey(e.sha, patch, relText, relText ? RELEASE_ROLLUP_V : 0)
        aiCache[sKey] = {
          model: env.LLM_MODEL || 'gpt-4o-mini',
          v: PROMPT_V,
          title: cleanSummary.title,
          summary: cleanSummary.summary,
          significance: cleanSummary.significance,
          ...(cleanSummary.evidence ? { evidence: cleanSummary.evidence } : {}),
          ...(relText ? { ctx: shortHash(relText), rollup: RELEASE_ROLLUP_V } : {}),
          at: new Date().toISOString()
        }
        e.ai = { ...aiCache[sKey] }

        // 2. Plain-English ELI5 pass
        const notes = eli5Notes(e, patch)
        const eli5Prompt = buildEli5Prompt(e, notes, {
          patch,
          siblings: (byDayEntries.get(e.day) || []).filter(t => t.sha !== e.sha).map(t => t.ai?.title || t.title).slice(0, 15),
          diffBytes: 60000,
          releaseCtx: relText,
          prMeta,
          sequence,
          architectureMap: archMap,
          fileHeaders
        })
        log(`[${num}/${targets.length}] Calling LLM for ELI5: ${short}...`)
        const rawEli5 = await callLlm(
          eli5Prompt,
          env,
          1,
          (out) => normalizeEli5(out, relText ? ELI5_ROLLUP_MAX_CHARS : ELI5_MAX_CHARS)
        )

        const src = eli5Source(e)
        const eKey = eli5Key(e.sha, src, relText, relText ? RELEASE_ROLLUP_V : 0)
        aiCache[eKey] = {
          model: env.LLM_MODEL || 'gpt-4o-mini',
          v: ELI5_V,
          text: rawEli5,
          ...(relText ? { ctx: shortHash(relText), rollup: RELEASE_ROLLUP_V } : {}),
          at: new Date().toISOString()
        }
        e.eli5 = {
          text: rawEli5,
          model: env.LLM_MODEL || 'gpt-4o-mini',
          v: ELI5_V,
          src: shortHash(src),
          ...(relText ? { ctx: shortHash(relText), rollup: RELEASE_ROLLUP_V } : {}),
          at: new Date().toISOString()
        }

        completedCount++
        log(`✔ [${num}/${targets.length}] (${completedCount}/${targets.length}) ${short} done: "${e.ai.title}"`)

        // Incremental save
        await writeJson(`${DATA}/ai-summaries.json`, aiCache)
        await writeJson(`${DATA}/changelog.json`, doc)
        return { sha: e.sha, title: e.ai.title, eli5: e.eli5.text }
      } catch (err) {
        log(`⚠ [${num}/${targets.length}] Attempt ${attempt} failed for ${short}: ${err.message}`)
        if (attempt === 3) {
          failedCount++
          log(`✖ [${num}/${targets.length}] Giving up on ${short} after 3 attempts.`)
          return null
        }
        await new Promise(r => setTimeout(r, 4000 * attempt))
      }
    }
  }

  // Run with concurrency of 3 to be gentle on the gateway tunnel
  const concurrency = 3
  const tasks = targets.map((e, idx) => () => processEntry(e, idx))
  await pool(tasks, concurrency)

  log(`Writing final data to disk...`)
  await writeJson(`${DATA}/ai-summaries.json`, aiCache)
  await writeJson(`${DATA}/changelog.json`, doc)
  log(`Batch finished: ${completedCount} succeeded, ${failedCount} failed.`)
}

main().catch(err => {
  console.error('Fatal error during regeneration:', err)
  process.exit(1)
})
