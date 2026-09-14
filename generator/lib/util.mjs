// generator/lib/util.mjs - small shared helpers, zero dependencies.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const US = '\x1f'
export const RS = '\x1e'

export function sha256 (text) {
  return createHash('sha256').update(text).digest('hex')
}

export async function git (args, cwd, opts = {}) {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
      ...opts
    })
    return stdout
  } catch (err) {
    if (opts.allowFail) return null
    throw err
  }
}

export async function readJson (path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJson (path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, JSON.stringify(value, null, 2) + '\n')
}

// changelog.json is ~10MB and two processes read it while another writes it
// (build, git add). A truncated read parses as nothing at all, so writes land
// via a rename, which is atomic within a filesystem.
async function writeAtomic (path, data) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function writeText (path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

export async function writeBinary (path, buf) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buf)
}

export function escapeHtml (s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function truncate (s, n) {
  s = String(s)
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

// UTC-safe date helpers (avoid TZ surprises: everything in this pipeline is UTC).
export function ymd (iso) { return iso.slice(0, 10) }
export function monthKey (iso) { return iso.slice(0, 7) }
export function isoDate (d) { return d.toISOString() }

export function fmtDateHuman (iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = ymd(iso).split('-')
  return `${months[Number(m) - 1]} ${Number(d)}, ${y}`
}

export function log (...args) {
  console.log('[changelog]', ...args)
}

// Bounded worker pool for independent async tasks. Returns results in order.
export async function pool (tasks, n = 8) {
  const out = new Array(tasks.length)
  let i = 0
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) {
      const k = i++
      out[k] = await tasks[k]()
    }
  })
  await Promise.all(workers)
  return out
}

// Exclusive worktree lock. The backfill daemon and a manual `npm run generate`
// share one checkout and the same derived files, so overlapping runs would race
// on git state (a pull --rebase cannot run over the other's half-written data/).
// mkdir is atomic, and a stale lock is taken over so a killed service cannot
// wedge the pipeline until someone notices.
export async function withLock (lockDir, fn, { staleMs = 30 * 60000, retries = 2 } = {}) {
  const { mkdir, rm, stat, writeFile } = await import('node:fs/promises')
  let acquired = false
  for (let attempt = 0; attempt <= retries && !acquired; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false })
      await writeFile(`${lockDir}/owner`, `${process.pid} ${new Date().toISOString()}\n`).catch(() => {})
      acquired = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const held = await stat(lockDir).catch(() => null)
      if (!held || Date.now() - held.mtimeMs <= staleMs) break
      log(`taking over stale lock ${lockDir} (held ${Math.round((Date.now() - held.mtimeMs) / 60000)}m)`)
      await rm(lockDir, { recursive: true, force: true })
    }
  }
  if (!acquired) return { acquired: false }
  try {
    return { acquired: true, result: await fn() }
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

// Retention: delete *.diff files whose entry day is older than the cutoff.
// Day pages degrade to a GitHub compare link when /diffs/<sha>.diff is
// missing (client renders a notice), so pruning only loses inline diffs
// for old entries — the site stays fully navigable.
export async function pruneDiffs (diffDir, entries, retentionDays = 90) {
  const { readdir, unlink } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  if (!existsSync(diffDir)) return 0
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10)
  const dayBySha = new Map()
  for (const e of entries) dayBySha.set(e.sha, e.day)
  let pruned = 0
  for (const f of await readdir(diffDir)) {
    if (!f.endsWith('.diff')) continue
    const day = dayBySha.get(f.slice(0, -5))
    if (day && day < cutoff) {
      await unlink(`${diffDir}/${f}`)
      pruned++
    }
  }
  if (pruned > 0) log(`pruned ${pruned} diffs older than ${cutoff}`)
  return pruned
}
