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

// Short content fingerprint for cache keys. Both LLM passes use it, and the
// changelog merge uses it to tell whether an ELI5 line still describes the
// summary it was written from -- which is why it lives here, not in llm.mjs
// (mergedata must not import the module that imports it).
export function shortHash (text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12)
}

// The text an ELI5 line is an explanation *of*. Lives here rather than in
// llm.mjs because the changelog merge has to recompute it to tell whether an
// incoming ELI5 still matches the summary that survived the merge, and mergedata
// must not import the module that imports it.
export function eli5Source (e) {
  return `${e.ai?.title || ''}\n${e.ai?.summary || ''}`
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

// Day/month keys are taken straight from the stored timestamp, so they are only
// UTC-safe once every date has been through toUtc() (see below).
export function ymd (iso) { return iso.slice(0, 10) }

// Committer dates arrive in whatever zone the author's machine was in: `%cI`
// yields `2025-11-24T17:25:50-08:00`, and a third of this repository's commits
// were authored on a -07:00/-08:00 box. Every comparison downstream is either a
// string compare or a `slice(0, 10)`, both of which silently ignore the offset
// -- so a commit at 17:25-08:00 (01:25Z the next day) landed on the wrong day
// page and in the wrong release window. Normalize once, at the boundary.
export function toUtc (iso) {
  if (typeof iso !== 'string' || !iso) return iso
  if (/[Zz]$/.test(iso)) return iso
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toISOString()
}
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

/**
 * Exclusive worktree lock. The backfill daemon and a manual `npm run generate`
 * share one checkout and the same derived files, so overlapping runs would race
 * on git state (a pull --rebase cannot run over the other's half-written data/).
 *
 * mkdir is atomic. Staleness is decided by the owner's *liveness*, not the
 * clock: a run killed by Ctrl+C or `pkill` leaves the directory behind with a
 * fresh mtime, and an mtime window meant the daemon logged "another run holds
 * the lock" for half an hour after every restart while publishing nothing. A
 * live owner still waits, because a long LLM batch legitimately holds it.
 */
export async function withLock (lockDir, fn, { retries = 2 } = {}) {
  const { mkdir, rm, readFile, writeFile } = await import('node:fs/promises')
  let acquired = false
  for (let attempt = 0; attempt <= retries && !acquired; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false })
      await writeFile(`${lockDir}/owner`, `${process.pid} ${new Date().toISOString()}\n`).catch(() => {})
      heldHere.add(lockDir)
      acquired = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const owner = await readFile(`${lockDir}/owner`, 'utf8').catch(() => '')
      const pid = Number(/^\s*(\d+)/.exec(owner)?.[1]) || 0
      // Same pid is only "ours" if this process is not currently inside the
      // critical section -- two overlapping runs in one process must still
      // serialize, and a pid cannot be reused while its process is alive.
      if (heldHere.has(lockDir) || (pid && isPidAlive(pid) && pid !== process.pid)) {
        log(`lock ${lockDir} held by ${heldHere.has(lockDir) ? 'this run' : `live pid ${pid}`}: skipping`)
        break
      }
      log(pid
        ? `taking over lock ${lockDir}: owner pid ${pid} is gone`
        : `taking over lock ${lockDir} with no live owner recorded`)
      await rm(lockDir, { recursive: true, force: true })
      continue
    }
  }
  if (!acquired) return { acquired: false }
  try {
    return { acquired: true, result: await fn() }
  } finally {
    heldHere.delete(lockDir)
    await rm(lockDir, { recursive: true, force: true })
  }
}

/** Locks this process currently holds, so overlapping runs in one process serialize. */
const heldHere = new Set()

function isPidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
}

/**
 * Retention: a stored diff lives exactly as long as its entry. Age-based
 * retention is what left rows advertising a diff that had been deleted (58 of
 * them, each toggle fetching a 404), and now that every entry -- community
 * commits and churn rows included -- has a diff on disk, "delete anything older
 * than N days" contradicts the site's own promise. The only thing allowed to go
 * is a file no entry references any more.
 *
 * Callers run this *before* refreshing the hasDiff flags, so a deleted file
 * cannot survive the write as a toggle that leads nowhere.
 */
export async function pruneDiffs (diffDir, entries) {
  const { readdir, unlink } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  if (!existsSync(diffDir)) return 0
  const shas = new Set(entries.map(e => e.sha))
  let pruned = 0
  for (const f of await readdir(diffDir)) {
    if (!f.endsWith('.diff')) continue
    if (!shas.has(f.slice(0, -5))) {
      await unlink(`${diffDir}/${f}`)
      pruned++
    }
  }
  if (pruned > 0) log(`pruned ${pruned} orphaned diffs (no matching entry)`)
  return pruned
}
// Bring one entry's timestamp, and the day/month keys cut from it, into UTC.
// Idempotent, so it is safe to run over the whole corpus on every merge.
// Bring one entry's timestamp, and the day/month keys cut from it, into UTC.
// A row that is already UTC is left strictly untouched -- the writers compare
// before and after to decide whether anything changed, so a no-op must not
// rewrite a field that was never there.
export function normalizeDate (e) {
  if (!e || typeof e.date !== 'string') return e
  const date = toUtc(e.date)
  if (date === e.date) return e
  e.date = date
  const day = ymd(date)
  if (e.day !== undefined) e.day = day
  if (e.month !== undefined) e.month = day.slice(0, 7)
  return e
}
