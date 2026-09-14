// generator/test/site.test.mjs - tests for the static site generator
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSite, modelTimeline } from '../lib/site.mjs'

test('buildSite generates valid static site output', async () => {
  const tmpDist = await mkdtemp(join(tmpdir(), 'fbweb-test-dist-'))
  try {
    const mockChangelog = {
      version: 1,
      repo: 'https://github.com/CodebuffAI/freebuff',
      generatedAt: '2026-09-13T12:00:00Z',
      headSha: '1111222233334444555566667777888899990000',
      counts: {
        commitsScanned: 10,
        entries: 2,
        syncEra: 1,
        community: 1
      },
      entries: [
        {
          kind: 'community',
          sha: 'aaaa111122223333444455556666777788889999',
          url: 'https://github.com/CodebuffAI/freebuff/commit/aaaa',
          date: '2026-09-12T10:00:00Z',
          author: 'dev',
          pr: 100,
          prUrl: 'https://github.com/CodebuffAI/freebuff/pull/100',
          messageTitle: 'Add awesome feature (#100)',
          version: '1.0.100',
          areas: ['CLI'],
          modelChanges: null,
          cmdChanges: null,
          files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['cli/src/feature.ts'], removed: [], renamed: [], modified: [] },
          stats: { additions: 50, deletions: 0 },
          facts: [],
          summary: 'Add awesome feature (#100)',
          title: 'Add awesome feature (#100)',
          category: 'CLI',
          significance: 'major',
          day: '2026-09-12',
          month: '2026-09'
        },
        {
          kind: 'sync',
          sha: 'bbbb111122223333444455556666777788889999',
          url: 'https://github.com/CodebuffAI/freebuff/commit/bbbb',
          compareUrl: 'https://github.com/CodebuffAI/freebuff/compare/aaaa...bbbb',
          date: '2026-09-13T10:00:00Z',
          sourceSha: 'cccc111122223333444455556666777788889999',
          version: null,
          areas: ['Model Catalog'],
          modelChanges: { added: ['Muse Spark 1.3'], removed: ['Muse Spark 1.2'] },
          cmdChanges: null,
          files: { total: 2, meaningful: 1, rawMeaningful: 2, testOnly: false, added: [], removed: [], renamed: [], modified: ['README.md'] },
          stats: { additions: 5, deletions: 5 },
          facts: ['New high-speed endpoint enabled.'],
          summary: 'Model catalog: Muse Spark 1.3 replaced Muse Spark 1.2 in the free model lineup.',
          title: 'Muse Spark 1.3 replaces Muse Spark 1.2 in the free model lineup',
          ai: { title: 'Muse Spark 1.3 replaces Muse Spark 1.2', summary: 'AI summarized diff', model: 'mock-model' },
          category: 'Model Catalog',
          significance: 'major',
          day: '2026-09-13',
          month: '2026-09'
        }
      ]
    }

    const mockOpenPrs = [
      {
        number: 999,
        title: 'Draft community experiment',
        url: 'https://github.com/CodebuffAI/freebuff/pull/999',
        author: 'contributor',
        created: '2026-09-13T08:00:00Z',
        updated: '2026-09-13T09:00:00Z',
        draft: true
      }
    ]

    const res = await buildSite({ changelog: mockChangelog, openPrs: mockOpenPrs, dist: tmpDist })
    assert.equal(res.entries, 2)
    assert.equal(res.days, 2)
    assert.equal(res.releases, 1)

    // Verify index.html contains permalinks, in-flight nav, diff-viewer, and sync countdown timer
    const indexHtml = await readFile(join(tmpDist, 'index.html'), 'utf8')
    assert.match(indexHtml, /class="permalink"/)
    assert.match(indexHtml, /href="\/in-flight\/"/)
    assert.match(indexHtml, /class="diff-viewer" data-sha=/)
    assert.match(indexHtml, /View inline diff/)
    // Diffs lazy-load on toggle: no pre-rendered diff markup in pages
    assert.doesNotMatch(indexHtml, /<pre class="diff-pre">/)
    assert.doesNotMatch(indexHtml, /<div class="diff-line/)
    assert.match(indexHtml, /Loading diff…/)
    assert.doesNotMatch(indexHtml, /class="sync-badge"/)
    assert.match(indexHtml, /class="sync-val"/)
    assert.match(indexHtml, /NEXT SYNC:/)
    assert.match(indexHtml, /<h2><time datetime="2026-09-13">\[ Sep 13, 2026 \]<\/time><\/h2>/)
    assert.doesNotMatch(indexHtml, /== \[ Sep 13, 2026 \] ==/)

    // Verify collapsible entries: latest commit is open by default, previous commit is collapsed
    assert.match(indexHtml, /<details class="entry major" id="bbbb11112222" open>/)
    assert.match(indexHtml, /<details class="entry major" id="aaaa11112222">/)
    assert.doesNotMatch(indexHtml, /<details class="entry major" id="aaaa11112222" open>/)
    assert.match(indexHtml, /class="entry-summary"/)
    assert.doesNotMatch(indexHtml, /class="badge ai"/)
    assert.doesNotMatch(indexHtml, /Summarized by/)

    // Verify day pages contain prev/next pager
    const dayHtml = await readFile(join(tmpDist, 'day/2026-09-13/index.html'), 'utf8')
    assert.match(dayHtml, /class="pager"/)
    assert.match(dayHtml, /href="\/day\/2026-09-12\/"/)

    // Verify release page exists
    const relHtml = await readFile(join(tmpDist, 'release/1.0.100/index.html'), 'utf8')
    assert.match(relHtml, /Freebuff v1\.0\.100/)

    // Verify in-flight page does NOT contain undefined
    const inFlightHtml = await readFile(join(tmpDist, 'in-flight/index.html'), 'utf8')
    assert.doesNotMatch(inFlightHtml, /undefined/)
    assert.match(inFlightHtml, /#999 by contributor/)

    // Verify search index includes compact fields without AI disclosure
    const searchIdx = JSON.parse(await readFile(join(tmpDist, 'search-index.json'), 'utf8'))
    assert.equal(searchIdx.length, 2)
    assert.equal(searchIdx[0].u, undefined)
    assert.ok(searchIdx[0].s)
    assert.ok(searchIdx[0].d)
    assert.equal(searchIdx[0].m, undefined)
    assert.equal(searchIdx[0].ai, undefined)

    // Verify feed.xml contains atom:link, stylesheet, and lastBuildDate with correct domain
    const feedXml = await readFile(join(tmpDist, 'feed.xml'), 'utf8')
    assert.match(feedXml, /<atom:link /)
    assert.match(feedXml, /<lastBuildDate>/)
    assert.match(feedXml, /xml-stylesheet type="text\/xsl" href="\/feed\.xsl"/)
    assert.match(feedXml, /https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/day\//)
    assert.doesNotMatch(feedXml, /pages\.dev/)

    // Verify sitemap.xml and robots.txt use active domain
    const sitemapXml = await readFile(join(tmpDist, 'sitemap.xml'), 'utf8')
    assert.match(sitemapXml, /https:\/\/freebuff-changelog\.nordicnode\.workers\.dev/)
    assert.doesNotMatch(sitemapXml, /pages\.dev/)
    const robotsTxt = await readFile(join(tmpDist, 'robots.txt'), 'utf8')
    assert.match(robotsTxt, /https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/sitemap\.xml/)

    // Verify feed.xsl exists and sets data-theme="dark"
    const feedXsl = await readFile(join(tmpDist, 'feed.xsl'), 'utf8')
    assert.match(feedXsl, /data-theme="dark"/)

    // Verify favicon files exist
    const favIco = await readFile(join(tmpDist, 'favicon.ico'))
    assert.ok(favIco.length > 500)
    const favSvg = await readFile(join(tmpDist, 'favicon.svg'), 'utf8')
    assert.match(favSvg, /<svg /)

    // Verify index.html has data-theme="dark" and favicon links
    assert.match(indexHtml, /<html lang="en" data-theme="dark">/)
    assert.match(indexHtml, /href="\/favicon\.ico"/)

    // Verify _headers contains wildcard rules, diffs, favicons, and CORS
    const headers = await readFile(join(tmpDist, '_headers'), 'utf8')
    assert.match(headers, /\/day\/\*/)
    assert.match(headers, /\/release\/\*/)
    assert.match(headers, /\/diffs\/\*/)
    assert.match(headers, /\/favicon\.ico/)
    assert.match(headers, /\/feed\.xsl/)
    assert.match(headers, /Access-Control-Allow-Origin: \*/)

    // Verify 404 contains noindex
    const notFoundHtml = await readFile(join(tmpDist, '404.html'), 'utf8')
    assert.match(notFoundHtml, /<meta name="robots" content="noindex">/)

    // Verify about page contains extended tracking and Qwen 3.8 Flash
    const aboutHtml = await readFile(join(tmpDist, 'about/index.html'), 'utf8')
    assert.match(aboutHtml, /WHAT WE TRACK/)
    assert.match(aboutHtml, /Qwen 3\.8 Flash/)
    assert.match(aboutHtml, /Subsystems &amp; Areas:/)

    // Verify models page: lineup, retired, history rows, nav
    const modelsHtml = await readFile(join(tmpDist, 'models/index.html'), 'utf8')
    assert.match(modelsHtml, /MODEL_LINEUP/)
    assert.match(modelsHtml, /Muse Spark 1\.3/)
    assert.match(modelsHtml, /Muse Spark 1\.2/)
    assert.match(modelsHtml, /CATALOG HISTORY \(1 CHANGES\)/)
    assert.match(modelsHtml, /\/day\/2026-09-13\/#bbbb11112222/)
    assert.match(modelsHtml, /\/models\//)
  } finally {
    await rm(tmpDist, { recursive: true, force: true })
  }
})

test('modelTimeline: replays adds/removes oldest-first', () => {
  const mk = (sha, date, added, removed) => ({ sha, date, day: date.slice(0, 10), modelChanges: { added, removed } })
  const entries = [
    mk('c', '2026-09-13T10:00:00Z', ['Muse Spark 1.2'], ['Muse Spark 1.3']),
    mk('a', '2026-09-11T10:00:00Z', ['Muse Spark 1.3'], []),
    mk('b', '2026-09-12T10:00:00Z', ['Ox Alpha'], [])
  ]
  const { chrono, live, retired } = modelTimeline(entries)
  assert.deepEqual(chrono.map(e => e.sha), ['c', 'b', 'a'])
  assert.deepEqual(live, ['Muse Spark 1.2', 'Ox Alpha'])
  assert.deepEqual(retired, ['Muse Spark 1.3'])
})
