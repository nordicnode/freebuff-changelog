// generator/test/site.test.mjs - tests for the static site generator
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSite, modelTimeline, modelSlug, scoreHit } from '../lib/site.mjs'
import { syncStaleMs } from '../lib/sync.mjs'

// _headers rules cannot override each other on Cloudflare: every rule whose
// pattern matches a URL is applied, and a header name set twice is *joined* with
// a comma. A multi-valued Access-Control-Allow-Origin is invalid, so browsers
// reject it, and a joined Cache-Control is ambiguous. `*` also crosses `/`, so
// /api/entries.json is matched by /*.json as well as /api/*.
function parseHeaderRules (text) {
  const rules = []
  let cur = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (!/^\s/.test(line)) { cur = { path: line.trim(), headers: {} }; rules.push(cur); continue }
    const i = line.indexOf(':')
    if (cur && i > 0) cur.headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return rules
}

function patternMatches (pattern, url) {
  const parts = pattern.split('*')
  let at = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (i === 0) {
      if (!url.startsWith(p)) return false
      at = p.length
      continue
    }
    const found = url.indexOf(p, at)
    if (found === -1) return false
    at = found + p.length
  }
  return pattern.endsWith('*') || at === url.length
}

function duplicatedHeaders (rules, url) {
  const seen = new Map()
  for (const r of rules) {
    if (!patternMatches(r.path, url)) continue
    for (const [name, value] of Object.entries(r.headers)) {
      if (!seen.has(name)) seen.set(name, [])
      seen.get(name).push(`${r.path}=${value}`)
    }
  }
  return [...seen].filter(([, hits]) => hits.length > 1)
}

function ruleFor (rules, path) {
  const r = rules.find(x => x.path === path)
  assert.ok(r, `no _headers rule for ${path}`)
  return r
}

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
        entries: 4,
        syncEra: 3,
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
          hasDiff: true,
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
          eli5: { text: 'A newer AI model is now available in the free list, replacing the older one.', v: 1, src: 'aaaaaaaaaaaa' },
          category: 'Model Catalog',
          significance: 'major',
          day: '2026-09-13',
          month: '2026-09'
        },
        {
          kind: 'sync',
          sha: 'eeee111122223333444455556666777788889999',
          url: 'https://github.com/CodebuffAI/freebuff/commit/eeee',
          compareUrl: 'https://github.com/CodebuffAI/freebuff/compare/dddd...eeee',
          date: '2026-09-13T12:00:00Z',
          areas: ['Repo'],
          modelChanges: null,
          cmdChanges: null,
          noise: true,
          churn: 'lockfile',
          files: { total: 1, meaningful: 0, rawMeaningful: 0, testOnly: false, added: [], removed: [], renamed: [], modified: ['bun.lock'] },
          stats: { additions: 49, deletions: 55 },
          facts: [],
          summary: 'Only `bun.lock` changed (+49/-55): resolved dependency versions, no source edits.',
          title: 'Dependency lockfile updated',
          // Deliberately flagged: a churn row must not offer a diff even if an
          // older pass left the flag on it, because it has no source diff.
          hasDiff: true,
          category: 'Churn',
          significance: 'noise',
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
    assert.equal(res.entries, 4)
    assert.equal(res.days, 2)
    assert.equal(res.releases, 1)

    // Verify index.html contains permalinks, in-flight nav, diff-viewer, and sync countdown timer
    const indexHtml = await readFile(join(tmpDist, 'index.html'), 'utf8')
    // Rows now carry filter metadata, so open/hidden has to be read off the tag
    // instead of matching one fixed attribute order.
    const rowTags = (html) => (html.match(/<details class="entry [^"]*" id="[0-9a-f]{12}"[^>]*>/g) || [])
    const tagOf = (html, sha) => rowTags(html).find(t => t.includes('id="' + sha + '"'))
    const isOpen = (t) => !!t && / open>$/.test(t)
    const isHidden = (t) => !!t && / hidden/.test(t)
    assert.match(indexHtml, /class="permalink"/)
    assert.match(indexHtml, /href="\/in-flight\/"/)
    assert.match(indexHtml, /class="diff-viewer" data-sha=/)
    assert.match(indexHtml, /View inline diff/)
    // The plain-English line renders directly under the technical summary, and is
    // spelled out for readers who have never seen the term "ELI5".
    assert.match(indexHtml, /<p class="eli5"><span class="eli5-label">IN PLAIN ENGLISH<\/span>A newer AI model is now available/)
    assert.ok(indexHtml.indexOf('class="eli5"') > indexHtml.indexOf('AI summarized diff'),
      'the ELI5 line sits after the technical summary it explains')
    // Diffs lazy-load on toggle: no pre-rendered diff markup in pages
    assert.doesNotMatch(indexHtml, /<pre class="diff-pre">/)
    assert.doesNotMatch(indexHtml, /<div class="diff-line/)
    assert.match(indexHtml, /Loading diff…/)
    assert.doesNotMatch(indexHtml, /class="sync-badge"/)
    assert.match(indexHtml, /class="sync-val"/)
    assert.match(indexHtml, /SYNC DUE:/)
    // The countdown must key off the sync budget, not the wall-clock hour: the
    // backfill loop owns freshness now, so "next :00" would be fiction.
    assert.match(indexHtml, new RegExp('data-budget-min="' + Math.round(syncStaleMs({}) / 60000) + '"'))
    assert.doesNotMatch(indexHtml, /setUTCHours/)
    assert.match(indexHtml, /dataset\.budgetMin/)
    assert.match(indexHtml, /<h2><time datetime="2026-09-13">\[ Sep 13, 2026 \]<\/time><\/h2>/)
    assert.doesNotMatch(indexHtml, /== \[ Sep 13, 2026 \] ==/)

    // Collapsible entries: one row starts open, the rest collapsed. (Teaser mode
    // used to expand the whole first day.) Churn is hidden on this page by
    // default, so the rule is "first *visible* row": here the newest commit is
    // churn, and the expanded state must pass to the next row rather than be
    // spent on something the reader cannot see. Rows render in the document's
    // display order, so the assertion states the rule instead of naming a sha.
    assert.ok(isHidden(tagOf(indexHtml, 'eeee11112222')), 'the newest commit here is churn, hidden by default')
    assert.ok(!isOpen(tagOf(indexHtml, 'eeee11112222')), 'a hidden row is not the expanded one')
    const visibleRows = rowTags(indexHtml).filter(t => !isHidden(t))
    assert.ok(isOpen(visibleRows[0]), 'the first visible row is the one that opens')
    assert.equal(rowTags(indexHtml).filter(isOpen).length, 1, 'exactly one row starts expanded')
    // Older days render the same complete bodies: no teaser, no "open full
    // entry" hop. Collapsed, but the full text is in the document.
    assert.ok(tagOf(indexHtml, 'aaaa11112222') && !isOpen(tagOf(indexHtml, 'aaaa11112222')))
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
    const feedText = await readFile(join(tmpDist, 'feed.xml'), 'utf8')
    assert.doesNotMatch(feedText, /eeee11112222/, 'churn does not appear in RSS')
    const jsonFeedText = await readFile(join(tmpDist, 'feed.json'), 'utf8')
    assert.ok(!jsonFeedText.includes('eeee1111'), 'churn does not appear in the JSON feed')
    const searchIdx2 = JSON.parse(await readFile(join(tmpDist, 'search-index.json'), 'utf8'))
    assert.ok(!searchIdx2.ix.some(r => r[3] === 'eeee11112222'), 'churn is not searchable')
    assert.ok(!searchIdx2.cats.includes('Churn'), 'churn is not a browsable category')
    const entriesApi = JSON.parse(await readFile(join(tmpDist, 'api/entries.json'), 'utf8'))
    assert.equal(entriesApi.total, 4)
    assert.equal(entriesApi.changes, 3)
    assert.equal(entriesApi.churn, 1)
    assert.ok(!entriesApi.latest.some(e => e.noise), 'the latest list in the API stays signal-only')
    const dayChurn = await readFile(join(tmpDist, 'day/2026-09-13/index.html'), 'utf8')
    assert.match(dayChurn, /Dependency lockfile updated/, 'churn is still on the day page')
    assert.match(dayChurn, /2 changes \+ 1 churn/)

    const statusApi = JSON.parse(await readFile(join(tmpDist, 'api/status.json'), 'utf8'))
    assert.equal(statusApi.total, 4)
    assert.equal(statusApi.changes, 3)
    assert.equal(statusApi.churn, 1)
    assert.equal(statusApi.openPrs, 1)
    assert.equal(statusApi.models.changes, 1)
    assert.match(await readFile(join(tmpDist, '_headers'), 'utf8'), /\/pr-diffs\/\*/)
    assert.match(await readFile(join(tmpDist, '_headers'), 'utf8'), /\/models\//)

    // CDN policy: fresh data must reach readers quickly, no rule may collide with
    // another, and immutable assets keep their long TTL.
    const headerText = await readFile(join(tmpDist, '_headers'), 'utf8')
    const rules = parseHeaderRules(headerText)
    for (const url of ['/', '/index.html', '/about/', '/day/2026-09-13/', '/release/1.0.100/',
      '/api/entries.json', '/api/status.json', '/search-index.json', '/feed.json', '/feed.xml',
      '/diffs/aaa.diff', '/pr-diffs/999.diff', '/models/', '/og/day-2026-09-13.svg', '/sitemap.xml']) {
      assert.deepEqual(duplicatedHeaders(rules, url), [], `overlapping _headers rules for ${url}`)
    }
    assert.equal(ruleFor(rules, '/').headers['cache-control'], 'public, max-age=30, stale-while-revalidate=60')
    assert.equal(ruleFor(rules, '/day/*').headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300')
    assert.equal(ruleFor(rules, '/api/*').headers['cache-control'], 'public, max-age=30, stale-while-revalidate=60')
    assert.equal(ruleFor(rules, '/diffs/*').headers['cache-control'], 'public, max-age=31536000, immutable')
    // Nothing that carries entry data may outlive the sync budget.
    for (const p of ['/', '/index.html', '/day/*', '/changes/*', '/api/*', '/feed.xml', '/feed.json', '/search-index.json']) {
      const maxAge = Number((ruleFor(rules, p).headers['cache-control'].match(/max-age=(\d+)/) || [])[1])
      assert.ok(maxAge > 0 && maxAge <= 300, `${p} max-age=${maxAge} is too long for a ~2min sync`)
    }
    assert.equal(rules.filter(r => r.path === '/feed.json').length, 1, 'duplicate /feed.json rule joins Cache-Control')

    // The header widget must key off the budget, and a backgrounded tab must not
    // sit on an old stamp forever once the loop has moved on.
    assert.match(indexHtml, /budgetMin \* 2/)
    assert.match(indexHtml, /fbReload:/)
    assert.match(indexHtml, /visibilitychange/)
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
    // Root path caches like index.html, and short: a new sync must surface in
    // seconds, not after a 5-minute edge TTL.
    assert.match(headers, /^\/\n  Cache-Control: public, max-age=30, stale-while-revalidate=60/m)

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
    // Every index row is a full body: no teaser class, no hop to a day page.
    assert.doesNotMatch(indexHtml, /class="entry teaser/)
    assert.doesNotMatch(indexHtml, /open full entry/)
    assert.ok(indexHtml.includes('class="files"'), 'file chips are on the index, not only on day pages')

    // Churn is listed (complete timeline) but dimmed, unsummarized, kept out of
    // every "changes" surface -- and hidden behind the churn chip by default.
    assert.ok(isHidden(tagOf(indexHtml, 'eeee11112222')), 'churn starts hidden on the front page')
    assert.match(indexHtml, /Dependency lockfile updated/)
    assert.match(indexHtml, /\[Churn\]/)
    assert.match(indexHtml, /<span class="day-churn">\+1 churn<\/span>/)
    assert.match(indexHtml, /3 changes &middot; 1 churn/, 'hero counts changes and churn separately')
    const churnStart = indexHtml.indexOf('id="eeee11112222"')
    const churnNextRow = indexHtml.indexOf('<details class="entry ', churnStart + 30)
    const churnRow = indexHtml.slice(churnStart, churnNextRow === -1 ? churnStart + 4000 : churnNextRow)
    assert.match(churnRow, /bun\.lock/, 'churn row states which files changed')
    assert.doesNotMatch(churnRow, /View inline diff/, 'churn rows carry no source diff')
    assert.doesNotMatch(churnRow, /class="eli5"/, 'churn rows carry no plain-English line either')

    // Front-page filters: a chip per category present in this window, churn
    // hidden in the markup (so the default holds without scripting), and the
    // chip that reveals it. Nothing is removed from the document either way --
    // filtering costs no request, and the day pages stay the exhaustive view.
    assert.match(indexHtml, /<nav class="filterbar" id="filters"/)
    assert.match(indexHtml, /data-filter="\*" data-label="recent"[^>]*aria-pressed="true">recent<span class="chip-n">3<\/span>/,
      'the reset chip is named for what it counts: this window, not the database')
    assert.match(indexHtml, /data-filter="cli"/)
    assert.match(indexHtml, /data-filter="model-catalog"/)
    assert.match(indexHtml, /data-filter="churn"[^>]*aria-pressed="false">churn<span class="chip-n">1<\/span>/)
    // Chip counts are page-scoped, so every chip also carries the all-time figure
    // and where to find it: a bare "27" for CLI reads as "that is all there is".
    assert.match(indexHtml, /data-filter="cli" data-label="CLI" data-total="2" data-href="\/changes\/cli\/"/)
    assert.match(indexHtml, /data-filter="churn" data-label="churn" data-total="1" data-href="\/changes\/churn\/"/)
    assert.match(indexHtml, /id="filter-all">3 changes all-time across 2 categories <a href="\/changes\/"/,
      'the note line states the all-time total next to the page count')
    assert.equal(rowTags(indexHtml).filter(t => t.includes('data-churn="1"')).length, 1)
    assert.ok(rowTags(indexHtml).every(t => t.includes('data-cat="')), 'every row is filterable by category')
    assert.equal(rowTags(indexHtml).filter(t => !isHidden(t)).length, 3, 'three rows shown, one hidden')
    // The toggle is progressive enhancement: guarded on the bar existing, keeps
    // its state across the auto-reload, and hides a day whose rows all filtered
    // out instead of leaving a stray date header.
    assert.match(indexHtml, /getElementById\('filters'\)/)
    assert.match(indexHtml, /fbIndexFilter/)
    assert.match(indexHtml, /details\.entry:not\(\[hidden\]\)/, 'empty day sections collapse with their rows')
    // A #sha permalink into a filtered-out row must still land somewhere visible.
    assert.match(indexHtml, /location\.hash/)
    assert.match(indexHtml, /classList\.contains\('entry'\)/)
    // The guard is load-bearing for the no-JS default: the hidden attribute only
    // wins if no display rule outranks it.
    assert.match(indexHtml, /\[hidden\]\{display:none!important\}/)
    // Day pages stay exhaustive: no bar, nothing pre-hidden.
    assert.doesNotMatch(dayHtml2, /id="filters"/)
    assert.equal(rowTags(dayHtml2).filter(isHidden).length, 0, 'day pages still list churn')

    // /changes/<category>/ is the all-time half of the filter question: complete
    // lists, compact rows, one click from the full body. A chip that says "27
    // here" needs somewhere that can answer "1,413 exist".
    const hubHtml = await readFile(join(tmpDist, 'changes/index.html'), 'utf8')
    assert.equal((hubHtml.match(/class="tile"/g) || []).length, 3, 'hub lists every category plus churn')
    assert.match(hubHtml, /href="\/changes\/cli\/"><b>CLI<\/b><span>2 changes<\/span>/)
    assert.match(hubHtml, /href="\/changes\/churn\/"><b>Churn<\/b><span>1 churn commits<\/span>/)
    const cliPage = await readFile(join(tmpDist, 'changes/cli/index.html'), 'utf8')
    assert.match(cliPage, /<div class="crow" id="dddd11112222"/)
    assert.match(cliPage, /href="\/day\/2026-09-13\/#dddd11112222"/, 'compact row links to the full body')
    assert.match(cliPage, /href="https:\/\/github\.com\/CodebuffAI\/freebuff\/commit\/dddd/)
    assert.doesNotMatch(cliPage, /<details class="entry/, 'complete lists stay cheap enough to be complete')
    assert.doesNotMatch(cliPage, /id="filters"/, 'the all-time list is not the filtered window')
    assert.match(cliPage, /CATEGORY_LOG :: CLI/)
    assert.match(cliPage, /rel="canonical" href="[^"]*\/changes\/cli\/"/)
    assert.equal((cliPage.match(/<div class="crow/g) || []).length, 2, 'every CLI change, not the recent ones')
    const churnPage = await readFile(join(tmpDist, 'changes/churn/index.html'), 'utf8')
    assert.match(churnPage, /CHURN_LOG :: Churn/)
    assert.match(churnPage, /<div class="crow crow-noise" id="eeee11112222"/, 'churn is listed, not hidden, once asked for')
    await readFile(join(tmpDist, 'og/category-cli.svg'), 'utf8')
    assert.match(sitemapPages, /\/changes\/cli\//)
    assert.match(sitemapPages, /\/changes\/churn\//)
    // Archive tiles used to send a category click to a text search; they now
    // point at the complete list.
    const archivePage = await readFile(join(tmpDist, 'archive/index.html'), 'utf8')
    assert.match(archivePage, /href="\/changes\/cli\/"/)
    assert.doesNotMatch(archivePage, /href="\/search\/\?q=CLI"/, 'no category tile masquerading as a search')
    assert.match(indexHtml, /href="\/changes\/"[^>]*>\/changes</, 'nav offers the all-time browse')
    assert.equal(ruleFor(rules, '/changes/*').headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300')
    for (const url of ['/changes/', '/changes/cli/', '/changes/churn/']) {
      assert.deepEqual(duplicatedHeaders(rules, url), [], `overlapping _headers rules for ${url}`)
    }
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

// Timeline pagination. The day is the unit: a page ends where a day ends, so no
// date header is ever split across two pages, and the set of pages covers every
// entry exactly once. Built here at two changes per page so three days land on
// two pages.
test('timeline pages split on day boundaries and cover every entry once', async () => {
  const tmpDist = await mkdtemp(join(tmpdir(), 'fbweb-pages-'))
  try {
    const row = (sha, date, extra = {}) => ({
      kind: 'sync', sha, url: `https://github.com/CodebuffAI/freebuff/commit/${sha}`,
      date, day: date.slice(0, 10), month: date.slice(0, 7),
      areas: ['CLI'], category: 'CLI', significance: 'notable',
      files: { total: 1, meaningful: 1, added: [], removed: [], modified: ['a.ts'] },
      stats: { additions: 3, deletions: 1 },
      title: 'Title ' + sha[0], summary: 'Summary ' + sha[0], ...extra
    })
    // Ascending, as changelog.json is stored: buildSite reverses it for display.
    const entries = [
      row('a'.repeat(40), '2026-09-10T10:00:00Z'),
      row('b'.repeat(40), '2026-09-11T10:00:00Z'),
      row('c'.repeat(40), '2026-09-11T12:00:00Z'),
      row('d'.repeat(40), '2026-09-12T10:00:00Z'),
      row('e'.repeat(40), '2026-09-12T12:00:00Z', { noise: true, churn: 'lockfile', category: 'Churn', significance: 'noise', title: 'Only bun.lock changed', summary: 'lockfile' })
    ]
    const changelog = {
      version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-13T00:00:00Z',
      headSha: 'f'.repeat(40), counts: { entries: entries.length }, entries
    }
    await buildSite({ changelog, openPrs: [], dist: tmpDist, timelinePageSize: 2 })

    const p1 = await readFile(join(tmpDist, 'index.html'), 'utf8')
    const p2 = await readFile(join(tmpDist, 'page/2/index.html'), 'utf8')
    const pageDays = (h) => [...h.matchAll(/<section class="day" id="(\d{4}-\d{2}-\d{2})">/g)].map(m => m[1])
    const anchors = (h) => [...h.matchAll(/<details class="entry [^"]*" id="([0-9a-f]{12})"[^>]*>/g)].map(m => m[1])
    const tags = (h) => (h.match(/<details class="entry [^"]*" id="[0-9a-f]{12}"[^>]*>/g) || [])

    assert.deepEqual(pageDays(p1), ['2026-09-12', '2026-09-11'])
    assert.deepEqual(pageDays(p2), ['2026-09-10'], 'the older page carries the older days, none shared')
    assert.equal(new Set([...anchors(p1), ...anchors(p2)]).size, entries.length, 'every entry rendered exactly once')

    // Page 1 stays what it always was: no bar above the fold, one expanded row,
    // the live HEAD + countdown. Older pages get the bar top and bottom, start
    // fully collapsed, and say the data is settled rather than ticking a clock
    // over history -- the shell's reload-when-behind hook belongs to fresh data.
    assert.equal((p1.match(/<div class="pager pager-timeline/g) || []).length, 1)
    assert.equal((p2.match(/<div class="pager pager-timeline/g) || []).length, 2, 'older pages have a way back above the list too')
    assert.match(p1, /page 1 of 2/)
    assert.match(p2, /page 2 of 2/)
    assert.equal(tags(p1).filter(t => / open>$/.test(t)).length, 1, 'one open row, on the newest page only')
    assert.equal(tags(p2).filter(t => / open>$/.test(t)).length, 0)
    assert.match(p1, /class="sync-val"/)
    assert.doesNotMatch(p2, /class="sync-val"/)
    assert.match(p2, /SETTLED HISTORY/)
    assert.match(p2, /DATA AS OF \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, 'a settled page states the exact stamp it was built from')
    // The shell's aging + reload-when-behind logic keys off .sync-age
    // [data-generated]; leaving it on a history page would let a future edit
    // start refreshing someone mid-read.
    assert.doesNotMatch(p2, /class="sync-age"/)
    assert.doesNotMatch(p2, /data-generated=/)
    assert.match(p1, /class="sync-age" data-generated=/)
    assert.match(p1, /<a href="\/page\/2\/" rel="next">/)
    assert.doesNotMatch(p1, /rel="prev"/, 'nothing is newer than page 1')
    assert.match(p2, /<a href="\/" rel="prev">/)
    assert.doesNotMatch(p2, /rel="next"/, 'nothing is older than the last page')

    // Chips count this page; the all-time figure behind them does not move.
    assert.match(p1, /data-filter="\*"[^>]*>recent<span class="chip-n">3<\/span>/)
    assert.match(p2, /data-filter="\*"[^>]*>recent<span class="chip-n">1<\/span>/)
    assert.match(p1, /data-filter="cli"[^>]*data-total="4"/)
    assert.match(p2, /data-filter="cli"[^>]*data-total="4"/)
    assert.match(p2, /showing <b id="filter-count">1<\/b> of 1 rows on this page/)
    // Churn stays hidden by default on every page, in the markup, not by script.
    assert.ok(tags(p1).find(t => t.includes('data-churn="1"')).includes(' hidden'))
    assert.equal(tags(p2).filter(t => t.includes('data-churn="1"')).length, 0, 'no churn on the older page')
    // Filtering is per page but shares one memory, so page 2 honours what the
    // reader picked on page 1 instead of snapping back to the default.
    assert.match(p1, /fbIndexFilter/)
    assert.match(p2, /fbIndexFilter/)
    assert.match(p2, /getElementById\('filters'\)/)

    // Reachability: prev/next links, the timeline sitemap, and a cache rule of
    // its own that cannot collide with `/` or `/index.html`.
    const tl = await readFile(join(tmpDist, 'sitemap-timeline.xml'), 'utf8')
    assert.match(tl, /\/page\/2\//)
    assert.match(await readFile(join(tmpDist, 'sitemap.xml'), 'utf8'), /sitemap-timeline\.xml/)
    const rules = parseHeaderRules(await readFile(join(tmpDist, '_headers'), 'utf8'))
    assert.equal(ruleFor(rules, '/page/*').headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300')
    for (const url of ['/page/2/', '/page/77/']) {
      assert.deepEqual(duplicatedHeaders(rules, url), [], `overlapping _headers rules for ${url}`)
    }
  } finally {
    await rm(tmpDist, { recursive: true, force: true })
  }
})
