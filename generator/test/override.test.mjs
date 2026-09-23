// generator/test/override.test.mjs - the human-correction authoring helper and
// the shared dynamic route handler the preview server and worker.js both use.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cmdOverride, dynamicRoute } from '../cli.mjs'

const tmpData = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-override-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const entry = (sha) => ({
  sha,
  date: '2026-09-12T10:00:00Z',
  day: '2026-09-12',
  category: 'CLI',
  significance: 'minor',
  title: 'Mechanical title',
  ai: { title: 'AI title', summary: 'AI summary', audience: 'maintainers' },
  eli5: { text: 'Plain line.' },
  noise: false,
  stats: { additions: 1, deletions: 0 },
  files: { total: 1, added: ['cli.ts'], modified: [], removed: [] }
})

const quiet = async (fn) => {
  const out = []
  const orig = console.log
  console.log = (...xs) => out.push(xs.join(' '))
  try { return { res: await fn(), out } } finally { console.log = orig }
}

test('cmdOverride: bare invocation prints a draft filled with current values', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({ entries: [entry('aaaaaaaaaaaa1111')] }))
  const { res, out } = await quiet(() => cmdOverride(['aaaaaaaaaaaa'], { dataDir: dir }))
  assert.equal(res.ok, true)
  assert.ok(res.draft['aaaaaaaaaaaa1111'], 'draft keyed by the full sha')
  assert.equal(res.draft['aaaaaaaaaaaa1111'].title, 'AI title', 'starts from what is rendered today')
  assert.equal(res.draft['aaaaaaaaaaaa1111'].eli5, 'Plain line.')
  assert.match(out.join('\n'), /AI title/, 'the printed scaffold carries the current values')
})

test('cmdOverride: fields merge into overrides.json and --clear removes them', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({ entries: [entry('aaaaaaaaaaaa1111')] }))

  const w = await cmdOverride(['aaaaaaaaaaaa', '--title', 'Corrected title', '--note', 'was wrong'], { dataDir: dir })
  assert.equal(w.ok, true)
  assert.equal(w.key, 'aaaaaaaaaaaa1111')

  const file = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'overrides.json'), 'utf8'))
  assert.deepEqual(file['aaaaaaaaaaaa1111'], { title: 'Corrected title', note: 'was wrong' })

  const c = await cmdOverride(['aaaaaaaaaaaa', '--clear'], { dataDir: dir })
  assert.equal(c.cleared, 'aaaaaaaaaaaa1111')
  const after = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'overrides.json'), 'utf8'))
  assert.equal(after['aaaaaaaaaaaa1111'], undefined)
})

// --- dynamicRoute: /api/entry/<sha>.json, ?format=md, /from/<d>/to/<d>/

const fakeDist = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-dynroute-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'api/records'), { recursive: true })
  await mkdir(join(dir, 'release/1.2.3'), { recursive: true })
  await writeFile(join(dir, 'api/sha-day.json'), JSON.stringify({ aaaaaaaaaaaa: '2026-09-12' }))
  await writeFile(join(dir, 'api/records/2026-09-12.json'), JSON.stringify({
    day: '2026-09-12',
    records: [{ sha: 'aaaaaaaaaaaa1111', day: '2026-09-12', title: 'AI title' }]
  }))
  await writeFile(join(dir, 'release/1.2.3/notes.md'), '# Freebuff v1.2.3\n')
  await writeFile(join(dir, 'range-view'), '<!doctype html><title>range</title>')
  return dir
}

test('dynamicRoute: serves one entry record by sha prefix', async (t) => {
  const dist = await fakeDist(t)
  const hit = await dynamicRoute(dist, '/api/entry/aaaaaaaaaaaa.json', new URLSearchParams())
  assert.equal(hit.status, 200)
  assert.equal(JSON.parse(hit.body).title, 'AI title')
  const partial = await dynamicRoute(dist, '/api/entry/aaaa', new URLSearchParams())
  assert.equal(JSON.parse(partial.body).sha, 'aaaaaaaaaaaa1111', 'short prefixes resolve')
  const miss = await dynamicRoute(dist, '/api/entry/bbbbbbbb.json', new URLSearchParams())
  assert.equal(miss.status, 404)
})

test('dynamicRoute: release ?format=md answers text/markdown, range paths answer the shell', async (t) => {
  const dist = await fakeDist(t)
  const md = await dynamicRoute(dist, '/release/1.2.3/', new URLSearchParams('format=md'))
  assert.equal(md.status, 200)
  assert.match(md.headers['content-type'], /text\/markdown/)
  assert.match(md.body, /# Freebuff v1\.2\.3/)

  const range = await dynamicRoute(dist, '/from/2026-09-01/to/2026-09-12/', new URLSearchParams())
  assert.equal(range.status, 200)
  assert.match(range.headers['content-type'], /text\/html/)

  const plain = await dynamicRoute(dist, '/release/1.2.3/', new URLSearchParams())
  assert.equal(plain, null, 'without format=md the static page serves normally')
})
