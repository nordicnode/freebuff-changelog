// generator/test/site.test.mjs - tests for the static site generator
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSite, modelTimeline, modelSlug, scoreHit } from '../lib/site.mjs'

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
          sha: 'dddd111122223333444455556666777788889999',
          url: 'https://github.com/CodebuffAI/freebuff/commit/dddd',
          compareUrl: 'https://github.com/CodebuffAI/freebuff/compare/cccc...dddd',
          date: '2026-09-13T11:00:00Z',
          areas: ['CLI'],
          modelChanges: null,
          cmdChanges: null,
          files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: [], removed: [], renamed: [], modified: ['cli/y.ts'] },
          stats: { additions: 10, deletions: 2 },
          facts: [],
          summary: 'CLI flag tweak.',
          title: 'CLI flag tweak',
          category: 'CLI',
          significance: 'minor',
          day: '2026-09-13',
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
    assert.equal(res.entries, 3)
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
    // Second (older) day collapses to teasers on the homepage
    assert.match(indexHtml, /<details class="entry teaser major" id="aaaa11112222">/)
    assert.doesNotMatch(indexHtml, /<details class="entry teaser major" id="aaaa11112222" open>/)
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

    // Verify search index uses codebook format with category/sig selects
    const searchIdx = JSON.parse(await readFile(join(tmpDist, 'search-index.json'), 'utf8'))
    assert.ok(Array.isArray(searchIdx.cats))
    assert.ok(searchIdx.cats.includes('CLI'))
    assert.deepEqual(searchIdx.sigs, ['minor', 'notable', 'major'])
    assert.equal(searchIdx.ix.length, 3)
    assert.ok(Array.isArray(searchIdx.ix[0]))
    assert.equal(searchIdx.ix[0].length, 5)
    const searchHtml = await readFile(join(tmpDist, 'search/index.html'), 'utf8')
    assert.match(searchHtml, /<select id="fcat">/)
    assert.match(searchHtml, /<select id="fsig">/)
    assert.match(searchHtml, /<option value="CLI">/)

    // Verify in-flight cards render diffstats and diff preview placeholders
    const prWithStats = { ...mockOpenPrs[0], additions: 10, deletions: 2, files: 1, hasDiff: true }
    await buildSite({ changelog: mockChangelog, openPrs: [prWithStats], dist: tmpDist })
    const inFlightStats = await readFile(join(tmpDist, 'in-flight/index.html'), 'utf8')
    assert.match(inFlightStats, /\+10/)
    assert.match(inFlightStats, /1 file/)
    assert.match(inFlightStats, /data-pr="999"/)
    assert.match(inFlightStats, /View diff preview/)

    // Verify sync freshness badge and status API
    assert.match(indexHtml, /class="sync-age"/)
    assert.match(indexHtml, /data-generated="2026-09-13T12:00:00Z"/)
    const statusApi = JSON.parse(await readFile(join(tmpDist, 'api/status.json'), 'utf8'))
    assert.equal(statusApi.total, 3)
    assert.equal(statusApi.openPrs, 1)
    assert.equal(statusApi.models.changes, 1)
    assert.match(await readFile(join(tmpDist, '_headers'), 'utf8'), /\/pr-diffs\/\*/)
    assert.match(await readFile(join(tmpDist, '_headers'), 'utf8'), /\/models\//)
    // Full changelog.json no longer ships to dist (6.9MB dead payload)
    await assert.rejects(readFile(join(tmpDist, 'changelog.json'), 'utf8'))

    // Verify feed.xml contains atom:link, stylesheet, and lastBuildDate with correct domain
    const feedXml = await readFile(join(tmpDist, 'feed.xml'), 'utf8')
    assert.match(feedXml, /<atom:link /)
    assert.match(feedXml, /<lastBuildDate>/)
    assert.match(feedXml, /xml-stylesheet type="text\/xsl" href="\/feed\.xsl"/)
    assert.match(feedXml, /https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/day\//)
    assert.doesNotMatch(feedXml, /pages\.dev/)

    // Verify sitemap.xml is an index with day/release/page children
    const sitemapXml = await readFile(join(tmpDist, 'sitemap.xml'), 'utf8')
    assert.match(sitemapXml, /<sitemapindex/)
    assert.match(sitemapXml, /sitemap-days\.xml/)
    assert.match(sitemapXml, /sitemap-releases\.xml/)
    assert.match(sitemapXml, /sitemap-pages\.xml/)
    assert.doesNotMatch(sitemapXml, /pages\.dev/)
    const sitemapDays = await readFile(join(tmpDist, 'sitemap-days.xml'), 'utf8')
    assert.match(sitemapDays, /\/day\/2026-09-13\//)
    const sitemapRels = await readFile(join(tmpDist, 'sitemap-releases.xml'), 'utf8')
    assert.match(sitemapRels, /\/release\/1\.0\.100\//)
    const sitemapPages = await readFile(join(tmpDist, 'sitemap-pages.xml'), 'utf8')
    assert.match(sitemapPages, /\/models\//)
    const robotsTxt = await readFile(join(tmpDist, 'robots.txt'), 'utf8')
    assert.match(robotsTxt, /https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/sitemap\.xml/)

    // Verify feeds carry enriched content (summary + facts), not titles only
    assert.match(feedXml, /<content:encoded/)
    assert.match(feedXml, /New high-speed endpoint enabled\./)

    // Verify feed.xsl exists and sets data-theme="dark"
    const feedXsl = await readFile(join(tmpDist, 'feed.xsl'), 'utf8')
    assert.match(feedXsl, /data-theme="dark"/)

    // Verify favicon files exist
    const favIco = await readFile(join(tmpDist, 'favicon.ico'))
    assert.ok(favIco.length > 500)
    const favSvg = await readFile(join(tmpDist, 'favicon.svg'), 'utf8')
    assert.match(favSvg, /<svg /)

    // Verify index.html has data-theme="dark" and single SVG favicon
    assert.match(indexHtml, /<html lang="en" data-theme="dark">/)
    assert.match(indexHtml, /href="\/favicon\.svg"/)
    assert.doesNotMatch(indexHtml, /href="\/favicon\.ico"/)

    // Verify split feeds: main, models-only, releases-only with correct self links
    assert.match(feedXml, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed\.xml" rel="self"/)
    assert.match(feedXml, /\[2026-09-13\] Muse Spark 1\.3 replaces Muse Spark 1\.2/)
    const feedModels = await readFile(join(tmpDist, 'feed-models.xml'), 'utf8')
    assert.match(feedModels, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed-models\.xml" rel="self"/)
    assert.match(feedModels, /Muse Spark 1\.3 replaces Muse Spark 1\.2/)
    assert.match(feedModels, /models \(unofficial\)/)
    const feedReleases = await readFile(join(tmpDist, 'feed-releases.xml'), 'utf8')
    assert.match(feedReleases, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed-releases\.xml" rel="self"/)
    assert.match(feedReleases, /Add awesome feature/)
    assert.match(feedReleases, /releases \(unofficial\)/)
    assert.match(indexHtml, /href="\/feed-models\.xml"/)
    assert.match(indexHtml, /href="\/feed-releases\.xml"/)
    // Verify _headers contains wildcard rules, diffs, favicons, feeds, and CORS
    const headers = await readFile(join(tmpDist, '_headers'), 'utf8')
    assert.match(headers, /\/feed-models\.xml/)
    assert.match(headers, /\/feed-releases\.xml/)
    assert.match(headers, /\/day\/\*/)
    assert.match(headers, /\/release\/\*/)
    assert.match(headers, /\/diffs\/\*/)
    assert.match(headers, /\/favicon\.ico/)
    assert.match(headers, /\/feed\.xsl/)
    assert.match(headers, /Access-Control-Allow-Origin: \*/)
    // Root path caches like index.html (HAR showed must-revalidate on /)
    assert.match(headers, /^\/\n  Cache-Control: public, max-age=300/m)

    // Verify 404 contains noindex
    const notFoundHtml = await readFile(join(tmpDist, '404.html'), 'utf8')
    assert.match(notFoundHtml, /<meta name="robots" content="noindex">/)

    // Verify about page covers method, categories, limits
    const aboutHtml = await readFile(join(tmpDist, 'about/index.html'), 'utf8')
    assert.match(aboutHtml, /HOW IT WORKS/)
    assert.match(aboutHtml, /Deterministic first/)
    assert.match(aboutHtml, /LIMITS/)
    assert.match(aboutHtml, /Model Catalog/)

    // Verify models page: lineup, retired, history rows, nav
    const modelsHtml = await readFile(join(tmpDist, 'models/index.html'), 'utf8')
    assert.match(modelsHtml, /MODEL_LINEUP/)
    assert.match(modelsHtml, /href="\/models\/muse-spark-1-3\/"/)
    assert.match(modelsHtml, /Muse Spark 1\.3/)
    assert.match(modelsHtml, /Muse Spark 1\.2/)
    assert.match(modelsHtml, /CATALOG HISTORY \(1 CHANGES\)/)
    assert.match(modelsHtml, /\/day\/2026-09-13\/#bbbb11112222/)
    assert.match(modelsHtml, /\/models\//)
    assert.match(modelsHtml, /href="\/feed-models\.xml"/)

    // Verify per-model detail page: status, history, watch feed
    const modelDetail = await readFile(join(tmpDist, 'models/muse-spark-1-3/index.html'), 'utf8')
    assert.match(modelDetail, /MODEL :: Muse Spark 1\.3/)
    assert.match(modelDetail, /\[LIVE\]|\[RETIRED\]/)
    assert.match(modelDetail, /HISTORY \(1\)/)
    assert.match(modelDetail, /watch rss/)
    const modelFeed = await readFile(join(tmpDist, 'models/muse-spark-1-3/feed.xml'), 'utf8')
    assert.match(modelFeed, /Muse Spark 1\.3/)

    // Verify stats + watch pages and nav entries
    const statsHtml = await readFile(join(tmpDist, 'stats/index.html'), 'utf8')
    assert.match(statsHtml, /TELEMETRY/)
    assert.match(statsHtml, /MOST-CHANGED MODELS/)
    assert.match(statsHtml, /class="spark"/)
    assert.match(statsHtml, /12-MO TREND/)
    const watchHtml = await readFile(join(tmpDist, 'watch/index.html'), 'utf8')
    assert.match(watchHtml, /WATCHLIST/)
    assert.match(watchHtml, /PER-MODEL RSS/)
    assert.match(watchHtml, /SAVED SEARCH/)
    assert.match(indexHtml, /href="\/stats\/"/)
    assert.match(indexHtml, /href="\/watch\/"/)

    // Verify day jump, split-view toggle, collapse, sitemap models
    const dayHtml2 = await readFile(join(tmpDist, 'day/2026-09-13/index.html'), 'utf8')
    assert.match(dayHtml2, /class="day-jump"/)
    assert.match(dayHtml2, /data-mode="split"/)
    // Homepage teasers: older days collapse, first day stays full
    assert.match(indexHtml, /class="entry teaser/)
    // Day pages carry related links + per-day OG image
    assert.match(dayHtml2, /RELATED:/)
    assert.match(dayHtml2, /og\/2026-09-13\.svg/)
    // JSON feed + manifest + icons + OG cards exist
    const feedJson = JSON.parse(await readFile(join(tmpDist, 'feed.json'), 'utf8'))
    assert.equal(feedJson.version, 'https://jsonfeed.org/version/1.1')
    assert.ok(feedJson.items.length > 0)
    assert.match(feedJson.items[0].title, /^\[2026-/)
    const manifest = JSON.parse(await readFile(join(tmpDist, 'manifest.webmanifest'), 'utf8'))
    assert.equal(manifest.short_name, 'FreebuffLog')
    assert.match(indexHtml, /rel="manifest"/)
    assert.match(indexHtml, /rel="apple-touch-icon"/)
    assert.match(indexHtml, /property="og:image"/)
    assert.match(indexHtml, /type="application\/feed\+json"/)
    const archiveHtml = await readFile(join(tmpDist, 'archive/index.html'), 'utf8')
    assert.match(archiveHtml, /cat-collapse/)
    const sitemapModels = await readFile(join(tmpDist, 'sitemap-models.xml'), 'utf8')
    assert.match(sitemapModels, /\/models\/muse-spark-1-3\//)
  } finally {
    await rm(tmpDist, { recursive: true, force: true })
  }
})

test('inline scripts: template escaping preserves regex backslashes', async () => {
  const tmpDist = await mkdtemp(join(tmpdir(), 'fbweb-test-js-'))
  try {
    const { writeFile: wf } = await import('node:fs/promises')
    const mockChangelog = {
      version: 1, repo: 'https://github.com/CodebuffAI/freebuff', generatedAt: '2026-09-13T12:00:00Z',
      headSha: '1111222233334444555566667777888899990000',
      counts: { commitsScanned: 1, entries: 1, syncEra: 1, community: 0 },
      entries: [{
        kind: 'sync', sha: 'bbbb111122223333444455556666777788889999',
        url: 'https://github.com/CodebuffAI/freebuff/commit/bbbb', date: '2026-09-13T10:00:00Z',
        areas: ['CLI'], modelChanges: null, cmdChanges: null,
        files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: [], removed: [], renamed: [], modified: ['cli/x.ts'] },
        stats: { additions: 1, deletions: 0 }, facts: [], summary: 'Minor CLI tweak.', title: 'Minor CLI tweak.',
        category: 'CLI', significance: 'minor', day: '2026-09-13', month: '2026-09'
      }]
    }
    await buildSite({ changelog: mockChangelog, openPrs: [], dist: tmpDist })
    const { execFileSync } = await import('node:child_process')
    for (const f of ['index.html', 'search/index.html', 'day/2026-09-13/index.html']) {
      const html = await readFile(join(tmpDist, f), 'utf8')
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
      assert.ok(blocks.length > 0, `${f} has inline scripts`)
      for (const js of blocks) {
        await wf(join(tmpDist, 'inline-check.mjs'), js)
        execFileSync('node', ['--check', join(tmpDist, 'inline-check.mjs')])
      }
      // Backslash regexes survived template escaping intact
      if (f !== 'search/index.html') assert.match(html, /split\(\/\\r\?\\n\/\)/)
    }
    const searchHtml = await readFile(join(tmpDist, 'search/index.html'), 'utf8')
    assert.match(searchHtml, /split\(\/\\s\+\//)
  } finally {
    await rm(tmpDist, { recursive: true, force: true })
  }
})

test('modelSlug + scoreHit: slugs safe, titles outrank categories', () => {  assert.equal(modelSlug('Muse Spark 1.2'), 'muse-spark-1-2')
  assert.equal(modelSlug('DeepSeek V4 Pro 08/13'), 'deepseek-v4-pro-08-13')
  assert.equal(modelSlug(''), 'model')
  assert.ok(scoreHit('Muse Spark added', 'Model Catalog', 'major', '2026-09-13', ['muse']) > scoreHit('Other title', 'Model Catalog', 'major', '2026-09-13', ['muse']))
  assert.ok(scoreHit('Muse Spark added', 'Model Catalog', 'major', '2026-09-13', ['muse']) > scoreHit('Muse Spark added', 'Model Catalog', 'minor', '2026-09-13', ['muse']))
  assert.equal(scoreHit('Unrelated', 'CLI', 'minor', '2026-09-13', ['muse']), -1)
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
