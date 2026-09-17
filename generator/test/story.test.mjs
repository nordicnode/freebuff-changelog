import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryIndex, accessEvidence, dayStories, dayStoryLead } from '../lib/story.mjs'
import { buildSite, discordText } from '../lib/site.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = (sha, hour, line, facts = []) => ({
  sha: sha.repeat(40), day: '2026-09-16', date: `2026-09-16T${hour}:00:00Z`,
  title: hour === '00' ? 'Country tiering' : 'Grandfathering',
  files: { modified: ['common/src/constants/freebuff-countries.ts'] },
  eli5: { text: line }, facts
})

test('story note states the dated access loss beside the reassuring tiering line', () => {
  const tiering = entry('a', '00', 'This update does not change who is eligible today.',
    ['SG and IL left full access on 2026-09-15: ads fill 8-25% of requests.'])
  const grandfathering = entry('b', '01', 'Singapore and Israel subscribers who bought full-access plans before September 15 keep their full allowances.')
  const index = buildStoryIndex([tiering, grandfathering])
  const note = index.notes.get(tiering.sha)[0]
  assert.equal(note.text, 'Singapore and Israel left full access on 2026-09-15. ' + grandfathering.eli5.text)
  assert.equal(note.sha, grandfathering.sha)
  assert.equal(buildStoryIndex([tiering]).notes.size, 0)
  assert.deepEqual(buildStoryIndex([grandfathering, tiering]).notes, index.notes)
})


test('story evidence preserves supplied dates without inventing missing dates', () => {
  for (const suffix of [' on 2026-09-14', ' on 2026-09-15', '']) {
    assert.equal(accessEvidence({ facts: [`SG and IL left full access${suffix}.`] }),
      `Singapore and Israel left full access${suffix}.`)
  }
  for (const fact of ['SG and IL have not lost full access.', 'If SG and IL lost full access, subscribers could retain plans.', 'Added tests for full access.']) {
    assert.equal(accessEvidence({ facts: [fact] }), '')
  }
})

test('story links exclude unrelated categories, generic files, churn and other days', () => {
  const a = entry('a', '00', 'Eligibility is unchanged.', ['SG and IL left full access on 2026-09-15.'])
  const b = entry('b', '01', 'Subscribers keep full-access allowances.')
  for (const peer of [
    { ...b, files: { modified: ['other.ts'] } },
    { ...b, noise: true },
    { ...b, day: '2026-09-17' }
  ]) assert.equal(buildStoryIndex([a, peer]).notes.size, 0)
  for (const path of ['README.md', 'README.zh-CN.md', 'bun.lock', 'package-lock.json', 'common/tests/countries.test.ts']) {
    assert.equal(buildStoryIndex([a, b].map(e => ({ ...e, files: { modified: [path] } }))).notes.size, 0)
  }
  const snapshot = JSON.stringify([a, b])
  buildStoryIndex([a, b])
  assert.equal(JSON.stringify([a, b]), snapshot, 'derived notes never mutate cached entries')
})

test('story context reaches rendered cards, day leads, feeds and Discord', async t => {
  const dist = await mkdtemp(join(tmpdir(), 'fbweb-story-'))
  t.after(() => rm(dist, { recursive: true, force: true }))
  for (const effective of ['2026-09-14', '2026-09-15']) {
    const a = entry('a', '00', 'This update does not change who is eligible today.',
      [`SG and IL left full access on ${effective}: ad metrics.`])
    const b = entry('b', '01', 'Singapore and Israel subscribers keep their full-access allowances.')
    const entries = [a, b].map(e => ({ ...e, kind: 'sync', category: 'Core', areas: ['Core'],
      significance: 'notable', month: '2026-09', summary: e.title,
      stats: { additions: 1, deletions: 0 }, files: { ...e.files, total: 1, meaningful: 1 } }))
    const headline = `Singapore and Israel left full access on ${effective}.`
    const index = buildStoryIndex(entries)
    assert.equal(index.notes.has(b.sha), false, 'no reverse reassurance note')
    assert.equal(dayStoryLead(dayStories(index, a.day)).headline, headline)
    await buildSite({ changelog: { entries, generatedAt: a.date, headSha: b.sha }, openPrs: [], dist })
    const [html, rss, json] = await Promise.all(['day/2026-09-16/index.html', 'feed.xml', 'feed.json'].map(p => readFile(join(dist, p), 'utf8')))
    assert.ok(html.includes(`<strong>${headline}</strong>`))
    const cardStart = html.indexOf(`<details class="entry notable" id="${a.sha.slice(0, 12)}"`)
    assert.ok(cardStart >= 0)
    const card = html.slice(cardStart + 1).split('<details class="entry ')[0]
    assert.ok(card.includes('class="story-note"'))
    assert.ok(card.includes(headline))
    assert.ok(card.includes(`/day/${b.day}/#${b.sha.slice(0, 12)}`))
    assert.equal((html.match(/<div class="story-note">/g) || []).length, 1)
    assert.ok(rss.includes(headline))
    const item = JSON.parse(json).items.find(i => i.id === a.sha)
    assert.ok(item.content_html.includes(headline))
    assert.ok(item.summary.includes(headline))
    for (const plainOnly of [false, true]) {
      const text = discordText(entries[0], { plainOnly, storyNotes: index.notes.get(a.sha) })
      assert.ok(text.includes(headline))
      assert.ok(text.length <= 2000)
    }
  }
})
