// generator/test/site.test.mjs - tests for the static site generator
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSite, modelTimeline, modelSlug, scoreHit, discordText, renderBadgeSvg, generateReleaseNotesMarkdown, entryCard } from '../lib/site.mjs'
import { feedItem, jsonItem } from '../lib/feed.mjs'
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

// Cloudflare validates _redirects against the *version*, not the build: a rule
// whose target can reach itself fails the whole deploy, and it strips `.html`
// and a trailing `/index` from the target before matching -- so
// `/c/* -> /c/index.html` is an "infinite loop" even though it looks like a
// plain rewrite. Catch it here, where it costs a test run, not a deploy.
function redirectLoops (text) {
  const bad = []
  for (const line of text.split('\n')) {
    const [from, to] = line.trim().split(/\s+/)
    if (!from || !to) continue
    for (const cand of [to, to.replace(/\.html$/, ''), to.replace(/\/index$/, '')]) {
      if (patternMatches(from, cand)) { bad.push(`${from} -> ${to}`); break }
    }
  }
  return bad
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
          hasDiff: true,
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
          // Flagged because it genuinely has one: a lockfile-only commit stores
          // its unstripped diff, so the toggle opens real content.
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
    // No countdown on the page: the loop re-analyzes the moment upstream moves, so
    // "sync due in 34m" described a schedule that never existed. The age badge and
    // its budget stay.
    assert.doesNotMatch(indexHtml, /class="sync-val"|SYNC DUE|updateSyncTimer/)
    // The age badge must key off the sync budget, not the wall-clock hour: the
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
    // The front page is one day, so an older day's entry is not on it: it lives at
    // its own URL, with the same complete body -- no teaser, no "open full entry"
    // hop, and the same one-open-row rule.
    assert.ok(!tagOf(indexHtml, 'aaaa11112222'), 'the front page holds exactly one day')
    const olderDayHtml = await readFile(join(tmpDist, 'day/2026-09-12/index.html'), 'utf8')
    assert.ok(tagOf(olderDayHtml, 'aaaa11112222'), 'older days keep their full bodies at their own URL')
    assert.match(olderDayHtml, /class="diff-viewer" data-sha="aaaa11112222/,
      'a community commit gets the inline diff toggle too -- kind is no longer a gate')
    assert.ok(isOpen(tagOf(olderDayHtml, 'aaaa11112222')), 'its newest visible row starts open there')
    assert.equal(rowTags(olderDayHtml).filter(isOpen).length, 1)
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
    assert.ok(searchIdx.ix[0].length >= 6, 'search index tuple includes ELI5 plain English text')
    assert.ok(typeof searchIdx.ix[0][5] === 'string')
    // e[6] is search-only text: touched paths and the evidence citation.
    assert.ok(searchIdx.ix.some(r => typeof r[6] === 'string' && r[6].length), 'search index tuple carries paths/evidence for identifier search')
    const searchHtml = await readFile(join(tmpDist, 'search/index.html'), 'utf8')
    // The two things that made /search/ unusable on a phone, pinned:
    // min-width:0 because a flex item defaults to min-width:auto and a long
    // placeholder is *content* (the row grew past the box); text-size-adjust
    // because mobile browsers inflate type they judge small, and the base is 13.5px.
    assert.match(searchHtml, /#q\{[^}]*min-width:0/, 'the query input must shrink below its placeholder')
    assert.match(searchHtml, /-webkit-text-size-adjust:100%/, 'no font boosting over the sheet')
    assert.match(searchHtml, /@media \(max-width:600px\)/, 'form controls go to 16px on phones so iOS does not zoom on focus')
    assert.doesNotMatch(searchHtml, /placeholder="regex/, 'the matcher is word-substring AND, not regex')
    // 360px viewport - 40 main padding - 34 box - 18 row - 6 gap - 86 for the
    // "$ grep -i" prompt = 180px of input, and a 16px monospace advance is 9.6px.
    assert.doesNotMatch(searchHtml, /placeholder="[^"]{19,}"/, 'the placeholder has to fit the narrowest phone')
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
    assert.match(dayChurn, /<span class="day-count">2 changes <span class="day-churn">\+1 churn<\/span><\/span>/,
      'the day heading still counts the churn it hides')

    const statusApi = JSON.parse(await readFile(join(tmpDist, 'api/status.json'), 'utf8'))
    assert.equal(statusApi.total, 4)
    assert.equal(statusApi.changes, 3)
    assert.equal(statusApi.churn, 1)
    assert.equal(statusApi.openPrs, 1)
    assert.equal(statusApi.models.changes, 1)
    assert.match(await readFile(join(tmpDist, '_headers'), 'utf8'), /\/pr-diffs\/\*/)
    assert.match(await readFile(join(tmpDist, '_headers'), 'utf8'), /\/feed\.json/)

    // Header policy: caching is off site-wide, no rule may collide with
    // another, and content types/CORS keep their dedicated rules.
    const headerText = await readFile(join(tmpDist, '_headers'), 'utf8')
    const rules = parseHeaderRules(headerText)
    for (const url of ['/', '/index.html', '/about/', '/day/2026-09-13/', '/release/1.0.100/',
      '/api/entries.json', '/api/status.json', '/search-index.json', '/feed.json', '/feed.xml',
      '/diffs/aaa.diff', '/pr-diffs/999.diff', '/models/', '/og/day-2026-09-13.svg', '/sitemap.xml']) {
      assert.deepEqual(duplicatedHeaders(rules, url), [], `overlapping _headers rules for ${url}`)
    }
    assert.equal(ruleFor(rules, '/*').headers['cache-control'], 'no-cache')
    assert.doesNotMatch(headerText, /max-age|stale-while-revalidate|immutable/, 'no TTL directives remain')
    assert.equal(ruleFor(rules, '/diffs/*').headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(ruleFor(rules, '/*.json').headers['access-control-allow-origin'], '*')
    assert.equal(rules.filter(r => r.path === '/feed.json').length, 1, 'single /feed.json rule')

    // The header widget must key off the budget, and a backgrounded tab must not
    // sit on an old stamp forever once the loop has moved on.
    assert.match(indexHtml, /budgetMin \* 2/)
    assert.match(indexHtml, /fbReload:/)
    assert.match(indexHtml, /visibilitychange/)
    assert.match(indexHtml, /data-head=/, 'sync-age includes commit head sha')
    assert.match(indexHtml, /\/api\/status\.json/, 'client auto-updater polls status API')
    assert.match(indexHtml, /fbPlainMode/, 'layout head and client scripts persist plain English mode')
    assert.match(indexHtml, /reading-mode-plain/, 'reading-mode-plain is supported in layout scripts')
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

    // Verify feed.xsl exists and sets data-theme="dark" with Discord bot setup guidance
    const feedXsl = await readFile(join(tmpDist, 'feed.xsl'), 'utf8')
    assert.match(feedXsl, /data-theme="dark"/)
    assert.match(feedXsl, /Discord Bot Setup/)

    // Verify favicon files exist
    const favIco = await readFile(join(tmpDist, 'favicon.ico'))
    assert.ok(favIco.length > 500)
    const favSvg = await readFile(join(tmpDist, 'favicon.svg'), 'utf8')
    assert.match(favSvg, /<svg /)

    // Verify index.html has data-theme="dark" and single SVG favicon
    assert.match(indexHtml, /<html lang="en" data-theme="dark">/)
    assert.match(indexHtml, /href="\/favicon\.svg"/)
    assert.doesNotMatch(indexHtml, /href="\/favicon\.ico"/)

    // Verify split feeds: main (all changes), major-only, models-only, releases-only with correct self links
    assert.match(feedXml, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed\.xml" rel="self"/)
    assert.match(feedXml, /xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/"/)
    assert.match(feedXml, /\[2026-09-13\] Muse Spark 1\.3 replaces Muse Spark 1\.2/)
    assert.match(feedXml, /CLI flag tweak/, 'feed.xml includes all non-noise changes including minor entries')
    assert.doesNotMatch(feedXml, /\[2026-09-13\] CLI flag tweak: CLI flag tweak/, 'description does not duplicate title')
    assert.match(feedXml, /<dc:creator>dev<\/dc:creator>/)
    assert.match(feedXml, /<category>Model Catalog<\/category>/)
    assert.match(feedXml, /<category>major<\/category>/)

    const feedMajor = await readFile(join(tmpDist, 'feed-major.xml'), 'utf8')
    assert.match(feedMajor, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed-major\.xml" rel="self"/)
    assert.match(feedMajor, /Muse Spark 1\.3 replaces Muse Spark 1\.2/)
    assert.doesNotMatch(feedMajor, /CLI flag tweak/, 'feed-major.xml excludes minor changes')

    const feedModels = await readFile(join(tmpDist, 'feed-models.xml'), 'utf8')
    assert.match(feedModels, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed-models\.xml" rel="self"/)
    assert.match(feedModels, /Muse Spark 1\.3 replaces Muse Spark 1\.2/)
    assert.match(feedModels, /Unofficial Freebuff Changelog: models/)
    const feedReleases = await readFile(join(tmpDist, 'feed-releases.xml'), 'utf8')
    assert.match(feedReleases, /<atom:link href="https:\/\/freebuff-changelog\.nordicnode\.workers\.dev\/feed-releases\.xml" rel="self"/)
    assert.match(feedReleases, /Add awesome feature/)
    assert.match(feedReleases, /Unofficial Freebuff Changelog: releases/)
    assert.match(indexHtml, /feed-major\.xml/)
    assert.match(indexHtml, /href="\/feed-models\.xml"/)
    assert.match(indexHtml, /href="\/feed-releases\.xml"/)
    // Verify _headers keeps content types, CORS, and the site-wide no-cache rule
    const headers = await readFile(join(tmpDist, '_headers'), 'utf8')
    assert.match(headers, /\/diffs\/\*/)
    assert.match(headers, /\/favicon\.ico/)
    assert.match(headers, /\/feed\.xsl/)
    assert.match(headers, /Access-Control-Allow-Origin: \*/)
    assert.equal(ruleFor(rules, '/feed.xml').headers['content-type'], 'application/rss+xml; charset=utf-8')
    assert.equal(ruleFor(rules, '/feed.xml').headers['access-control-allow-origin'], '*')
    assert.equal(ruleFor(rules, '/feed-*.xml').headers['content-type'], 'application/rss+xml; charset=utf-8')
    assert.equal(ruleFor(rules, '/feed-*.xml').headers['access-control-allow-origin'], '*')
    assert.match(headers, /^\/\*\n(?: {2}\S[^\n]*\n)*? {2}Cache-Control: no-cache/m,
      'the wildcard rule carries the site-wide no-cache')

    // Verify 404 contains noindex
    const notFoundHtml = await readFile(join(tmpDist, '404.html'), 'utf8')
    assert.match(notFoundHtml, /<meta name="robots" content="noindex">/)

    // Verify about page covers method, categories, limits
    const aboutHtml = await readFile(join(tmpDist, 'about/index.html'), 'utf8')
    assert.match(aboutHtml, /HOW IT WORKS/)
    assert.match(aboutHtml, /Deterministic first/)
    assert.match(aboutHtml, /ACCURACY &amp; ANALYSIS PIPELINE/)
    assert.match(aboutHtml, /ELI5 plain-English/)
    assert.match(aboutHtml, /LIMITS/)
    assert.match(aboutHtml, /Model Catalog/)
    assert.match(aboutHtml, /FEEDS \+ DISCORD/)
    assert.match(aboutHtml, /class="man-dl"/, 'what is tracked is a list of surfaces, not a paragraph')
    assert.match(aboutHtml, /class="man-routes"/)
    // The page explains itself; it is not allowed to become a manual again. It ran
    // to 2,300 words of prose before being cut back to the chase.
    const aboutBody = aboutHtml.split('man-body">')[1].split('</section>')[0]
    const aboutWords = aboutBody
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, 'x').replace(/\s+/g, ' ').trim().split(' ').length
    assert.ok(aboutWords < 700, `about page is ${aboutWords} words; keep it under 700`)
    assert.doesNotMatch(aboutBody, /&mdash;|\u2014/, 'about copy carries no em-dashes')

    // Verify models page: lineup, retired, history rows, nav
    const modelsHtml = await readFile(join(tmpDist, 'models/index.html'), 'utf8')
    assert.match(modelsHtml, /Free model catalog/)
    assert.match(modelsHtml, /href="\/models\/muse-spark-1-3\/"/)
    assert.match(modelsHtml, /Muse Spark 1\.3/)
    assert.match(modelsHtml, /Muse Spark 1\.2/)
    assert.match(modelsHtml, /CATALOG HISTORY \(1 CHANGES\)/)
    assert.match(modelsHtml, /\/day\/2026-09-13\/#bbbb11112222/)
    assert.match(modelsHtml, /\/models\//)
    assert.match(modelsHtml, /href="\/feed-models\.xml"/)

    // Verify per-model detail page: status, history
    const modelDetail = await readFile(join(tmpDist, 'models/muse-spark-1-3/index.html'), 'utf8')
    assert.match(modelDetail, /MODEL :: Muse Spark 1\.3/)
    assert.match(modelDetail, /\[LIVE\]|\[RETIRED\]/)
    assert.match(modelDetail, /HISTORY \(1\)/)

    // Verify stats page and nav entries
    const statsHtml = await readFile(join(tmpDist, 'stats/index.html'), 'utf8')
    assert.match(statsHtml, /TELEMETRY/)
    assert.match(statsHtml, /MOST-CHANGED MODELS/)
    assert.match(statsHtml, /class="spark"/)
    // The spark svg carries an intrinsic width, so max-width alone leaves the
    // cadence line at 300px inside a card three times as wide.
    assert.match(statsHtml, /\.cad-spark \.spark\{[^}]*width:100%/, 'the cadence line stretches to its card')
    assert.match(statsHtml, /12-MO TREND/)
    // The page opens with the numbers, not with forty bars, and shares the
    // standard layout measure with the rest of the site.
    assert.doesNotMatch(statsHtml, /class="page-wide"/, 'stats shares the standard measure with the rest of the site')
    assert.match(statsHtml, /class="stat-figure-lbl">CHANGES</)
    assert.match(statsHtml, /class="stat-row"><span class="stat-lbl">/, 'every bar is one budgeted grid row')
    assert.match(statsHtml, /class="stat-fill add"/, 'churn is drawn as added and removed, not one folded number')
    assert.doesNotMatch(statsHtml, /ACTIVITY|heat-grid/, 'the daily activity strip is gone')
    // Card order is the layout: the grid places three half-width cards side by
    // side, so WHAT COUNTED reads as adjacent to the models it weighs.
    const statCards = [...statsHtml.matchAll(/<h3>([^<]*)<\/h3>/g)].map(m => m[1])
    assert.equal(statCards.indexOf('WHAT COUNTED'), statCards.indexOf('MOST-CHANGED MODELS') + 1, 'what counted sits beside the models card')
    assert.match(statsHtml, /class="sig-seg sig-/)
    assert.match(indexHtml, /href="\/stats\/"/)

    // Verify day jump, split-view toggle, collapse, sitemap models
    const dayHtml2 = await readFile(join(tmpDist, 'day/2026-09-13/index.html'), 'utf8')
    // Every entry card carries a copy-to-Discord button whose payload is composed at
    // build time. The attribute is the risky part: a quoted attribute value has to
    // survive real newlines and markdown punctuation on its way back out of the parser.
    const dcAttr = /data-dc="([^"]*)"/.exec(dayHtml2)?.[1]
    assert.ok(dcAttr, 'the card ships a discord payload')
    assert.ok(dcAttr.includes('\n\n'), 'blank lines survive the attribute')
    assert.ok(dcAttr.startsWith('**FREEBUFF** · `'), 'it opens with the header line')
    assert.ok(dcAttr.includes('**Details**'), 'and closes with the aligned details block')
    assert.ok(!/https?:\/\//.test(dcAttr), 'it carries no links at all')
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
    assert.match(churnRow, /View inline diff/, 'a churn row opens its lockfile diff like any other row')
    assert.doesNotMatch(churnRow, /class="eli5"/, 'churn rows carry no plain-English line either')

    // Front-page filters: a chip per category present in this window, churn
    // hidden in the markup (so the default holds without scripting), and the
    // chip that reveals it. Nothing is removed from the document either way --
    // Filtering costs no request, and every day page carries the same bar and the
    // same server-side default.
    assert.match(indexHtml, /<nav class="filterbar" id="filters"/)
    assert.match(indexHtml, /data-filter="\*" data-label="recent"[^>]*aria-pressed="true">recent<span class="chip-n">2<\/span>/,
      'the reset chip counts this day, not the database')
    assert.match(indexHtml, /data-filter="cli"/)
    assert.match(indexHtml, /data-filter="model-catalog"/)
    assert.match(indexHtml, /data-filter="churn"[^>]*aria-pressed="false">churn<span class="chip-n">1<\/span>/)
    // Chip counts are page-scoped, so every chip also carries the all-time figure
    // and where to find it: a bare "27" for CLI reads as "that is all there is".
    assert.match(indexHtml, /data-filter="cli" data-label="CLI" data-total="2" data-href="\/changes\/cli\/"/)
    assert.match(indexHtml, /data-filter="churn" data-label="churn" data-total="1" data-href="\/changes\/churn\/"/)
    assert.match(indexHtml, /id="filter-all">3 changes all-time across 2 categories <a href="\/archive\/#categories"/,
      'the note line states the all-time total next to the page count')
    assert.equal(rowTags(indexHtml).filter(t => t.includes('data-churn="1"')).length, 1)
    assert.ok(rowTags(indexHtml).every(t => t.includes('data-cat="')), 'every row is filterable by category')
    assert.equal(rowTags(indexHtml).filter(t => !isHidden(t)).length, 2, 'one day per page: two changes, its churn row hidden')
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
    // A day page is the same timeline read one day at a time, so it filters the
    // same way: bar present, churn listed but hidden in markup. Nothing
    // disappears -- the day heading still counts the churn row, and one click on
    // the churn chip shows it.
    assert.match(dayHtml2, /id="filters"/)
    assert.equal(rowTags(dayHtml2).filter(t => t.includes('data-churn="1"')).length, 1, 'the churn row is still listed on its day page')
    assert.ok(rowTags(dayHtml2).find(t => t.includes('data-churn="1"')).includes(' hidden'), 'hidden by default here too')
    assert.match(dayHtml2, /<span class="day-churn">\+1 churn<\/span>/)
    assert.match(dayHtml2, /fbIndexFilter/)

    // /changes/<category>/ is the all-time half of the filter question: complete
    // lists, compact rows, one click from the full body. A chip that says "27
    // here" needs somewhere that can answer "1,413 exist".
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
    assert.equal((archivePage.match(/class="tile"/g) || []).length, 3, 'archive carries the category tiles plus churn')
    assert.match(archivePage, /href="\/changes\/cli\/"><b>CLI<\/b><span>2 changes<\/span>/)
    assert.match(archivePage, /href="\/changes\/churn\/"><b>Churn<\/b><span>1 churn commits<\/span>/)
    assert.match(archivePage, /href="\/changes\/cli\/"/)
    assert.doesNotMatch(archivePage, /href="\/search\/\?q=CLI"/, 'no category tile masquerading as a search')
    assert.doesNotMatch(indexHtml, /href="\/changes\/"[^>]*>\/changes</, 'nav no longer offers the removed hub')
    assert.match(indexHtml, /href="\/archive\/"[^>]*>\/archive</, 'nav offers the archive')
    await assert.rejects(readFile(join(tmpDist, 'changes/index.html'), 'utf8'), 'the hub page is gone')
    const redirectsTxt = await readFile(join(tmpDist, '_redirects'), 'utf8')
    assert.match(redirectsTxt, /^\/changes\/ \/archive\/ 301$/m, 'old hub URL redirects to archive')
    assert.match(redirectsTxt, /^\/watch\/ \/models\/ 301$/m, 'the removed watchlist still resolves for old bookmarks')
    assert.match(redirectsTxt, /^\/models\/\*\/feed\.xml \/feed-models\.xml 301$/m, 'deleted per-model feeds point at the model feed')
    // /c/<sha> is the date-free permalink. A day URL is a function of a timestamp
    // that has already moved once, so shared links need an address that encodes no
    // date -- and one page plus a lookup table, because ~9,500 static redirect
    // files would blow the Workers asset cap.
    const shaDay = JSON.parse(await readFile(join(tmpDist, 'api/sha-day.json'), 'utf8'))
    assert.deepEqual(Object.keys(shaDay).sort(), mockChangelog.entries.map(e => e.sha.slice(0, 12)).sort(),
      'every entry is resolvable by its anchor')
    assert.equal(shaDay[mockChangelog.entries[0].sha.slice(0, 12)], mockChangelog.entries[0].day)
    assert.match(redirectsTxt, /^\/c\/\* \/permalink 200$/m, 'the resolver answers every /c/ address')
    assert.deepEqual(redirectLoops(redirectsTxt), [], 'no rule may reach itself: Cloudflare fails the deploy on one')
    // A rewrite at a `.html` asset is answered with a 307 to the extensionless
    // path, which throws the /c/<sha> away before the resolver can read it.
    for (const line of redirectsTxt.trim().split('\n')) {
      const [, to, status] = line.trim().split(/\s+/)
      if (status === '200') assert.doesNotMatch(to, /\.html$/, `rewrite target ${to} would be canonicalized, losing the path`)
    }
    // ...and nosniff on /* means the extensionless file only renders as HTML
    // because a header rule says so.
    assert.equal(ruleFor(rules, '/permalink').headers['content-type'], 'text/html; charset=utf-8')
    // _headers matches the REQUEST path, so a rule on the rewrite target never
    // applies to a /c/<sha> hit: without its own rule the resolver arrives with no
    // Content-Type next to nosniff, and the browser downloads it instead of running
    // the script. Verified against `wrangler dev`, which reproduces exactly that.
    const onC = rules.filter(r => patternMatches(r.path, '/c/505752f9'))
    assert.deepEqual(onC.map(r => r.headers['content-type']).filter(Boolean), ['text/html; charset=utf-8'],
      'the resolver must arrive as HTML')
    assert.deepEqual(duplicatedHeaders(rules, '/c/505752f9'), [], 'no header set twice on the resolver path')
    const resolver = await readFile(join(tmpDist, 'permalink'), 'utf8')
    assert.match(resolver, /name="robots" content="noindex"/, 'a lookup page must not dilute the day pages in search')
    // It renders the entry here rather than forwarding to the day page: the card is
    // lifted out of the day page's own markup, so there is no second renderer.
    assert.match(resolver, /new DOMParser\(\)/)
    assert.match(resolver, /document\.importNode\(card, true\)/)
    assert.match(resolver, /card\.open = true/, 'shown expanded, which is the whole point')
    assert.match(resolver, /rel = 'canonical'/, 'and the day page keeps the canonical URL')
    assert.match(resolver, /<noscript>/, 'and says so when JS is off')
    // The # on a card is the permalink, so it must aim at /c/, not the day page.
    assert.match(dayHtml2, /class="permalink" href="\/c\/[0-9a-f]{12}"/)
    // The script is emitted from inside a template literal, where one backslash in
    // the source becomes nothing in the output -- an escaped regex or quote can
    // silently arrive in the page un-escaped and dead. Parse what actually shipped.
    new Function(resolver.match(/<script>([\s\S]*?)<\/script>/)[1])
    assert.doesNotMatch(headerText, /\/changes\/\*/, 'cache-only /changes/* rule retired with the hub')
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
    // One list on screen at a time, each folded by month: the page must carry all
    // three views server-side (no-JS readers see them all), and exactly the
    // newest month of each list starts open.
    assert.equal((archiveHtml.match(/class="aview"/g) || []).length, 3, 'days, releases and categories are all rendered')
    assert.equal((archiveHtml.match(/class="atab[" ]/g) || []).length, 3, 'the tab bar offers all three views')
    assert.match(archiveHtml, /data-view="days" aria-pressed="true">DAYS<span class="chip-n">2<\/span>/)
    assert.match(archiveHtml, /data-view="rel" aria-pressed="false">RELEASES<span class="chip-n">1<\/span>/)
    assert.equal((archiveHtml.match(/<details class="amonth"/g) || []).length, 2, 'one month per list, both folded')
    assert.equal((archiveHtml.match(/<details class="amonth" open/g) || []).length, 2, 'the newest month of each list is the open one')
    assert.match(archiveHtml, /id="days-m-2026-09"/)
    assert.match(archiveHtml, /Sep 2026<\/span><span class="am-meta">2 days &middot; 3 changes<\/span>/)
    assert.match(archiveHtml, /<a class="rel-chip" href="\/release\/1\.0\.100\/"/)
    assert.ok(!/release-card/.test(archiveHtml), 'the card grid is gone')
    // Release pages link back to /archive/#releases; the anchor still has to exist.
    assert.match(archiveHtml, /class="aview" data-view="rel" id="releases"/)
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

  // ELI5 matching: title matches outrank ELI5 matches, ELI5 matches outrank category matches
  const titleScore = scoreHit('CLI speedup', 'CLI', 'notable', '2026-09-13', ['speedup'], 'Terminal is faster')
  const eli5Score = scoreHit('CLI overhaul', 'CLI', 'notable', '2026-09-13', ['faster'], 'Terminal is faster')
  const catScore = scoreHit('CLI overhaul', 'Terminal CLI', 'notable', '2026-09-13', ['terminal'], 'Some note')
  assert.ok(titleScore > eli5Score, 'title match outranks ELI5 match')
  assert.ok(eli5Score > catScore, 'ELI5 match outranks category match')
  assert.ok(eli5Score > 0, 'ELI5 match produces positive score')
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

// One day per page. `/` is the newest day and every day also has a /day/<date>/
// page, which is what the permalinks aim at. Three days in this fixture so the
// boundaries, the coverage, and the per-day chrome are all visible at once.
test('the timeline paginates one day per page and keeps every entry reachable', async () => {
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
    await buildSite({ changelog, openPrs: [], dist: tmpDist })

    const latest = await readFile(join(tmpDist, 'index.html'), 'utf8')
    const d12 = await readFile(join(tmpDist, 'day/2026-09-12/index.html'), 'utf8')
    const d11 = await readFile(join(tmpDist, 'day/2026-09-11/index.html'), 'utf8')
    const d10 = await readFile(join(tmpDist, 'day/2026-09-10/index.html'), 'utf8')
    const pageDays = (h) => [...h.matchAll(/<section class="day" id="(\d{4}-\d{2}-\d{2})">/g)].map(m => m[1])
    const anchors = (h) => [...h.matchAll(/<details class="entry [^"]*" id="([0-9a-f]{12})"[^>]*>/g)].map(m => m[1])
    const tags = (h) => (h.match(/<details class="entry [^"]*" id="[0-9a-f]{12}"[^>]*>/g) || [])

    // A page *is* a day: one heading, and it matches the date in the URL.
    assert.deepEqual(pageDays(latest), ['2026-09-12'])
    assert.deepEqual(pageDays(d12), ['2026-09-12'])
    assert.deepEqual(pageDays(d11), ['2026-09-11'])
    assert.deepEqual(pageDays(d10), ['2026-09-10'])

    // Coverage. Paging by date is only honest if no day is skipped and no entry is
    // counted twice, so the day pages together have to be the whole changelog.
    const dayAnchors = [...anchors(d12), ...anchors(d11), ...anchors(d10)]
    assert.equal(dayAnchors.length, entries.length, 'every entry rendered, none on two pages')
    assert.equal(new Set(dayAnchors).size, entries.length)

    // /day/<newest>/ is not decoration: archive rows, category lists, search
    // results, feed items and related links all aim at /day/<date>/#sha, today
    // included, so today needs that URL as well as `/`.
    assert.equal(new Set(anchors(d12)).size, 2, 'the newest day holds both of its rows')
    assert.ok(latest.match(/rel="canonical" href="[^"]*\/">/), 'the front page is canonical at /')
    assert.ok(d10.match(/rel="canonical" href="[^"]*\/day\/2026-09-10\/">/), 'a day page is canonical at its own date')

    // Freshness follows the data, not the URL: both views of the newest day are
    // live. A settled day prints the stamp it was built from and carries no
    // `.sync-age`/`data-generated` hook, because that is what the shell's aging and
    // reload-when-behind logic looks for -- an auto-refresh while someone reads an
    // old day would yank the page out from under them.
    assert.match(latest, /class="sync-age"/)
    assert.match(d12, /class="sync-age"/)
    assert.match(d11, /THIS DAY IS SETTLED HISTORY/)
    assert.doesNotMatch(d11, /class="sync-val"|class="sync-age"|data-generated=/)
    assert.match(d11, /DATA AS OF \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)

    // Walking dates: older to the left (rel=prev, the site's reading order), newer
    // to the right, and the jump select on every page -- 721 days of one click at a
    // time is not navigation.
    assert.match(latest, /<a href="\/day\/2026-09-11\/" rel="prev">/)
    assert.doesNotMatch(latest, /rel="next"/, 'nothing is newer than the newest day')
    assert.match(d11, /<a href="\/day\/2026-09-10\/" rel="prev">/)
    assert.match(d11, /<a href="\/" rel="next">/, 'newer than an old day is the front page itself')
    assert.doesNotMatch(d10, /rel="prev"/, 'nothing is older than the first day')
    for (const h of [latest, d12, d11, d10]) {
      assert.match(h, /class="day-jump"/, 'every page can jump straight to a date')
      assert.match(h, /<div class="pager pager-timeline pager-timeline-top"/, 'the bar sits above the list as well as below')
    }
    // ...but the select itself appears once per page: two copies of every date in
    // the database were over half the front page's bytes, so the lower bar points
    // at the upper one instead of repeating it.
    for (const h of [latest, d11]) {
      assert.equal((h.match(/class="day-jump"/g) || []).length, 1)
      assert.equal((h.match(/<option value="\/day\//g) || []).length, 3, 'one option per day, emitted once')
    }
    assert.match(d11, /<a href="#day-jump">/)
    assert.match(d11, /id="day-jump"/)

    // Each page opens exactly one row: the day's newest entry that a reader can
    // actually see -- the flag passes over hidden churn.
    for (const h of [latest, d11, d10]) {
      assert.equal(tags(h).filter(t => / open>$/.test(t)).length, 1)
    }

    // Chips count the day. The all-time figure beside them does not move.
    assert.match(latest, /data-filter="\*"[^>]*data-total="4"[^>]*>recent<span class="chip-n">1<\/span>/)
    assert.match(d11, /data-filter="\*"[^>]*>this day<span class="chip-n">2<\/span>/, 'a day page names the reset for what it counts')
    assert.match(d11, /data-filter="cli"[^>]*data-total="4"/)
    assert.match(d11, /showing <b id="filter-count">2<\/b> of 2 rows on this page <em>\(no churn that day\)/)
    assert.match(d10, /showing <b id="filter-count">1<\/b> of 1 rows on this page/)

    // Churn is listed everywhere and shown by default nowhere: in the markup,
    // hidden by the server, counted in the heading, one click from view.
    assert.ok(tags(d12).find(t => t.includes('data-churn="1"')).includes(' hidden'))
    assert.match(d12, /<span class="day-churn">\+1 churn<\/span>/)
    assert.match(d12, /data-filter="churn"[^>]*>churn<span class="chip-n">1<\/span>/)
    // The count is the point of the note: "3 of 9" begs "where are the other 6?"
    assert.match(d12, /showing <b id="filter-count">1<\/b> of 2 rows on this page <em>\(1 churn hidden\)<\/em>/, 'the parenthetical accounts for the hidden rows by number')
    assert.equal(tags(d11).filter(t => t.includes('data-churn')).length, 0, 'that day had no churn')
    // Selection is per page but shares one memory, so walking back keeps what the
    // reader picked instead of snapping to the default.
    assert.match(d11, /fbIndexFilter/)
    assert.match(d11, /getElementById\('filters'\)/)

    // No orphan URL family: the /page/ set is gone rather than lingering as stale
    // markup, and the day pages that carry the timeline keep their own rule.
    assert.equal((await readdir(tmpDist)).includes('page'), false)
    const rules = parseHeaderRules(await readFile(join(tmpDist, '_headers'), 'utf8'))
    assert.equal(ruleFor(rules, '/*').headers['cache-control'], 'no-cache')
    assert.deepEqual(duplicatedHeaders(rules, '/day/2026-09-11/'), [], 'overlapping _headers rules for /day/2026-09-11/')
    const dayMap = await readFile(join(tmpDist, 'sitemap-days.xml'), 'utf8')
    assert.match(dayMap, /\/day\/2026-09-10\//)
    assert.doesNotMatch(dayMap, /\/page\//)

  } finally {
    await rm(tmpDist, { recursive: true, force: true })
  }
})

// A release that shipped a month of work owns 1,000+ commits, and rendering every
// one as a full entry card made /release/1.0.686/ a 2.6 MB page. The newest 40
// stay full cards; the tail stays *on the page* -- the promise is a complete
// release view -- but as the compact row the /changes/ pages already use.
test('release page: a long window folds its tail into compact rows', async () => {
  const tmpDist = await mkdtemp(join(tmpdir(), 'fbweb-rel-'))
  try {
    const row = (sha, date, extra = {}) => ({
      kind: 'sync', sha, url: `https://github.com/CodebuffAI/freebuff/commit/${sha}`,
      date, day: date.slice(0, 10), month: date.slice(0, 7),
      areas: ['CLI'], category: 'CLI', significance: 'notable',
      files: { total: 1, meaningful: 1, added: [], removed: [], modified: ['a.ts'] },
      stats: { additions: 3, deletions: 1 },
      title: 'Title ' + sha.slice(0, 6), summary: 'Summary ' + sha.slice(0, 6), ...extra
    })
    const entries = Array.from({ length: 50 }, (_, i) => row(i.toString(16).padStart(2, '0').repeat(20),
      `2026-09-11T${String(10 + (i % 8)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`))
    entries.push(row('f'.repeat(40), '2026-09-12T10:00:00Z', { version: '2.0.0', significance: 'major' }))
    await buildSite({
      changelog: { version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-13T00:00:00Z', headSha: 'f'.repeat(40), counts: { entries: entries.length }, entries },
      openPrs: [], dist: tmpDist
    })

    const rel = await readFile(join(tmpDist, 'release/2.0.0/index.html'), 'utf8')
    assert.equal((rel.match(/<details class="entry /g) || []).length, 41, 'the release plus its 40 newest commits, no more')
    assert.match(rel, /class="more-rows"/, 'the rest folds rather than stacks')
    assert.match(rel, /10 earlier commits in this release/)
    assert.equal(new Set([...rel.matchAll(/id="([0-9a-f]{12})"/g)].map(m => m[1])).size, 51,
      'nothing is dropped: every commit in the window is still on the page')
    assert.match(rel, /class="crow-title" href="\/day\/2026-09-11\/#/, 'a folded row links to the full body on its day page')
  } finally {
    await rm(tmpDist, { recursive: true, force: true })
  }
})

const dcEntry = () => ({
  kind: 'community', sha: 'a'.repeat(40), day: '2026-09-13', date: '2026-09-13T10:00:00.000Z',
  category: 'Model Catalog', significance: 'major', author: 'Ada', pr: 12,
  prUrl: 'https://github.com/CodebuffAI/freebuff/pull/12',
  url: 'https://github.com/CodebuffAI/freebuff/commit/' + 'a'.repeat(40),
  ai: { title: 'Muse Spark 1.3 ships', summary: 'Swaps muse_spark_1_2 for `muse_spark_1_3` in **backend**.' },
  eli5: { text: 'The free model was replaced with a newer one.' },
  facts: ['Adds /new /command'],
  modelChanges: { added: ['Muse Spark 1.3'], removed: ['Muse Spark 1.2'] },
  files: { total: 3 }, stats: { additions: 12, deletions: 4 }, version: '1.0.598'
})

test('discordText: organized for Discord -- labelled quote, one sentence per line, an aligned details block', () => {
  const t = discordText(dcEntry())
  assert.ok(t.length <= 2000)
  assert.ok(t.startsWith('**FREEBUFF** · `Model Catalog` · Sep 13, 2026 · **MAJOR**'), 'header line')
  assert.match(t, /^### Muse Spark 1\.3 ships$/m, 'a heading, not a plain line')
  assert.match(t, /^> \*\*In plain English\*\*\n> The free model was replaced with a newer one\.$/m, 'the ELI5 line, labelled and quoted')
  assert.ok(!/https?:\/\//.test(t), 'the paste carries no links at all')
  assert.ok(t.includes('muse\\_spark\\_1\\_2'), 'stray underscores are escaped: Discord reads them as italics')
  assert.ok(t.includes('`muse_spark_1_3`'), 'but not inside a code span, where they are already literal')
  assert.ok(t.includes('**backend**'), 'a balanced pair still renders as bold')
  const stray = discordText({ ...dcEntry(), facts: ['Five products.** No subscription needed.'] })
  assert.ok(stray.includes('- Five products. No subscription needed.'), 'a stray ** is dropped, not escaped: escaping still prints the debris')
  assert.match(t, /\*\*Model catalog\*\*\n- `−` ~~Muse Spark 1\.2~~\n- `\+` \*\*Muse Spark 1\.3\*\*/, 'retired struck, new bold, each on its own line')
  assert.match(t, /\*\*Highlights\*\*\n- Adds \/new \/command/)
  const block = /```([^`]*)```/.exec(t)[1].trim().split('\n')
  assert.match(block[0], /^commit\s+a{12}$/, 'the commit is the first row')
  assert.equal(new Set(block.map(l => l.match(/^\S+\s+/)[0].length)).size, 1, 'every value starts in the same column')
  for (const row of [/^churn\s+\+12 \/ −4$/, /^files\s+3$/, /^release\s+v1\.0\.598$/, /^pull\s+#12$/, /^author\s+Ada$/]) {
    assert.ok(block.some(l => row.test(l)), `details block is missing ${row}`)
  }
  assert.ok(!t.includes('**Links**'), 'no links section')
  // Seventeen summaries mention an endpoint as the subject of the commit. The words
  // are the content; only the reachability has to go.
  const ZW = String.fromCharCode(0x200b)
  const urls = discordText({
    ...dcEntry(), facts: [], modelChanges: null, eli5: null,
    ai: { title: 'T', summary: 'Points at https://example.com/x but keeps `https://safe.dev/y` intact. Docs at [the registry](https://npmjs.org/r).' }
  })
  assert.ok(urls.includes('`https://safe.dev/y`'), 'a URL in a code span is content and stays whole')
  assert.ok(!urls.includes('https://example.com'), 'a bare URL outside one is never linkifiable')
  assert.ok(urls.includes(`https:${ZW}//example.com`), 'and it is still readable as text')
  assert.ok(urls.includes('Docs at the registry.'), 'a markdown link collapses to its label')
  assert.ok(!/https?:\/\//.test(urls.replace(/`[^`]*`/g, '')), 'with code spans removed, not one URL is linkifiable')
  // The quote is a separate push, so it is easy to forget it needs the same care.
  const quoted = discordText({ ...dcEntry(), facts: [], modelChanges: null, eli5: { text: "It hides 'http://x' now. It reads agent_config better." } })
  assert.ok(quoted.includes(`hides 'http:${ZW}//x'`), 'the plain-English line is escaped like everything else')
  assert.ok(quoted.includes('agent\\_config'), 'including its underscores')
  // Prompt-text commits quote Discord fences verbatim, and an opened fence swallows
  // the rest of the message. Ours is the only one that survives into the paste.
  const fenced = discordText({ ...dcEntry(), facts: [], modelChanges: null, ai: { title: 'Use ``` tags', summary: 'Say ``` to fence it.' } })
  assert.equal(fenced.split('```').length - 1, 2, 'exactly one fence pair: the details block')
  assert.ok(fenced.includes('\\`'.repeat(3)), 'the data backticks arrive escaped, so they render as text')
  const prose = discordText({
    ...dcEntry(), facts: [], modelChanges: null,
    ai: { title: 'T', summary: 'First thing happened. It touched `a_b`. Third part done.' }
  })
  assert.ok(prose.includes('First thing happened.\nIt touched `a_b`.\nThird part done.'), 'a paragraph becomes one sentence per line')
})

test('discordText: the plain-English quote is never clipped', () => {
  const full = 'People filling out the welcome questions see fewer choices now. The how-you-heard list no longer offers Reddit or GitHub. Any old picks for those now count as something else, and the system recounts past answers under the new lists.'
  const t = discordText({ ...dcEntry(), facts: [], modelChanges: null, ai: { title: 'T', summary: 'Short summary.' }, eli5: { text: full } })
  assert.ok(t.includes(full.split('. ')[0]), 'quote head present')
  assert.ok(t.includes('recounts past answers'), 'quote tail present: no 300-char clip')
  assert.ok(!t.includes('…') || t.indexOf('…') > t.indexOf('recounts past answers'), 'no ellipsis inside the quote')
})

test('discordText: a monster entry still fits the 2000-char cap, giving up detail in reverse order', () => {
  const e = { ...dcEntry(), eli5: { text: 'long. '.repeat(120) }, facts: ['keep me'], ai: { title: 'T', summary: 'word '.repeat(1200) } }
  const t = discordText(e)
  assert.ok(t.length <= 2000, `${t.length} chars exceeds the Discord limit and the paste would be rejected`)
  assert.ok(!t.includes('keep me'), 'the highlights list goes first')
  assert.ok(t.includes('```'), 'the details block survives')
  assert.ok(t.includes('**In plain English**'), 'and so does the plain-English quote')
  assert.ok(t.includes('word word'), 'the summary keeps its head and loses its tail')
  assert.ok(t.includes('long. long.'), 'the quote keeps its head too, clipped only as a last resort')
})

test('discordText: plainOnly omits codeblock diffs and produces clean plain announcement', () => {
  const e = dcEntry()
  const plain = discordText(e, { plainOnly: true })
  assert.match(plain, /^### Muse Spark 1\.3 ships$/m)
  assert.ok(plain.includes('Sep 13, 2026 · 10:00 UTC'), 'plain Discord text includes formatted date and time')
  assert.match(plain, /^> \*\*In plain English\*\*\n> The free model was replaced with a newer one\.$/m)
  assert.ok(!plain.includes('```'), 'no details codeblock')
  assert.ok(!plain.includes('**Details**'), 'no details section header')
  assert.ok(!plain.includes('**Highlights**'), 'no developer highlights')

  // When entry has no ELI5, plainOnly falls back cleanly to summary
  const noEli5 = { ...e, eli5: null }
  const plainFallback = discordText(noEli5, { plainOnly: true })
  assert.ok(!plainFallback.includes('```'))
  assert.ok(plainFallback.includes('Swaps muse\\_spark\\_1\\_2'))
})

test('actionRequired: is omitted from entryCard, discordText, and feed items', () => {
  const sample = {
    kind: 'sync',
    sha: '1234567890abcdef1234567890abcdef12345678',
    date: '2026-09-14T12:00:00Z',
    day: '2026-09-14',
    category: 'CLI',
    significance: 'major',
    title: 'Model config syntax updated',
    summary: 'The model configuration schema has been migrated.',
    stats: { additions: 15, deletions: 5 },
    files: { total: 2, meaningful: 2, added: [], modified: ['cli/src/config.ts'], removed: [] },
    ai: {
      title: 'Model config syntax updated',
      summary: 'The model configuration schema has been migrated to v2.',
      actionRequired: 'Update ~/.freebuff/models.json to use the model_ids array format.'
    },
    eli5: {
      text: 'You need to update your models configuration file because the layout changed.'
    }
  }

  // 1. entryCard
  const cardHtml = entryCard(sample)
  assert.doesNotMatch(cardHtml, /class="action-required"/)
  assert.doesNotMatch(cardHtml, /ACTION REQUIRED/)

  // 2. discordText
  const dc = discordText(sample)
  assert.doesNotMatch(dc, /Action Required/)

  // 3. feedItem (RSS)
  const itemXml = feedItem('https://freebuff-changelog.nordicnode.workers.dev', sample, (e) => e.title)
  assert.doesNotMatch(itemXml, /Action Required/)

  // 4. jsonItem
  const jItem = jsonItem('https://freebuff-changelog.nordicnode.workers.dev', sample, (e) => e.title)
  assert.doesNotMatch(jItem.summary, /Action Required/)
  assert.doesNotMatch(jItem.content_html, /Action Required/)
})

test('in-flight page is honest about a short or stale PR list', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'fbweb-inflight-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  const one = {
    kind: 'community', sha: 'aaaa111122223333444455556666777788889999', date: '2026-09-12T10:00:00Z',
    day: '2026-09-12', author: 'dev', areas: ['CLI'], category: 'CLI', significance: 'notable',
    title: 'Add awesome feature', summary: 'A feature.', stats: { additions: 10, deletions: 2 },
    files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['a.ts'], removed: [], renamed: [], modified: [] }
  }
  const changelog = {
    version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-15T00:00:00Z',
    headSha: 'a'.repeat(40), counts: { entries: 1 }, entries: [one]
  }
  const prs = Array.from({ length: 60 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, author: 'x', created: '2026-09-01T00:00:00Z' }))

  await buildSite({ changelog, openPrs: prs, prMeta: { total: 116, ageMin: 4 }, dist })
  const short = await readFile(join(dist, 'in-flight/index.html'), 'utf8')
  assert.match(short, /<span>60 of 116 open<\/span>/, 'the header names GitHub\'s count, not just our row count')
  assert.match(short, /56 are not listed yet/, 'and says how many are missing')
  assert.doesNotMatch(short, /Last successful check/, 'a four-minute-old list is not stale')

  await buildSite({ changelog, openPrs: prs, prMeta: { total: 60, ageMin: 300 }, dist })
  const stale = await readFile(join(dist, 'in-flight/index.html'), 'utf8')
  assert.match(stale, /<span>60 open<\/span>/, 'a complete list shows a bare count')
  assert.match(stale, /Last successful check was 5 h ago/, 'but a five-hour silence is announced, not hidden')
  assert.doesNotMatch(stale, /not listed yet/)

  await buildSite({ changelog, openPrs: prs, prMeta: { total: 116, ageMin: 2 }, dist })
  const status = JSON.parse(await readFile(join(dist, 'api/status.json'), 'utf8'))
  assert.equal(status.openPrsTotal, 116, 'the API carries the authoritative count too')
  assert.equal(status.openPrsCheckedMinAgo, 2, 'and when it was last checked')
})

test('renderBadgeSvg: generates valid shields-style SVG XML', () => {
  const svg = renderBadgeSvg('freebuff', 'v1.0.63', '#0969da')
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(svg, /width="\d+" height="20"/)
  assert.match(svg, /fill="#0969da"/)
  assert.match(svg, /<text[^>]*>freebuff<\/text>/)
  assert.match(svg, /<text[^>]*>v1\.0\.63<\/text>/)
  assert.match(svg, /<\/svg>$/)
})

test('generateReleaseNotesMarkdown: organizes release commits into GitHub release markdown', () => {
  const rel = { version: '1.0.63', date: '2024-09-19T12:00:00Z', sha: '11111111' }
  const commits = [
    { sha: 'aaaa2222', significance: 'major', title: 'Major new agent capability', category: 'Feature' },
    { sha: 'bbbb3333', category: 'Model Catalog', title: 'DeepSeek V4 added', modelChanges: { added: ['DeepSeek V4'] } },
    { sha: 'cccc4444', category: 'CLI', title: 'fix: parse flags properly' },
    { sha: 'dddd5555', category: 'Bug Fix', title: 'Resolve race condition in worker' }
  ]
  const md = generateReleaseNotesMarkdown(rel, commits)
  assert.match(md, /^# Freebuff v1\.0\.63 \(2024-09-19\)/)
  assert.match(md, /## Features & Highlights/)
  assert.match(md, /Major new agent capability/)
  assert.match(md, /## Model Catalog Updates/)
  assert.match(md, /DeepSeek V4 added/)
  assert.match(md, /## CLI & Commands/)
  assert.match(md, /## Bug Fixes & Refactors/)
  assert.doesNotMatch(md, /[\u{1F300}-\u{1FAFF}]/u, 'no emojis in release notes markdown')
  assert.match(md, /\*Generated by \[Freebuff Changelog\]/)
})

test('in-flight page renders review badges and comment activity', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'fbweb-review-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  const changelog = {
    version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-15T00:00:00Z',
    headSha: 'a'.repeat(40), counts: { entries: 1 },
    entries: [{
      kind: 'community', sha: 'aaaa111122223333444455556666777788889999', date: '2026-09-12T10:00:00Z',
      day: '2026-09-12', author: 'dev', areas: ['CLI'], category: 'CLI', significance: 'notable',
      title: 'A feature', summary: 'A feature.', stats: { additions: 1, deletions: 1 },
      files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['a.ts'], removed: [], renamed: [], modified: [] }
    }]
  }
  const prs = [
    {
      number: 101, title: 'Approved PR', author: 'alice', created: '2026-09-01T00:00:00Z',
      reviewState: 'APPROVED', comments: 4, reviewComments: 2,
      labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'cli', color: '1d76db' }],
      commitsList: [
        { sha: 'abcdef1234', message: 'feat: add awesome feature', author: 'alice', date: '2026-09-01', url: 'https://github.com/CodebuffAI/freebuff/commit/abcdef1234' }
      ],
      commentsList: [
        { id: 1, author: 'reviewer1', body: 'Looks great to me!', created: '2026-09-01 12:00', url: 'https://github.com/CodebuffAI/freebuff/pull/101#issuecomment-1', isReview: false },
        { id: 2, author: 'reviewer2', body: 'Please verify error handling', created: '2026-09-01 13:00', url: 'https://github.com/CodebuffAI/freebuff/pull/101#discussion_r1', isReview: true, path: 'src/cli.ts', line: 42 }
      ]
    },
    { number: 102, title: 'Changes Requested PR', author: 'bob', created: '2026-09-02T00:00:00Z', reviewState: 'CHANGES_REQUESTED', comments: 1, reviewComments: 0 },
    { number: 103, title: 'In Review PR', author: 'carol', created: '2026-09-03T00:00:00Z', reviewState: 'COMMENTED', comments: 0, reviewComments: 5 }
  ]
  await buildSite({ changelog, openPrs: prs, dist })
  const html = await readFile(join(dist, 'in-flight/index.html'), 'utf8')
  assert.match(html, /class="pr-review-badge approved">\[APPROVED\]<\/span>/)
  assert.match(html, /class="pr-review-badge changes-requested">\[CHANGES REQUESTED\]<\/span>/)
  assert.match(html, /4 comments &middot; 2 reviews/)
  assert.match(html, /1 comment/)
  assert.match(html, /5 reviews/)
  assert.match(html, /\[enhancement\]/)
  assert.match(html, /\[cli\]/)
  assert.match(html, /feat: add awesome feature/)
  assert.match(html, /abcdef1234/)
  assert.match(html, /@reviewer1/)
  assert.match(html, /Looks great to me!/)
  assert.match(html, /\[review: src\/cli\.ts:42\]/)
  assert.match(html, /Please verify error handling/)
  assert.match(html, /FILTER TAG:/)
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u, 'no emojis on in-flight page')
})

test('site build generates dynamic SVG status badges and reading progress bar', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'fbweb-badges-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  const changelog = {
    version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-15T00:00:00Z',
    headSha: 'a'.repeat(40), counts: { entries: 1 },
    entries: [{
      kind: 'community', sha: 'aaaa111122223333444455556666777788889999', date: '2026-09-12T10:00:00Z',
      day: '2026-09-12', author: 'dev', areas: ['CLI'], category: 'CLI', significance: 'notable',
      title: 'A feature', summary: 'A feature.', version: '1.0.99', stats: { additions: 1, deletions: 1 },
      files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['a.ts'], removed: [], renamed: [], modified: [] }
    }]
  }
  await buildSite({ changelog, openPrs: [], dist })
  const verBadge = await readFile(join(dist, 'badge/version.svg'), 'utf8')
  const modelsBadge = await readFile(join(dist, 'badge/models.svg'), 'utf8')
  const statusBadge = await readFile(join(dist, 'badge/status.svg'), 'utf8')
  const changesBadge = await readFile(join(dist, 'badge/changes.svg'), 'utf8')
  assert.match(verBadge, /v1\.0\.99/)
  assert.match(modelsBadge, /free models/)
  assert.match(statusBadge, /changelog/)
  assert.match(changesBadge, /tracked changes/)

  const indexHtml = await readFile(join(dist, 'index.html'), 'utf8')
  assert.match(indexHtml, /<div id="reading-progress" aria-hidden="true"><\/div>/)
  assert.match(indexHtml, /setupReadingProgress/)
})

test('models page includes interactive lineup matrix and date scrubber', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'fbweb-matrix-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  const modelEntry = {
    kind: 'community', sha: 'bbbb222233334444555566667777888899990000', date: '2026-09-12T10:00:00Z',
    day: '2026-09-12', author: 'dev', areas: ['Models'], category: 'Model Catalog', significance: 'major',
    title: 'New Model Added', summary: 'Added model.', modelChanges: { added: ['SuperModel 1.0'], removed: [] },
    stats: { additions: 5, deletions: 1 },
    files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['README.md'], removed: [], renamed: [], modified: [] }
  }
  const changelog = {
    version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-15T00:00:00Z',
    headSha: 'a'.repeat(40), counts: { entries: 1 }, entries: [modelEntry]
  }
  await buildSite({ changelog, openPrs: [], dist })
  const modelsHtml = await readFile(join(dist, 'models/index.html'), 'utf8')
  assert.match(modelsHtml, /class="model-matrix-wrap"/)
  assert.match(modelsHtml, /id="matrix-slider"/)
  assert.match(modelsHtml, /CATALOG DATE SCRUBBER/)
  assert.match(modelsHtml, /class="model-matrix-table"/)
  assert.match(modelsHtml, /SuperModel 1\.0/)
  assert.match(modelsHtml, /data-filter="all"/)
  assert.match(modelsHtml, /data-filter="live"/)
  assert.match(modelsHtml, /data-filter="retired"/)
  assert.doesNotMatch(modelsHtml, /id="matrix-active-list"/, 'no duplicate matrix active list')
  assert.doesNotMatch(modelsHtml, /class="model-grid"/, 'no duplicate model grid in hero')

  // Verify shortcuts button deduplication across site
  const footerKbMatches = (modelsHtml.match(/data-kb-modal/g) || []).length
  // 1 in footer shortcuts button, 1 in about page text if present, 1 in modal listener / dialog close
  assert.doesNotMatch(modelsHtml, /class="footer-links"[^>]*>[\s\S]*?\[shortcuts/, 'no duplicate shortcuts in footer-links')
  assert.doesNotMatch(modelsHtml, /class="timeline-bulk-toggle"[^>]*>[\s\S]*?\[shortcuts/, 'no duplicate shortcuts in timeline-bulk-toggle')
  assert.match(modelsHtml, /<div class="footer-shortcuts">[\s\S]*?<button[^>]*data-kb-modal[^>]*>\[\?\]<\/button>/, 'footer has single dedicated shortcuts [?] button')
})

test('in-flight page paginates open PRs into pages of 25 with keyboard and pill navigation', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'fbweb-inflight-pager-'))
  t.after(() => rm(dist, { recursive: true, force: true }))

  const one = {
    kind: 'community', sha: 'aaaa111122223333444455556666777788889999', date: '2026-09-12T10:00:00Z',
    day: '2026-09-12', author: 'dev', areas: ['CLI'], category: 'CLI', significance: 'notable',
    title: 'Add awesome feature', summary: 'A feature.', stats: { additions: 10, deletions: 2 },
    files: { total: 1, meaningful: 1, rawMeaningful: 1, testOnly: false, added: ['a.ts'], removed: [], renamed: [], modified: [] }
  }
  const changelog = {
    version: 1, repo: 'CodebuffAI/freebuff', generatedAt: '2026-09-15T00:00:00Z',
    headSha: 'a'.repeat(40), counts: { entries: 1 }, entries: [one]
  }
  const prs = Array.from({ length: 65 }, (_, i) => ({
    number: i + 1,
    title: `Community contribution #${i + 1}`,
    author: `coder-${i + 1}`,
    created: '2026-09-01T00:00:00Z',
    labels: i % 2 === 0 ? ['ui'] : ['cli']
  }))

  await buildSite({ changelog, openPrs: prs, prMeta: { total: 65, ageMin: 5 }, dist })

  // Page 1 (index.html)
  const page1 = await readFile(join(dist, 'in-flight/index.html'), 'utf8')
  assert.match(page1, /<span>65 open<\/span>/)
  assert.match(page1, /Showing <b id="pr-filter-count">25<\/b> of 25 PRs on this page \(PRs 1&ndash;25 of 65 total &middot; page 1 of 3\)/)
  assert.match(page1, /Community contribution #1<\/a>/)
  assert.match(page1, /Community contribution #25<\/a>/)
  assert.doesNotMatch(page1, /Community contribution #26<\/a>/)
  assert.match(page1, /<a href="\/in-flight\/page\/2\/" rel="next">older PRs &rarr;<\/a>/)
  assert.match(page1, /<span class="pager-disabled">&larr; newer PRs<\/span>/)
  assert.match(page1, /<span class="pager-num active">\[1\]<\/span>/)
  assert.match(page1, /<a href="\/in-flight\/page\/2\/" class="pager-num">\[2\]<\/a>/)
  assert.match(page1, /<a href="\/in-flight\/page\/3\/" class="pager-num">\[3\]<\/a>/)

  // Page 1 canonical alias (page/1/index.html)
  const page1Alias = await readFile(join(dist, 'in-flight/page/1/index.html'), 'utf8')
  assert.equal(page1Alias, page1)

  // Page 2
  const page2 = await readFile(join(dist, 'in-flight/page/2/index.html'), 'utf8')
  assert.match(page2, /Showing <b id="pr-filter-count">25<\/b> of 25 PRs on this page \(PRs 26&ndash;50 of 65 total &middot; page 2 of 3\)/)
  assert.doesNotMatch(page2, /Community contribution #25<\/a>/)
  assert.match(page2, /Community contribution #26<\/a>/)
  assert.match(page2, /Community contribution #50<\/a>/)
  assert.doesNotMatch(page2, /Community contribution #51<\/a>/)
  assert.match(page2, /<a href="\/in-flight\/" rel="prev">&larr; newer PRs<\/a>/)
  assert.match(page2, /<a href="\/in-flight\/page\/3\/" rel="next">older PRs &rarr;<\/a>/)
  assert.match(page2, /<a href="\/in-flight\/" class="pager-num">\[1\]<\/a>/)
  assert.match(page2, /<span class="pager-num active">\[2\]<\/span>/)

  // Page 3 (final page)
  const page3 = await readFile(join(dist, 'in-flight/page/3/index.html'), 'utf8')
  assert.match(page3, /Showing <b id="pr-filter-count">15<\/b> of 15 PRs on this page \(PRs 51&ndash;65 of 65 total &middot; page 3 of 3\)/)
  assert.match(page3, /Community contribution #51<\/a>/)
  assert.match(page3, /Community contribution #65<\/a>/)
  assert.match(page3, /<a href="\/in-flight\/page\/2\/" rel="prev">&larr; newer PRs<\/a>/)
  assert.match(page3, /<span class="pager-disabled">older PRs &rarr;<\/span>/)
  assert.match(page3, /<span class="pager-num active">\[3\]<\/span>/)

  // Verify n / p keyboard script has no flawed first-child / last-child fallbacks
  assert.match(page1, /\.pager a\[rel=/, 'script strictly targets rel pager links')
  assert.doesNotMatch(page1, /\.pager a:(?:first|last)-child/, 'no broken first-child/last-child fallbacks that bounce pages')
  assert.match(page1, /ctrlKey \|\| e\.metaKey \|\| e\.altKey/, 'modifier keys like Cmd+P / Ctrl+P are protected')
})


