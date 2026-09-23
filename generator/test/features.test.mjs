// generator/test/features.test.mjs - unit coverage for the new building blocks:
// impact ranges, related-entry proximity, model lineage grouping, the
// /api/entry record shape, the OPML bundle, and worker.js routing.
import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../../worker.js'
import { impactAllows, buildRelatedIndex, modelFamily, entryRecord, modelSlug } from '../lib/site.mjs'
import { feedsOpml } from '../lib/feed.mjs'

test('impactAllows: the impact filter is a minimum, not an equality', () => {
  // The /search/ label promises "notable + major"; the old `a !== sig` kept
  // only rows equal to the filter and silently dropped the major rows.
  assert.ok(impactAllows('major', 'notable'), 'major rows survive the "notable + major" filter')
  assert.ok(impactAllows('notable', 'notable'))
  assert.ok(!impactAllows('minor', 'notable'), 'minor rows do not')
  assert.ok(impactAllows('major', 'major'))
  assert.ok(!impactAllows('notable', 'major'), '"major only" means only')
  assert.ok(impactAllows('minor', ''), 'no filter keeps everything')
})

test('buildRelatedIndex: neighbours in time, not the newest rows of the category', () => {
  // entries are newest-first, as buildSite feeds them.
  const mk = (sha, day) => ({ sha, day, category: 'CLI' })
  const entries = [
    mk('a', '2026-09-04'), mk('b', '2026-09-03'), mk('x', '2026-09-02'),
    mk('c', '2026-09-01'), mk('d', '2026-08-31')
  ]
  const idx = buildRelatedIndex(entries, 3)
  assert.deepEqual(idx.get('x').map(e => e.sha), ['b', 'c', 'a', 'd'].slice(0, 3), 'nearest first, both sides, capped at n')
  assert.ok(!idx.get('d').some(e => e.sha === 'd'), 'never links itself')
  const old = idx.get('d').map(e => e.sha)
  assert.ok(old.includes('c'), 'the oldest row links its actual neighbour')
  assert.ok(!old.includes('a'), 'and not the newest row of the category')
})

test('modelFamily: strips generation trailers so one line groups together', () => {
  assert.equal(modelFamily('DeepSeek V4 Pro 07/31'), 'DeepSeek')
  assert.equal(modelFamily('DeepSeek V4 Pro'), 'DeepSeek')
  assert.equal(modelFamily('DeepSeek V4 Flash'), 'DeepSeek')
  assert.equal(modelFamily('DeepSeek V4.1 Flash'), 'DeepSeek')
  assert.equal(modelFamily('MiMo 2.6 Flash'), 'MiMo')
  assert.equal(modelFamily('MiMo 2.5'), 'MiMo')
  assert.equal(modelFamily('Muse Spark 1.2'), 'Muse Spark')
  assert.equal(modelFamily('GLM 5.3 Flash'), 'GLM')
  assert.equal(modelFamily('Solar Pro 4'), 'Solar')
  // Distinct lines stay distinct; a bare name is its own family.
  assert.equal(modelFamily('Ox Alpha'), 'Ox Alpha')
  assert.equal(modelFamily('MiniMax M3'), 'MiniMax M3')
  assert.equal(modelFamily('GPT-5.6 Luna'), 'GPT-5.6')
  assert.equal(modelFamily(''), '')
})

test('entryRecord: the /api/entry shape carries what the cards show, minus HTML', () => {
  const e = {
    sha: 'abcdef0123456789', day: '2026-09-12', date: '2026-09-12T10:00:00Z',
    category: 'CLI', significance: 'notable', title: 'Mechanical',
    ai: { title: 'AI title', summary: 'AI summary', audience: 'end-users', evidence: 'x.ts hunk', breaking: true, confidence: 'high' },
    eli5: { text: 'Plain line.' },
    version: '1.2.3', pr: 42, stats: { additions: 3, deletions: 1 },
    files: { total: 1, added: ['cli.ts'], modified: [], removed: [] }
  }
  const rec = entryRecord(e, new Map([['abcdef0123456789', { 'codebuff-cli': { version: '1.3.0' } }]]))
  assert.equal(rec.short, 'abcdef012345')
  assert.equal(rec.title, 'AI title')
  assert.equal(rec.plainEnglish, 'Plain line.')
  assert.equal(rec.audience, 'end-users')
  assert.equal(rec.breaking, true)
  assert.equal(rec.pr, 42)
  assert.equal(rec.shippedIn['codebuff-cli'], '1.3.0')
  assert.match(rec.urls.site, /\/day\/2026-09-12\/#abcdef012345/)
  assert.match(rec.urls.permalink, /\/c\/abcdef012345/)
  assert.equal(entryRecord({ ...e, ai: {} }).urls.commit, 'https://github.com/CodebuffAI/freebuff/commit/abcdef0123456789')
  assert.equal(entryRecord({ ...e, ai: {}, eli5: null }).plainEnglish, undefined, 'absent fields are omitted, not nulled')
})

test('feedsOpml: bundles every feed with xmlUrl and htmlUrl', () => {
  const opml = feedsOpml('https://x.test', [
    { title: 'all', path: '/feed.xml', group: 'core', desc: 'Everything.' },
    { title: 'CLI', path: '/feed-cli.xml', group: 'areas', desc: 'CLI area.' },
    { title: 'advertisers', path: '/feed-audience-advertisers.xml', group: 'audiences' }
  ])
  assert.match(opml, /<opml version="2\.0">/)
  assert.match(opml, /xmlUrl="https:\/\/x\.test\/feed\.xml"/)
  assert.match(opml, /htmlUrl="https:\/\/x\.test\/"/)
  assert.match(opml, /<outline text="areas"/)
  assert.match(opml, /feed-audience-advertisers\.xml/)
})

// --- worker.js: the edge routes, over a fake ASSETS backed by a fixture map.

const fakeEnv = (files) => ({
  ASSETS: {
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      return path in files
        ? new Response(files[path], { status: 200 })
        : new Response('not found', { status: 404 })
    }
  }
})

test('worker: /api/entry/<sha>.json serves one record and 404s unknown shas', async () => {
  const env = fakeEnv({
    '/api/sha-day.json': JSON.stringify({ aaaaaaaaaaaa: '2026-09-12' }),
    '/api/records/2026-09-12.json': JSON.stringify({ day: '2026-09-12', records: [{ sha: 'aaaaaaaaaaaa1111', title: 'AI title' }] })
  })
  const hit = await worker.fetch(new Request('https://x.test/api/entry/aaaaaaaaaaaa.json'), env)
  assert.equal(hit.status, 200)
  assert.equal(hit.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal((await hit.json()).title, 'AI title')
  const miss = await worker.fetch(new Request('https://x.test/api/entry/deadbeef.json'), env)
  assert.equal(miss.status, 404)
})

test('worker: a missing assets binding is a readable 500, never a thrown exception', async () => {
  // The gap that shipped a zone-wide 1101: wrangler.json lacked assets.binding,
  // so env.ASSETS was undefined and the passthrough fetch threw on EVERY
  // request (static files included, because run_worker_first routes all of
  // them through here). An uncaught throw is the worst possible answer.
  await assert.doesNotReject(() => worker.fetch(new Request('https://x.test/'), {}))
  const res = await worker.fetch(new Request('https://x.test/'), {})
  assert.equal(res.status, 500)
  assert.match(await res.text(), /assets binding missing/)
  const entry = await worker.fetch(new Request('https://x.test/api/entry/deadbeef.json'), {})
  assert.equal(entry.status, 404, 'entry lookups degrade to 404 without the binding')
})

test('worker: ?format=md answers text/markdown, /from/<d>/to/<d>/ answers the shell, the rest falls through', async () => {
  const env = fakeEnv({
    '/release/1.2.3/notes.md': '# Freebuff v1.2.3\n',
    '/range-view': '<!doctype html><title>range</title>'
  })
  const md = await worker.fetch(new Request('https://x.test/release/1.2.3/?format=md'), env)
  assert.equal(md.status, 200)
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.match(await md.text(), /# Freebuff v1\.2\.3/)

  const range = await worker.fetch(new Request('https://x.test/from/2026-09-01/to/2026-09-12/'), env)
  assert.equal(range.status, 200)
  assert.match(range.headers.get('content-type'), /text\/html/)

  const plain = await worker.fetch(new Request('https://x.test/day/2026-09-12/'), env)
  assert.equal(await plain.text(), 'not found', 'untouched requests reach the asset server')
})
