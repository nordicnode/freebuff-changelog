// scripts/regenerate-last-20.mjs - Regenerates the last N (default 20) changelog
// entries through the same code path the daemon uses: gatherEntryContext,
// summarizeEntry (grounding repair, optional verifier) and explainEntry. The
// script used to carry its own copy of the worker body; it drifted, so now it
// only selects targets, writes cache records and saves.
//
//   node scripts/regenerate-last-20.mjs [--count N] [--concurrency N]
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { git, readJson, writeJson, writeText, log, pool, shortHash, eli5Source } from '../generator/lib/util.mjs'
import { extractCleanDiff, discoverMonorepoArchitecture, formatArchitectureMap, EMPTY_TREE } from '../generator/lib/analyze.mjs'
import {
  findPrMeta,
  loadPrIndex,
  groupEntriesByDay,
  sequenceForEntry,
  bumpOnly,
  getReleaseContextFor,
  cacheKey,
  eli5Key,
  RELEASE_ROLLUP_V,
  gatherEntryContext,
  summarizeEntry,
  explainEntry,
  templateEli5,
  ELI5_V
} from '../generator/lib/llm.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(resolve(ROOT, '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(resolve(ROOT, '.env'))
}
const DATA = resolve(ROOT, 'data')
const CACHE = resolve(ROOT, '.cache')
const REPO_DIR = resolve(CACHE, 'freebuff')

function argNum (name, dflt) {
  const at = process.argv.indexOf(name)
  return at !== -1 && Number(process.argv[at + 1]) > 0 ? Number(process.argv[at + 1]) : dflt
}

async function baseShaFor (e) {
  if (e.prevSha) return e.prevSha
  const parent = (await git(['rev-parse', '--verify', '--quiet', `${e.sha}^`], REPO_DIR, { allowFail: true }))?.trim()
  return parent || EMPTY_TREE
}

async function main () {
  const env = process.env
  if (!env.LLM_API_KEY) throw new Error('LLM_API_KEY is required in .env')
  const count = argNum('--count', 20)
  const concurrency = argNum('--concurrency', 3)

  log('Loading changelog data and PR index...')
  const doc = await readJson(`${DATA}/changelog.json`, null)
  if (!doc?.entries?.length) throw new Error('data/changelog.json missing')
  const aiCache = await readJson(`${DATA}/ai-summaries.json`, {})
  const prIndex = await loadPrIndex(DATA)
  const byDayEntries = groupEntriesByDay(doc.entries)
  const archMap = formatArchitectureMap(await discoverMonorepoArchitecture(REPO_DIR))
  const posIndex = new Map(doc.entries.map((x, i) => [x.sha, i]))
  const ctxCache = new Map()
  const releaseOf = (e) => getReleaseContextFor(doc.entries, e, posIndex, ctxCache)

  const targets = doc.entries.filter(e => !e.noise).slice(-count)
  log(`Selected ${targets.length} entries for regeneration (${targets[0].sha.slice(0, 8)} .. ${targets[targets.length - 1].sha.slice(0, 8)})`)

  let completed = 0
  let failed = 0

  async function processEntry (e, index) {
    const num = index + 1
    const short = e.sha.slice(0, 8)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const base = await baseShaFor(e)
        let patch = await extractCleanDiff(REPO_DIR, base, e.sha, 250000, !e.testOnly, 25)
        if (!patch.trim() && !e.testOnly) patch = await extractCleanDiff(REPO_DIR, base, e.sha, 250000, false, 25)
        if (patch.trim()) await writeText(`${DATA}/diffs/${e.sha}.diff`, patch)

        const hit = bumpOnly(e) ? releaseOf(e) : null
        const relText = hit?.text || ''
        const sequence = sequenceForEntry(byDayEntries, e, 25)
        const prMeta = findPrMeta(e, prIndex)
        const context = await gatherEntryContext(e, patch, { repoDir: REPO_DIR, entries: doc.entries })
        log(`[${num}/${targets.length}] ${short}: tier ${context.tier}, ${context.fileHeaders.length} headers, ${context.fileHistory.length} history, ${context.fullFiles.length} full files, ${context.exportOutlines.length} outlines, ${context.subsystemDocs.length} docs, diff ${patch.length} bytes, PR #${prMeta?.number || 'none'}`)

        // 1. Technical summary
        const { record } = await summarizeEntry({ entry: e, patch, relText, sequence, prMeta, archMap, context, env })
        aiCache[cacheKey(e.sha, patch, relText, relText ? RELEASE_ROLLUP_V : 0)] = record
        e.ai = { ...record }

        // 2. Plain English (template rows need no call)
        const src = eli5Source(e)
        const tpl = !relText ? templateEli5(e) : null
        if (tpl) {
          e.eli5 = { text: tpl, model: 'template', v: ELI5_V, src: shortHash(src), at: new Date().toISOString() }
        } else {
          const { record: eRecord } = await explainEntry({
            entry: e,
            patch,
            siblings: (byDayEntries.get(e.day) || []).filter(t => t.sha !== e.sha).map(t => t.ai?.title || t.title).slice(0, 15),
            relText,
            prMeta,
            sequence,
            archMap,
            context,
            env
          })
          aiCache[eli5Key(e.sha, src, relText, relText ? RELEASE_ROLLUP_V : 0)] = eRecord
          e.eli5 = { ...eRecord, src: shortHash(src) }
        }

        completed++
        log(`✔ [${num}/${targets.length}] ${short}: "${e.ai.title}"${record.ungrounded ? ` (ungrounded: ${record.ungrounded.join(', ')})` : ''}`)
        await writeJson(`${DATA}/ai-summaries.json`, aiCache)
        await writeJson(`${DATA}/changelog.json`, doc)
        return
      } catch (err) {
        log(`⚠ [${num}/${targets.length}] attempt ${attempt} failed for ${short}: ${err.message}`)
        if (attempt === 3) { failed++; return }
        await new Promise(r => setTimeout(r, 4000 * attempt))
      }
    }
  }

  await pool(targets.map((e, idx) => () => processEntry(e, idx)), concurrency)
  await writeJson(`${DATA}/ai-summaries.json`, aiCache)
  await writeJson(`${DATA}/changelog.json`, doc)
  log(`Batch finished: ${completed} succeeded, ${failed} failed.`)
}

main().catch(err => {
  console.error('Fatal error during regeneration:', err)
  process.exit(1)
})
