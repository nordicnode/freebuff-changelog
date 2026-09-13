// generator/lib/util.mjs - small shared helpers, zero dependencies.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
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
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

export async function writeText (path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
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
