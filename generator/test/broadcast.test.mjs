// generator/test/broadcast.test.mjs - tests for the native Discord broadcast command
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdBroadcast } from '../cli.mjs'

const tmpData = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-broadcast-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const mockCommit = (sha, title, noise = false) => ({
  sha, date: '2026-09-12T10:00:00Z', day: '2026-09-12', author: 'dev',
  category: 'CLI', significance: 'notable', title,
  ai: { title, summary: 'Summary of ' + title },
  eli5: { text: 'Plain english explanation.' },
  noise,
  stats: { additions: 10, deletions: 2 },
  files: { total: 1, added: ['cli.ts'], modified: [], removed: [] }
})

test('cmdBroadcast: dry run prints to stdout and sends no HTTP requests', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({
    entries: [mockCommit('111111111111', 'First commit'), mockCommit('222222222222', 'Second commit')]
  }))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    lastSha: '222222222222', runs: 1
  }))

  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, json: async () => ({}) }
  }

  const res = await cmdBroadcast(['--dry-run', '--limit', '2'], { fetchImpl, dataDir: dir })
  assert.equal(res.ok, true)
  assert.equal(res.count, 2)
  assert.equal(calls.length, 0, 'dry run makes zero HTTP calls')

  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(state.lastBroadcastSha, undefined, 'dry run does not update state')
})

test('cmdBroadcast: sends commit to webhook and updates lastBroadcastSha', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({
    entries: [mockCommit('222222222222', 'Newer commit'), mockCommit('111111111111', 'Older commit')]
  }))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    lastSha: '222222222222', runs: 1, lastBroadcastSha: '111111111111'
  }))

  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) })
    return { ok: true, status: 204 }
  }

  const res = await cmdBroadcast(['--webhook', 'https://discord.com/api/webhooks/test'], { fetchImpl, dataDir: dir })
  assert.equal(res.ok, true)
  assert.equal(res.count, 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0].body.content, /Newer commit/)

  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(state.lastBroadcastSha, '222222222222')
})

test('cmdBroadcast: ignores churn/noise commits', async (t) => {
  const dir = await tmpData(t)
  await writeFile(join(dir, 'changelog.json'), JSON.stringify({
    entries: [
      mockCommit('333333333333', 'bun.lock update', true),
      mockCommit('222222222222', 'Real feature commit', false),
      mockCommit('111111111111', 'Base commit', false)
    ]
  }))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    lastSha: '333333333333', runs: 1, lastBroadcastSha: '111111111111'
  }))

  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) })
    return { ok: true, status: 204 }
  }

  const res = await cmdBroadcast(['--webhook', 'https://discord.com/api/webhooks/test'], { fetchImpl, dataDir: dir })
  assert.equal(res.ok, true)
  assert.equal(res.count, 1)
  assert.match(calls[0].body.content, /Real feature commit/)
  assert.ok(!calls.some(c => c.body.content.includes('bun.lock update')), 'noise commit was excluded')

  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(state.lastBroadcastSha, '222222222222')
})
