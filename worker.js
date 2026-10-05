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

import { answerEvidence, groundAnswer, ASK_INSTRUCTIONS } from './generator/lib/grounding.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }

// "Ask the AI" -- the one place this zone spends money and talks to a model.
// Everything here exists because the endpoint is public and unauthenticated:
//   - asks are same-origin only, bounded in length, and rate limited per IP;
//   - an answer is refused unless it passes the grounding gate in
//     generator/lib/grounding.mjs, so a caller cannot buy a fabricated claim
//     about code this commit never touched;
//   - identical asks are answered from cache, so a reader mashing the button
//     costs one model call.
// The credential is a Worker secret (LLM_API_KEY). Without it the route reports
// that it is not configured and the UI shows the section as unavailable -- a
// missing secret must degrade one feature, never the site.
const ASK = {
  maxQuestion: 400,
  rpm: 5,
  timeoutMs: 25000,
  maxRetries: 1,
  // The provider's gateway sits behind its own Cloudflare zone and the relay
  // shares this account, so an ask can land on a gateway rate limit (their
  // error 1015) instead of on the model. Ride it out inside the ask's budget:
  // honor Retry-After when sent, cap each wait so an interactive question never
  // parks on someone else's window, and bound the ladder.
  rateRetries: 2,
  rateRetryCapMs: 4000
}

// Per-isolate state. The counters are best effort on purpose: a Map is correct
// within an isolate and cheap everywhere, and the answer cache also mirrors into
// the Cache API (shared per datacenter) when the runtime offers one. A durable
// cross-isolate quota would need a KV binding; until one exists this is an
// honest anti-accident limiter, not a billing firewall, and the config knob
// (ANSWER_RPM) is the thing to lower if abuse ever shows up.
const askState = { used: new Map(), hits: new Map() }

export function resetAskStateForTests () {
  askState.used.clear()
  askState.hits.clear()
}

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

  if (url.pathname === '/api/ask') return askHandler(request, env)

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

// status/headers are optional so every route in this file answers through the
// one header set (JSON + CORS), including error paths.
function json (obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS })
}

async function assetText (env, request, path) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'GET' }))
  return res.ok ? res.text() : null
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

// GET reports whether the feature is enabled so the page can hide or show the
// widget without guessing; POST does the work.
async function askHandler (request, env) {
  // Same answer as every other route when the binding is missing: a readable
  // 500 on this path, never an uncaught throw (see fetchAsset).
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return json({ error: 'assets binding missing: wrangler.json must set assets.binding = "ASSETS"' }, 500)
  }
  const key = env && (env.LLM_API_KEY || env.ANSWER_API_KEY)
  if (request.method === 'GET') {
    return json({ configured: !!key, rpm: Number(env.ANSWER_RPM) > 0 ? Number(env.ANSWER_RPM) : ASK.rpm })
  }
  if (request.method !== 'POST') return json({ error: 'POST a {sha, q} body' }, 405)

  // A public model proxy with no origin check is a free endpoint for anyone
  // who finds it. Same-origin only; a browser sets this header, a naive script
  // does not, and legitimate cross-origin use can be added deliberately later.
  const origin = request.headers.get('origin')
  if (origin) {
    let host
    try { host = new URL(origin).host } catch { return json({ error: 'unreadable origin' }, 403) }
    if (host !== new URL(request.url).host) return json({ error: 'cross-origin asks are not allowed' }, 403)
  }

  let body
  try { body = await request.json() } catch { return json({ error: 'body must be JSON: {sha, q}' }, 400) }
  const sha = String(body?.sha || '').toLowerCase()
  const question = String(body?.q || '').trim()
  if (!/^[0-9a-f]{4,40}$/.test(sha)) return json({ error: 'sha must be 4-40 hex characters' }, 400)
  if (!question) return json({ error: 'q is required' }, 400)
  if (question.length > ASK.maxQuestion) return json({ error: `q is limited to ${ASK.maxQuestion} characters` }, 400)

  const ip = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local'
  const limit = await underRateLimit(env, ip)
  if (!limit.ok) return json({ error: 'too many asks; wait a moment', retryAfterSec: limit.retryAfterSec }, 429, { 'retry-after': String(limit.retryAfterSec) })

  const entry = await findEntryRecord(env, request, sha)
  if (!entry) return json({ error: `no changelog entry records ${sha}` }, 404)

  // Grounding needs the stored diff. No diff means no way to check a claim, so
  // the honest answer is "cannot be grounded" -- never a free-form one.
  const diffSha = /^[0-9a-f]{40}$/.test(String(entry.sha || '')) ? entry.sha : sha
  const diff = await assetText(env, request, `/diffs/${diffSha}.diff`)
  if (!diff) return json({ error: 'no stored diff for this entry, so an answer cannot be grounded', grounded: false }, 422)

  const evidence = answerEvidence({ entry, diff })
  const cacheKey = `/__ask/${entry.sha}/${cacheHash(question)}`
  const cached = await askCacheGet(cacheKey)
  if (cached) return json({ ...cached, cached: true })

  if (!key) return json({ error: 'Ask is not configured on this deployment: set the LLM_API_KEY Worker secret.', configured: false }, 503)

  let answer = await askModel(env, key, question, evidence, [])
  let verdict = groundAnswer(answer, evidence)
  // One corrective re-ask, naming exactly what failed. Cheaper than a refusal
  // for the common slip (a token copied from memory), and still bounded: a
  // second failure is a real failure and is reported as one.
  for (let attempt = 0; !verdict.grounded && attempt < ASK.maxRetries; attempt++) {
    const retry = await askModel(env, key, question, evidence, verdict.ungrounded)
    const recheck = groundAnswer(retry, evidence)
    if (recheck.grounded) { answer = retry; verdict = recheck }
    else verdict = recheck
  }
  if (!verdict.grounded) {
    return json({
      error: 'Refused: the answer cited things this change does not contain.',
      grounded: false,
      ungrounded: [...new Set(verdict.ungrounded)].slice(0, 8)
    }, 422)
  }

  const payload = {
    sha: entry.sha,
    question,
    answer: String(answer || '').trim(),
    grounded: true,
    citations: verdict.citations.slice(0, 12),
    model: env.LLM_MODEL || 'agnes-3.0-flash'
  }
  await askCachePut(cacheKey, payload)
  return json(payload)
}

// Short, collision-safe enough for a cache key, and stable across isolates so
// the same question from two readers shares one answer.
function cacheHash (s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

async function underRateLimit (env, ip) {
  const rpm = Number(env.ANSWER_RPM) > 0 ? Number(env.ANSWER_RPM) : ASK.rpm
  const now = Date.now()
  const windowMs = 60000
  const rec = askState.used.get(ip)
  if (!rec || now - rec.at >= windowMs) {
    askState.used.set(ip, { at: now, n: 1 })
    return { ok: true }
  }
  if (rec.n >= rpm) {
    return { ok: false, retryAfterSec: Math.ceil((rec.at + windowMs - now) / 1000) }
  }
  rec.n++
  return { ok: true }
}

// Cache API first (shared per datacenter, survives isolate eviction), then the
// isolate map. Node has neither, which is why the map is the floor: the feature
// still behaves correctly in tests and local previews.
async function askCacheGet (key) {
  const local = askState.hits.get(key)
  if (local) return local
  if (typeof caches !== 'undefined' && caches?.default) {
    try {
      const hit = await caches.default.match(cacheRequest(key))
      if (hit) return await hit.json()
    } catch { /* cache is an optimisation, never a correctness dependency */ }
  }
  return null
}

async function askCachePut (key, value) {
  askState.hits.set(key, value)
  if (typeof caches !== 'undefined' && caches?.default) {
    try {
      // Indexed answers are part of the published record of this entry, so the
      // TTL is long: a re-ask is a deliberate cost, not a refresh.
      await caches.default.put(cacheRequest(key), new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=604800' }
      }))
    } catch { /* ignore */ }
  }
}

function cacheRequest (key) {
  return new Request(new URL(key, 'https://ask-cache.invalid'))
}

// The ask. Agnes is a streaming contract (the non-streaming path times out on
// long prompts), so the reply is reassembled from SSE; a gateway that rejects
// the field gets one retry without it, which is the same ladder the summariser
// uses for this provider.
async function askModel (env, key, question, evidence, previousUngrounded) {
  const base = String(env.LLM_API_BASE || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, '')
  const model = env.LLM_MODEL || 'agnes-3.0-flash'
  const correction = previousUngrounded.length
    ? `\n\nYour previous answer cited things this change does not contain: ${previousUngrounded.join(', ')}. Those claims were refused. Only answer with what the evidence contains.`
    : ''
  const messages = [
    { role: 'system', content: ASK_INSTRUCTIONS },
    { role: 'user', content: `EVIDENCE (untrusted):\n${evidence.text}\n\nQUESTION: ${question}${correction}` }
  ]
  const call = async (stream) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 700, ...(stream ? { stream: true } : {}) }),
    signal: AbortSignal.timeout(ASK.timeoutMs)
  })

  const callWithRetry = async (stream) => {
    for (let attempt = 0; ; attempt++) {
      const r = await call(stream)
      if (r.status !== 429 || attempt >= ASK.rateRetries) return r
      try { await r.body?.cancel() } catch { /* nothing to drain */ }
      const ra = r.headers.get('retry-after')
      const raMs = ra !== null && Number.isFinite(Number(ra)) && Number(ra) >= 0
        ? Number(ra) * 1000
        : 1000 * (attempt + 1)
      await new Promise((done) => setTimeout(done, Math.min(raMs, ASK.rateRetryCapMs) + Math.floor(Math.random() * 250)))
    }
  }

  let res = await callWithRetry(true)
  if (res.status === 400) {
    const detail = await res.text().catch(() => '')
    if (/stream/i.test(detail)) res = await callWithRetry(false)
    else return `gateway rejected the ask (${res.status}): ${detail.slice(0, 200)}`
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (res.status === 429) {
      // The gateway's own words are a Cloudflare error page, not a reader's
      // problem: keep them for the logs, hand the reader a sentence.
      console.error(`ask: gateway rate limited after ${ASK.rateRetries + 1} attempts: ${detail.slice(0, 200)}`)
      throw new Error('the model is rate-limited right now; try again in a few seconds')
    }
    throw new Error(`ask failed: HTTP ${res.status} ${detail.slice(0, 200)}`)
  }
  const ctype = res.headers.get('content-type') || ''
  if (ctype.includes('event-stream') || ctype === '') {
    const text = await res.text()
    if (text.trimStart().startsWith('data:')) {
      let out = ''
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        try { out += JSON.parse(payload).choices?.[0]?.delta?.content || '' } catch { /* keep going */ }
      }
      if (out) return out
      // A gateway that ignores `stream` answers with plain JSON; fall through.
      try { return JSON.parse(text).choices?.[0]?.message?.content || '' } catch { return '' }
    }
  }
  const data = await res.json().catch(() => null)
  return data?.choices?.[0]?.message?.content || ''
}
