// worker.js - the one line of compute on top of the static dist/.
//
// The site is a zero-dependency static build; exactly two answers need to vary
// per request:
//   /api/entry/<sha>[.json]     one entry's machine-readable record
//                               (sliced out of api/records/<day>.json via
//                               api/sha-day.json -- per-entry files would blow
//                               the Workers asset cap)
//   /release/<v>/?format=md     that release's notes as text/markdown
//                               (the same bytes as release/<v>/notes.md)
// and, belt-and-braces alongside the _redirects rule, the day-range view:
//   /from/<date>/to/<date>/     the range shell (range-view), which assembles
//                               entry cards client-side from /entry-frags/.
// Everything else falls straight through to the asset server (which still
// applies _redirects and _headers). `npm run preview` serves the same routes
// locally through dynamicRoute() in generator/cli.mjs -- keep the two in step.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }

export default {
  async fetch (request, env) {
    // Nothing may escape as a Worker-level throw: `run_worker_first` routes
    // EVERY request through here, so one uncaught TypeError answers the whole
    // zone -- static files included -- with Cloudflare's 1101 page. This exact
    // shape shipped once (assets binding missing -> env.ASSETS.fetch on
    // undefined); the catch below and fetchAsset() make that class of slip a
    // readable 500 on one route instead of a site-wide outage.
    try {
      const handled = await handle(request, env)
      if (handled) return handled
      return await fetchAsset(env, request)
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: JSON_HEADERS })
    }
  }
}

// The binding exists only because wrangler.json sets `assets.binding`; without
// it env.ASSETS is undefined and a passthrough fetch would throw into a
// zone-wide 1101. Answer for the mistake instead.
function fetchAsset (env, request) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return json({ error: 'assets binding missing: wrangler.json must set assets.binding = "ASSETS"' }, 500)
  }
  return env.ASSETS.fetch(request)
}

async function handle (request, env) {
  const url = new URL(request.url)

  if (url.pathname === '/api/how/ask') return handleHowAsk(request, env, url)
  const howAdmin = /^\/api\/how\/(queue|ack)$/.exec(url.pathname)
  if (howAdmin) return handleHowAdmin(request, env, url, howAdmin[1])

  const em = /^\/api\/entry\/([0-9a-f]{4,40})(?:\.json)?\/?$/i.exec(url.pathname)
  if (em) {
    const record = await findEntryRecord(env, request, em[1].toLowerCase())
    return record
      ? json(record, 200)
      : json({ error: `no changelog entry records ${em[1]}` }, 404)
  }

  if (url.searchParams.get('format') === 'md') {
    const rm = /^\/release\/([^/]+)\/?$/.exec(url.pathname)
    if (rm) {
      const notes = await assetText(env, request, `/release/${rm[1]}/notes.md`)
      if (notes == null) return json({ error: `no release notes for ${rm[1]}` }, 404)
      return new Response(notes, {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }
      })
    }
  }

  const fm = /^\/from\/(\d{4}-\d{2}-\d{2})\/to\/(\d{4}-\d{2}-\d{2})\/?$/.exec(url.pathname)
  if (fm) {
    const shell = await assetText(env, request, '/range-view')
    if (shell != null) return new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  return null
}

function json (obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS })
}

async function assetText (env, request, path) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'GET' }))
  return res.ok ? res.text() : null
}

// ---------------------------------------------------------------------------
// /api/how/ask - the ask box's queue.
//
// The important property here is what this endpoint CANNOT do. It enqueues and
// nothing else: it never calls the model, never reads an API key, and never
// spends anything. A public endpoint that can spend is a public endpoint that
// gets run up a bill overnight by someone who found it, and the usual defenses
// (rate limit, captcha) are all bypassable. An endpoint that can only append a
// string to a list has a worst case that is a long queue, which the admin side
// caps anyway.
//
// The writing happens in CI, on a schedule, with the key that CI already holds.
// So the public surface is free and the expensive part is on a budget by
// construction rather than by policy.

// Where the queue lives. A KV namespace, not a Durable Object: the work is
// append-and-drain, which is exactly what KV's eventual consistency tolerates.
function askStore (env) {
  return env && env.HOWTO_Q && typeof env.HOWTO_Q.get === 'function' ? env.HOWTO_Q : null
}

// How long a question is kept before it is considered abandoned. Long enough
// for a slow week, short enough that the queue reflects what people are asking
// now rather than what they asked in the spring.
const ASK_TTL_S = 60 * 60 * 24 * 90
// A hard ceiling on the backlog. Past this the guide is answering faster than
// questions arrive, and the right answer to the newest one is "not yet" rather
// than a silent drop nobody can see.
const ASK_MAX = 400
// Questions are free text from the internet. A short floor keeps "hi" out; a
// long ceiling keeps a pasted file out.
const ASK_MIN = 12
const ASK_MAX_CHARS = 300

// One canonical form per question, so "why did my model vanish?" and "why did
// my model vanish" are one paid answer rather than two. The hash is the key
// rather than the text, so the queue is a fixed size regardless of input.
function askKey (q) {
  const norm = String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return { norm, key: 'q:' + fnv(norm) }
}

function fnv (s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36) + '-' + s.length.toString(36)
}

async function handleHowAsk (request, env, url) {
  const kv = askStore(env)
  if (!kv) {
    return json({ error: 'ask queue not bound: wrangler.json must set kv_namespaces HOWTO_Q' }, 501)
  }
  if (request.method !== 'POST') {
    return json({ error: 'POST a question as {"q": "..."}' }, 405)
  }
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'body must be JSON' }, 400)
  }
  // Required to be a string rather than coerced. String(['a','b']) is "a,b",
  // String({}) is "[object Object]", and both are long enough to pass the
  // length check and end up in the queue as a question nobody asked.
  if (!body || typeof body.q !== 'string') return json({ error: 'body must be {"q": "your question"}' }, 400)
  const q = body.q.replace(/\s+/g, ' ').trim()
  if (q.length < ASK_MIN) return json({ error: `ask something a little longer than ${ASK_MIN} characters` }, 400)
  if (q.length > ASK_MAX_CHARS) return json({ error: `questions are capped at ${ASK_MAX_CHARS} characters` }, 400)

  const { norm, key } = askKey(q)
  // Dedupe first: the same question arriving twice should be one answer, and
  // the check is cheaper than the write and does not have to wait on it.
  const seen = await kv.get(key, 'json')
  if (seen) {
    return json({ queued: false, known: true, q: norm, at: seen.at, reason: seen.reason || null })
  }
  // The index IS the queue, so the cap reads the index. The first version kept
  // a separate q:count and enforced the cap against it, which is two values
  // that can disagree -- and when they did, the queue filled past the cap with
  // no complaint, because the counter was the one that had drifted.
  const asks = await listAsks(kv)
  if (asks.length >= ASK_MAX) {
    return json({ queued: false, error: 'the queue is full; the guide is answering faster than questions arrive' }, 429)
  }
  // put is not atomic with the cap check, so a burst can overshoot ASK_MAX by a
  // little. That is the intended failure: over-answering is recoverable,
  // dropping someone's question is not.
  const at = new Date().toISOString()
  await kv.put(key, JSON.stringify({ q: norm, at }), { expirationTtl: ASK_TTL_S })
  asks.push({ key, q: norm, at })
  await kv.put('q:index', JSON.stringify(asks))
  return json({ queued: true, q: norm })
}

// The whole queue, in insertion order. KV has no list operation, so the index
// is maintained as a single JSON value. It is bounded by ASK_MAX, which is the
// only reason a read-modify-write of a whole list is acceptable here.
async function listAsks (kv) {
  const idx = await kv.get('q:index', 'json')
  return Array.isArray(idx) ? idx : []
}

// Admin side, used by CI. Bearer-token gated because it returns the queue: that
// is the only sensitive thing here, and it is sensitive only in the sense that
// it is everyone's questions.
function isAdmin (request, env) {
  const want = env && env.HOWTO_ADMIN_TOKEN
  if (!want) return false
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return got.length > 0 && got === want
}

async function handleHowAdmin (request, env, url, action) {
  // Auth first, then the binding. A deployment with no token configured is shut,
  // not open, and it should say "forbidden" rather than "no binding" -- the
  // second implies the route works once someone adds a namespace, which is the
  // wrong lesson to teach from a missing secret.
  if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403)
  const kv = askStore(env)
  if (!kv) return json({ error: 'ask queue not bound' }, 501)
  const asks = await listAsks(kv)
  if (action === 'queue') return json({ asks })
  if (action === 'ack') {
    // Remove exactly what was answered, and only that. A drain that cleared the
    // whole list would silently discard questions asked while it was running.
    let body = []
    try { body = await request.json() } catch { body = [] }
    const done = new Set((body.keys || body || []).map(String))
    const kept = asks.filter(a => !done.has(a.key))
    for (const k of done) await kv.delete(k)
    await kv.put('q:index', JSON.stringify(kept))
    return json({ removed: done.size, left: kept.length })
  }
  return json({ error: 'unknown action' }, 404)
}

// The short-sha -> day map changes only by appends, and an isolate warmed
// before a deploy would otherwise serve the old map forever, so the parsed map
// is cached for a minute, not for the isolate's life.
let shaDay = { map: null, at: 0 }
async function findEntryRecord (env, request, want) {
  if (!shaDay.map || Date.now() - shaDay.at > 60000) {
    const text = await assetText(env, request, '/api/sha-day.json')
    shaDay = { map: text ? JSON.parse(text) : {}, at: Date.now() }
  }
  const map = shaDay.map
  const key = Object.prototype.hasOwnProperty.call(map, want)
    ? want
    : Object.keys(map).find(k => k.startsWith(want) || want.startsWith(k))
  if (!key) return null
  const shard = await assetText(env, request, `/api/records/${map[key]}.json`)
  if (!shard) return null
  const records = JSON.parse(shard).records || []
  return records.find(x => x.sha.startsWith(key) || key.startsWith(x.sha)) || null
}
