import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchTrafficClones } from '../cli.mjs'
import { buildSite } from '../lib/site.mjs'

test('fetchTrafficClones writes traffic.json on successful API response', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'traffic-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const mockPayload = {
    count: 11219,
    uniques: 1460,
    clones: [
      { timestamp: '2026-09-16T00:00:00Z', count: 1831, uniques: 506 },
      { timestamp: '2026-09-17T00:00:00Z', count: 2544, uniques: 724 }
    ]
  }

  let calledUrl = null
  let calledHeaders = null
  const fetchImpl = async (url, { headers }) => {
    calledUrl = url
    calledHeaders = headers
    return {
      ok: true,
      status: 200,
      json: async () => mockPayload
    }
  }

  const res = await fetchTrafficClones({ fetchImpl, dataDir: dir, repo: 'test/repo', force: true })
  assert.equal(res.count, 11219)
  assert.equal(res.uniques, 1460)
  assert.equal(res.clones.length, 2)
  assert.match(calledUrl, /repos\/test\/repo\/traffic\/clones/)

  const disk = JSON.parse(await readFile(join(dir, 'traffic.json'), 'utf8'))
  assert.equal(disk.count, 11219)
  assert.equal(disk.uniques, 1460)
  assert.ok(disk.fetchedAt)
})

test('fetchTrafficClones respects cache TTL and does not refetch if fresh', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'traffic-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const cached = {
    count: 5000,
    uniques: 800,
    clones: [],
    fetchedAt: new Date().toISOString()
  }
  await writeFile(join(dir, 'traffic.json'), JSON.stringify(cached))

  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, json: async () => ({ count: 9999, uniques: 999 }) }
  }

  const res = await fetchTrafficClones({ fetchImpl, dataDir: dir, force: false })
  assert.equal(calls, 0)
  assert.equal(res.count, 5000)
})

test('fetchTrafficClones falls back to existing cache on HTTP 403 or network failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'traffic-fallback-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const cached = {
    count: 11219,
    uniques: 1460,
    clones: [{ timestamp: '2026-09-17T00:00:00Z', count: 2544, uniques: 724 }],
    fetchedAt: '2026-09-18T00:00:00Z'
  }
  await writeFile(join(dir, 'traffic.json'), JSON.stringify(cached))

  const fetchImpl = async () => ({ ok: false, status: 403 })

  const res = await fetchTrafficClones({ fetchImpl, dataDir: dir, force: true })
  assert.equal(res.count, 11219)
  assert.equal(res.uniques, 1460)
})

test('fetchTrafficClones merges older daily clone records', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'traffic-merge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const cached = {
    count: 1000,
    uniques: 200,
    clones: [
      { timestamp: '2026-09-01T00:00:00Z', count: 50, uniques: 10 },
      { timestamp: '2026-09-02T00:00:00Z', count: 60, uniques: 15 }
    ],
    fetchedAt: '2026-09-02T00:00:00Z'
  }
  await writeFile(join(dir, 'traffic.json'), JSON.stringify(cached))

  const freshPayload = {
    count: 2000,
    uniques: 400,
    clones: [
      { timestamp: '2026-09-02T00:00:00Z', count: 65, uniques: 16 }, // updated
      { timestamp: '2026-09-03T00:00:00Z', count: 80, uniques: 25 }  // new
    ]
  }

  const res = await fetchTrafficClones({ fetchImpl: async () => ({ ok: true, json: async () => freshPayload }), dataDir: dir, force: true })
  assert.equal(res.count, 2000)
  assert.equal(res.uniques, 400)
  assert.equal(res.clones.length, 3) // 2026-09-01, 2026-09-02, 2026-09-03
  assert.equal(res.clones[0].timestamp, '2026-09-01T00:00:00Z')
  assert.equal(res.clones[1].count, 65)
})

test('buildSite renders traffic badges and about page counters', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'traffic-site-'))
  t.after(() => rm(dist, { recursive: true, force: true }))

  const changelog = {
    version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-18T00:00:00Z',
    headSha: 'a'.repeat(40), counts: { entries: 1 },
    entries: [{
      kind: 'community', sha: 'a'.repeat(40), date: '2026-09-18T00:00:00Z',
      day: '2026-09-18', author: 'dev', areas: ['CLI'], category: 'CLI', significance: 'minor',
      title: 'Fix', summary: 'Fix.', stats: { additions: 1, deletions: 0 },
      files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['a'], removed: [], renamed: [], modified: [] }
    }]
  }

  const traffic = {
    count: 11219,
    uniques: 1460,
    clones: [{ timestamp: '2026-09-17T00:00:00Z', count: 2544, uniques: 724 }],
    fetchedAt: '2026-09-18T00:00:00Z'
  }

  await buildSite({ changelog, openPrs: [], dist, traffic })

  const indexHtml = await readFile(join(dist, 'index.html'), 'utf8')
  assert.match(indexHtml, /class="footer-traffic"/)
  assert.match(indexHtml, /id="footer-clones">11\.2k/)
  assert.match(indexHtml, /id="footer-cloners">1\.46k/)

  const clonesSvg = await readFile(join(dist, 'badge/clones.svg'), 'utf8')
  assert.match(clonesSvg, /14d clones/)
  assert.match(clonesSvg, /11\.2k/)

  const clonersSvg = await readFile(join(dist, 'badge/cloners.svg'), 'utf8')
  assert.match(clonersSvg, /14d cloners/)
  assert.match(clonersSvg, /1\.46k/)

  const trafficApi = JSON.parse(await readFile(join(dist, 'api/traffic.json'), 'utf8'))
  assert.equal(trafficApi.count, 11219)
  assert.equal(trafficApi.uniques, 1460)

  const statusApi = JSON.parse(await readFile(join(dist, 'api/status.json'), 'utf8'))
  assert.equal(statusApi.traffic.count, 11219)
  assert.equal(statusApi.traffic.uniques, 1460)
})
