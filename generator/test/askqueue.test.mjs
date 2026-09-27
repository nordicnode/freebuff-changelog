// generator/test/askqueue.test.mjs - the public ask queue.
//
// The property under test is not "does it work" but "what can it cost". The
// endpoint is reachable by anyone on the internet, so the thing that matters is
// that it can only append a string to a list: it never reaches a model, never
// reads a key, and never spends. These tests pin that down, along with the
// queue mechanics that a KV read-modify-write gets wrong easily.
import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../../worker.js'

function fakeKv () {
  const store = new Map()
  return {
    store,
    get: async (k, type) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k, v) => { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)) },
    delete: async (k) => { store.delete(k) }
  }
}

const env = (kv, token = 'secret') => ({ HOWTO_Q: kv, HOWTO_ADMIN_TOKEN: token })
const queueOf = async (kv, token = 'secret') => (await (await worker.fetch(get('/api/how/queue', token), env(kv))).json()).asks

const post = (path, body, token) => new Request(`https://x${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
})

const get = (path, token) => new Request(`https://x${path}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {}
})

test('the ask box enqueues, and says so', async () => {
  const kv = fakeKv()
  const res = await worker.fetch(post('/api/how/ask', { q: 'Why did my model disappear from the picker?' }), env(kv))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.queued, true)
  assert.equal(body.q, 'why did my model disappear from the picker', 'stored normalised')
  const { asks } = await (await worker.fetch(get('/api/how/queue', 'secret'), env(kv))).json()
  assert.equal(asks.length, 1)
  assert.equal(asks[0].q, 'why did my model disappear from the picker')
  assert.ok(asks[0].key, 'the ack step addresses a question by key, not by text')
})

test('the same question twice is one answer, whatever the punctuation', async () => {
  const kv = fakeKv()
  await worker.fetch(post('/api/how/ask', { q: 'Why did my model vanish overnight?' }), env(kv))
  const again = await (await worker.fetch(post('/api/how/ask', { q: 'why did my model vanish overnight' }), env(kv))).json()
  assert.equal(again.queued, false)
  assert.equal(again.known, true)
  const { asks } = await (await worker.fetch(get('/api/how/queue', 'secret'), env(kv))).json()
  assert.equal(asks.length, 1, 'not paid for twice')
})

test('nonsense and floods are refused before they reach the queue', async () => {
  const kv = fakeKv()
  for (const q of ['hi', '', '   ', 'x'.repeat(400)]) {
    const res = await worker.fetch(post('/api/how/ask', { q }), env(kv))
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(q.slice(0, 20))}`)
  }
  assert.equal((await queueOf(kv)).length, 0)
})

test('the queue is bounded, and says it is full rather than dropping quietly', async () => {
  const kv = fakeKv()
  // Fill past the cap directly, the way a burst of concurrent posts would.
  const asks = Array.from({ length: 400 }, (_, i) => ({ key: `k${i}`, q: `question number ${i}`, at: 'now' }))
  await kv.put('q:index', JSON.stringify(asks))
  const res = await worker.fetch(post('/api/how/ask', { q: 'one more question from the internet' }), env(kv))
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.match(body.error, /full/)
})

test('the admin side is gated, and an unbound queue is a readable 501', async () => {
  const kv = fakeKv()
  assert.equal((await worker.fetch(get('/api/how/queue'), env(kv))).status, 403, 'no token')
  assert.equal((await worker.fetch(get('/api/how/queue', 'wrong'), env(kv))).status, 403, 'wrong token')
  // A token but no namespace is a deployment mistake, and says so.
  assert.equal((await worker.fetch(get('/api/how/queue', 'secret'), { HOWTO_ADMIN_TOKEN: 'secret' })).status, 501)
  // With no token configured at all the side is shut, not open, and it says
  // "forbidden" rather than "no binding": the failure mode of forgetting a
  // secret has to be "closed", and the message should not imply that adding a
  // namespace alone would open it.
  assert.equal((await worker.fetch(get('/api/how/queue', 'secret'), { HOWTO_Q: kv })).status, 403)
})

test('ack removes exactly what was answered and nothing else', async () => {
  // The bug this guards: a drain that clears the whole list throws away every
  // question asked while it was running, and the asker waits forever.
  const kv = fakeKv()
  for (const q of ['first question about models', 'second question about plans', 'third question about keys']) {
    await worker.fetch(post('/api/how/ask', { q }), env(kv))
  }
  const before = await queueOf(kv)
  assert.equal(before.length, 3)
  const res = await worker.fetch(post('/api/how/ack', { keys: [before[0].key] }, 'secret'), env(kv))
  const body = await res.json()
  assert.equal(body.removed, 1)
  assert.equal(body.left, 2)
  const after = await queueOf(kv)
  assert.deepEqual(after.map(a => a.q).sort(), ['second question about plans', 'third question about keys'])
  // The acked key is gone from the dedupe store too, so re-asking it queues
  // again rather than being silently treated as known forever.
  const reask = await (await worker.fetch(post('/api/how/ask', { q: 'first question about models' }), env(kv))).json()
  assert.equal(reask.queued, true)
})

test('GET on the ask endpoint is a 405, not a silent 404', async () => {
  const res = await worker.fetch(get('/api/how/ask'), env(fakeKv()))
  assert.equal(res.status, 405)
  assert.match((await res.json()).error, /POST/)
})

test('a malformed body is a 400 and never a worker-level throw', async () => {
  const kv = fakeKv()
  const bad = new Request('https://x/api/how/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
  const res = await worker.fetch(bad, env(kv))
  assert.equal(res.status, 400)
  // A wrong-typed value must not be coerced. String(['a','b']) is "a,b" and
  // String({}) is "[object Object]": both are long enough to pass the length
  // check, so without a type check they land in the queue as questions nobody
  // asked, and the drain pays to answer them.
  for (const bad of [{ q: 12345 }, { q: ['an', 'array'] }, { q: { toString: () => 'x'.repeat(40) } }, {}, null]) {
    assert.equal((await worker.fetch(post('/api/how/ask', bad), env(kv))).status, 400, JSON.stringify(bad))
  }
})
