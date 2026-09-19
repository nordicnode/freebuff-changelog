import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readJson, writeJson, pool, log } from '../generator/lib/util.mjs'
import {
  buildPrPrompt, callLlm, prSummaryKey, PR_PROMPT_V,
  FREEBUFF_ARCHITECTURE_MAP, summaryValidator
} from '../generator/lib/llm.mjs'
import { buildSite } from '../generator/lib/site.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DATA = resolve(ROOT, 'data')

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(resolve(ROOT, '.env')) } catch {}
}

const env = process.env
const GITHUB_TOKEN = env.GITHUB_TOKEN

async function main () {
  log(`[regenerate-prs] Starting regeneration of all open PRs (PR_PROMPT_V=${PR_PROMPT_V})...`)

  const prsData = await readJson(`${DATA}/open-prs.json`, null)
  const prs = prsData?.prs || (Array.isArray(prsData) ? prsData : [])
  if (!prs.length) {
    log('[regenerate-prs] No open PRs found in data/open-prs.json')
    return
  }

  log(`[regenerate-prs] Found ${prs.length} open PRs.`)

  // 1. Fetch full diffs for all PRs from GitHub
  const diffDir = resolve(DATA, 'pr-diffs')
  await mkdir(diffDir, { recursive: true })

  let diffsFetched = 0
  log('[regenerate-prs] Fetching complete diffs from GitHub API...')
  await pool(prs.map(pr => async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/CodebuffAI/freebuff/pulls/${pr.number}`, {
        headers: {
          'accept': 'application/vnd.github.diff',
          'user-agent': 'freebuff-changelog',
          ...(GITHUB_TOKEN ? { 'authorization': `Bearer ${GITHUB_TOKEN}` } : {})
        }
      })
      if (res.ok) {
        const diff = await res.text()
        if (diff.startsWith('diff --git')) {
          await writeFile(resolve(diffDir, `${pr.number}.diff`), diff)
          pr.hasDiff = true
          diffsFetched++
        }
      }
    } catch (err) {
      log(`[diff] Failed to fetch diff for #${pr.number}: ${err.message}`)
    }
  }), 6)
  log(`[regenerate-prs] Downloaded full diffs for ${diffsFetched} PRs.`)

  // 2. Summarize each PR with DeepSeek v4.1 using the full diff prompt
  const cachePath = `${DATA}/pr-summaries.json`
  const cache = await readJson(cachePath, {})

  let completed = 0
  let failed = 0
  const total = prs.length

  // Process newest first
  const sorted = [...prs].sort((a, b) => String(b.updated || '') < String(a.updated || '') ? -1 : 1)

  await pool(sorted.map((pr, index) => async () => {
    const diff = await readFile(resolve(diffDir, `${pr.number}.diff`), 'utf8').catch(() => '')
    const key = prSummaryKey(pr, diff)

    // If already generated on v2 for this exact diff, keep it
    if (cache[key] && !cache[key].error && cache[key].v === PR_PROMPT_V) {
      completed++
      log(`[${completed + failed}/${total}] #${pr.number} already current: "${cache[key].title}"`)
      return
    }

    const corpus = [diff, pr.title, pr.body, ...(pr.commitsList || []).map(c => c.message || '')].filter(Boolean).join('\n')
    const prompt = buildPrPrompt(pr, diff, { architectureMap: FREEBUFF_ARCHITECTURE_MAP })

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const clean = await callLlm(prompt, env, 1, summaryValidator('minor', corpus))
        cache[key] = {
          model: env.LLM_MODEL || 'deepseek-v4.1',
          v: PR_PROMPT_V,
          title: clean.title,
          summary: clean.summary,
          significance: clean.significance,
          ...(clean.audience ? { audience: clean.audience } : {}),
          ...(clean.ungrounded ? { ungrounded: clean.ungrounded } : {}),
          at: new Date().toISOString()
        }
        completed++
        log(`[${completed + failed}/${total}] ✔ #${pr.number}: "${clean.title}"`)
        await writeJson(cachePath, cache)
        return
      } catch (err) {
        if (attempt === 4) {
          failed++
          log(`[${completed + failed}/${total}] ✖ #${pr.number} failed after 4 attempts: ${err.message}`)
          cache[key] = { error: String(err.message).slice(0, 200), at: new Date().toISOString() }
          return
        }
        const waitMs = 2000 * Math.pow(2, attempt - 1)
        await new Promise(r => setTimeout(r, waitMs))
      }
    }
  }), 2)

  // Final cache write
  await writeJson(cachePath, cache)
  log(`[regenerate-prs] Finished LLM generation: ${completed} succeeded, ${failed} failed.`)

  // 3. Rebuild static site
  log('[regenerate-prs] Building site with new PR summaries...')
  const changelog = await readJson(`${DATA}/changelog.json`, null)
  const dist = resolve(ROOT, 'dist')
  await buildSite({ changelog, openPrs: prs, dist })
  log('[regenerate-prs] All done!')
}

main().catch(err => {
  console.error('[fatal]', err)
  process.exit(1)
})
