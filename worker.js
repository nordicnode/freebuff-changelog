// worker.js - the one line of compute on top of the static dist/.
//
// The site is a zero-dependency static build; exactly three answers need to
// vary per request:
//   /api/entry/<sha>[.json]     one entry's machine-readable record
//                               (sliced out of api/records/<day>.json via
//                               api/sha-day.json -- per-entry files would blow
//                               the Workers asset cap)
//   /c/<sha>                    302 to /day/<date>#<sha> via api/sha-day.json,
//                               so the permalink resolves without JavaScript
//                               (crawlers, no-JS readers); unknown shas fall
//                               through to the /c/ shell
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

// Errors thrown with a curated reader-facing message. The top-level fetch
// catch surfaces a UserError's message verbatim; anything else becomes a
// generic 500 so internal paths and upstream error text never leak
// (CodeQL js/stack-trace-exposure).
class UserError extends Error {}

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
  // Follow-up context: how much of this widget's thread the model sees. The
  // history is client-supplied and therefore untrusted -- it only resolves
  //references like "it" or "why", never counts as evidence (the grounding gate
  // still checks every claim against the stored diff). Bounded so one long
  // thread cannot push the evidence out of the prompt or time out the ask.
  // Sized for the model's 270k-token window: a long thread is still a small
  // fraction of it, so follow-ups keep their context instead of forgetting.
  historyMax: 8,
  historyAnswerMax: 3000,
  historyTotalMax: 12000,
  // The provider's gateway sits behind its own Cloudflare zone, so an ask can
  // land on a gateway rate limit (their error 1015) instead of on the model. Ride it out inside the ask's budget:
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
//
// `counters` is the same kind of number and is read the same way: per-isolate,
// so it is a floor rather than a total (one isolate among many reports only what
// it served). It exists because this is the one route that spends money, and a
// spend with no reading at all is a spend nobody can budget.
const askState = { used: new Map(), hits: new Map(), counters: newAskCounters() }

function newAskCounters () {
  return { asked: 0, cacheHits: 0, refused: 0, notConfigured: 0, rateLimited: 0, errors: 0 }
}

function countAsk (name) {
  askState.counters[name] = (askState.counters[name] || 0) + 1
}

export function resetAskStateForTests () {
  askState.used.clear()
  askState.hits.clear()
  askState.counters = newAskCounters()
}

// Did this request come from a page on this site? The endpoint is public and
// unauthenticated, so the question is not "who is this" but "was this addressed
// deliberately" -- browsers send `Sec-Fetch-Site` on every request they make and
// `Origin` on cross-origin ones, and a bare script sends neither. Both headers
// are forgeable, so this is not authentication; it is the difference between an
// endpoint reachable by accident and one that has to be aimed at. An `Origin`
// that is present must still name this host, so a page on another site cannot
// borrow a same-origin marker to reach us.
function sameOriginRequest (request) {
  const site = request.headers.get('sec-fetch-site')
  const origin = request.headers.get('origin')
  if (!site && !origin) {
    return { ok: false, error: 'asks must come from this site: a request with no Origin or Sec-Fetch-Site header was not made from a page on it' }
  }
  if (site && site !== 'same-origin') {
    return { ok: false, error: 'asks must come from this site: the request was not made from a page on it' }
  }
  if (origin) {
    let host
    try { host = new URL(origin).host } catch { return { ok: false, error: 'asks must come from this site: unreadable origin' } }
    if (host !== new URL(request.url).host) return { ok: false, error: 'cross-origin asks are not allowed' }
  }
  return { ok: true }
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
      // A curated reader-facing message keeps its wording; anything
      // unexpected becomes a generic 500 so internal paths and upstream
      // error text never leak (CodeQL js/stack-trace-exposure). Operators
      // get the real error from `wrangler tail`.
      const msg = err instanceof UserError ? err.message : 'internal error'
      return new Response(JSON.stringify({ error: msg }), { status: 500, headers: JSON_HEADERS })
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

  // /c/<sha> without JavaScript: a 302 to the day page that holds the entry,
  // resolved through the same short-sha -> day map the /api/entry route uses.
  // The map is one static asset (api/sha-day.json), so this costs no per-sha
  // files and the asset budget is untouched; crawlers and no-JS readers land
  // on the server-rendered day page with the entry's #sha anchor. An unknown
  // sha falls through to the /c/ shell, which explains the miss.
  const cm = /^\/c\/([0-9a-f]{4,40})\/?$/i.exec(url.pathname)
  if (cm) {
    const resolved = await resolveShaKey(env, request, cm[1].toLowerCase())
    if (resolved) return Response.redirect(new URL(`/day/${resolved.day}/#${resolved.key}`, request.url).toString(), 302)
  }

  // /search/ with a query but no JavaScript: the page is an empty shell until
  // its client script fetches the multi-MB search index, so crawlers and
  // no-JS readers saw nothing. Answer the query here instead and inject the
  // top hits into the shipped page shell (see searchSsr below). A JS reader
  // never notices: the page boots from ?q= and re-renders the same hits over
  // the injected ones.
  if ((url.pathname === '/search' || url.pathname === '/search/') && request.method === 'GET') {
    const sp = url.searchParams
    if ((sp.get('q') || '').trim() || sp.get('cat') || sp.get('sig') || sp.get('aud') || sp.get('releases')) {
      const ssr = await searchSsr(env, request, sp)
      if (ssr) return ssr
    }
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
  const loaded = await loadDayRecords(env, request, want)
  if (!loaded) return null
  return loaded.records.find(x => x.sha.startsWith(loaded.key) || loaded.key.startsWith(x.sha)) || null
}

// Short-sha -> day resolution shared by /api/entry and /c/<sha>. The map is
// the build's api/sha-day.json; the parsed copy is cached for a minute because
// an isolate warmed before a deploy would otherwise serve the old map forever.
async function resolveShaKey (env, request, want) {
  if (!shaDay.map || Date.now() - shaDay.at > 60000) {
    const text = await assetText(env, request, '/api/sha-day.json')
    shaDay = { map: text ? JSON.parse(text) : {}, at: Date.now() }
  }
  const map = shaDay.map
  const key = Object.prototype.hasOwnProperty.call(map, want)
    ? want
    : Object.keys(map).find(k => k.startsWith(want) || want.startsWith(k))
  if (!key) return null
  return { key, day: map[key] }
}

// ---- /search/ server-side rendering -------------------------------------
// The /search/ page's client ranking lives in generator/lib/site.mjs (and is
// unit-tested there); importing it here would drag the whole generator --
// including its node:* imports -- into the worker bundle. This is the
// simplified port the route above runs: the same grammar (words, "exact
// phrases", -negations, cat:/aud:/sig:/is: filters), the same weights
// (title 4/3 by length, plain-English 2, category/extra 1, phrase +4,
// major +2 / notable +1), recency breaking ties, the same hit markup.
const SSR_SRANK = { minor: 0, notable: 1, major: 2 }
const SSR_SFLAG = { release: 1, breaking: 2, security: 4, model: 8, pr: 16, edited: 32, unverified: 64 }

function ssrEsc (s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function ssrParseQuery (input) {
  const words = [], phrases = [], neg = [], filters = {}
  const tokens = String(input || '').match(/-?(?:"[^"]*"|\S+)/g) || []
  for (let tok of tokens) {
    let banned = false
    if (tok.charAt(0) === '-' && tok.length > 1) { banned = true; tok = tok.slice(1) }
    if (tok.charAt(0) === '"') {
      const phrase = tok.replace(/"/g, '').trim().toLowerCase()
      if (phrase) (banned ? neg : phrases).push(phrase)
      continue
    }
    const m = /^([a-z]+):(.+)$/i.exec(tok)
    if (m) {
      const key = m[1].toLowerCase(), val = m[2].toLowerCase()
      if (!banned && key === 'cat' && val) { filters.cat = val; continue }
      if (!banned && key === 'aud' && val) { filters.aud = val; continue }
      if (!banned && key === 'sig' && val) {
        const c = /^(>=|<=|>|<|=)?([a-z]+)$/.exec(val)
        if (c && SSR_SRANK[c[2]] !== undefined) { filters.sig = { op: c[1] || '=', value: c[2] }; continue }
      }
      if (!banned && key === 'is' && val) { (filters.is || (filters.is = [])).push(val); continue }
    }
    // Unknown key: forms fall through as plain words, like the client.
    if (tok) (banned ? neg : words).push(tok.toLowerCase())
  }
  return { words, phrases, neg, filters }
}

function ssrSigOp (rowSig, op, want) {
  const r = SSR_SRANK[rowSig] || 0, x = SSR_SRANK[want]
  return op === '>=' ? r >= x : op === '<=' ? r <= x : op === '>' ? r > x : op === '<' ? r < x : r === x
}

// Index rows are the arrays search-index.json ships:
// [day, title, catIdx, sha12, sigIdx, audIdx, flags, eli5, searchText].
function ssrRank (cats, sigs, auds, ix, opts, limit) {
  const p = ssrParseQuery(opts.q)
  const w = p.words, phrases = p.phrases, neg = p.neg, f = p.filters, isList = f.is || []
  const scored = []
  for (const e of ix) {
    const c = cats[e[2]] || '', a = sigs[e[4]] || ''
    const au = (typeof e[5] === 'number' && e[5] >= 0) ? (auds[e[5]] || '') : ''
    const bits = e[6] || 0
    if (opts.cat && c !== opts.cat) continue
    if (f.cat && c.toLowerCase() !== f.cat) continue
    if (opts.sig && (SSR_SRANK[a] || 0) < (SSR_SRANK[opts.sig] || 0)) continue
    if (f.sig && !ssrSigOp(a, f.sig.op, f.sig.value)) continue
    if (opts.aud === 'unset') { if (au) continue } else if (opts.aud && au !== opts.aud) continue
    if (f.aud && (f.aud === 'unset' ? !!au : au !== f.aud)) continue
    if (opts.releases && !(bits & SSR_SFLAG.release)) continue
    let isOk = true
    for (const need of isList) {
      if (need === 'eli5') { if (!e[7]) { isOk = false; break } continue }
      const bit = SSR_SFLAG[need]
      if (bit === undefined || !(bits & bit)) { isOk = false; break }
    }
    if (!isOk) continue
    const t = e[1].toLowerCase(), cl = c.toLowerCase(), el = (e[7] || '').toLowerCase(), ex = (e[8] || '').toLowerCase()
    const all = t + ' ' + el + ' ' + cl + ' ' + ex
    let s = 0, ok = true
    for (const x of w) {
      if (t.includes(x)) s += x.length > 4 ? 4 : 3
      else if (el.includes(x)) s += 2
      else if (cl.includes(x)) s += 1
      else if (ex.includes(x)) s += 1
      else { ok = false; break }
    }
    if (!ok) continue
    for (const ph of phrases) { if (!all.includes(ph)) { ok = false; break } s += 4 }
    if (!ok) continue
    if (neg.some(x => all.includes(x))) continue
    if (a === 'major') s += 2; else if (a === 'notable') s += 1
    scored.push([s, e[0], e])
  }
  scored.sort((x, y) => y[0] - x[0] || (y[1] < x[1] ? -1 : 1))
  return { hits: scored.slice(0, limit).map(r => r[2]), total: scored.length, words: w }
}

function ssrHighlight (text, words) {
  let s = ssrEsc(text)
  for (const word of words) {
    if (!word) continue
    const escaped = word.replace(/[^a-zA-Z0-9_]/g, '\\$&')
    try {
      s = s.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark class="search-match">$1</mark>')
    } catch (_) {}
  }
  return s
}

function ssrHitHtml (e, cats, sigs, auds, words) {
  const u = '/day/' + e[0] + '/#' + e[3]
  const a = sigs[e[4]] || '', c = cats[e[2]] || ''
  const au = (typeof e[5] === 'number' && e[5] >= 0) ? (auds[e[5]] || '') : ''
  const sigTag = a === 'major' ? '<span class="badge maj">[MAJOR]</span>' : (a === 'notable' ? '<span class="badge not">[NOTABLE]</span>' : '')
  const audTag = au ? '<span class="badge aud" title="Who this change is for">[' + ssrEsc(au.toUpperCase()) + ']</span>' : ''
  const relTag = (e[6] & SSR_SFLAG.release) ? '<span class="badge ver">[RELEASE]</span>' : ''
  const brkTag = (e[6] & SSR_SFLAG.breaking) ? '<span class="badge brk">[BREAKING]</span>' : ''
  const secTag = (e[6] & SSR_SFLAG.security) ? '<span class="badge sec">[SECURITY]</span>' : ''
  const eli5Snippet = e[7] ? '<p class="search-eli5"><span class="search-eli5-lbl">PLAIN ENGLISH:</span> ' + ssrHighlight(e[7], words) + '</p>' : ''
  return '<article class="entry ' + a + '"><div class="entry-row">' +
    '<span class="entry-utc" title="commit ' + ssrEsc(e[3]) + ' \u00b7 ' + ssrEsc(e[0]) + ' UTC">' + ssrEsc(e[0]) + '</span>' +
    '<h3 class="entry-title"><a href="' + u + '">' + ssrHighlight(e[1], words) + '</a></h3>' +
    '<div class="badges"><span class="badge cat">[' + ssrEsc(c) + ']</span>' + sigTag + audTag + relTag + brkTag + secTag + '</div>' +
    '</div>' + eli5Snippet + '</article>'
}

// The index is the heaviest asset the site ships; the parsed copy is cached
// for a minute so a burst of queries does not re-fetch and re-parse
// megabytes per request. Same TTL convention as the sha-day map above.
let searchIx = { data: null, at: 0 }
async function loadSearchIndex (env, request) {
  if (!searchIx.data || Date.now() - searchIx.at > 60000) {
    let data = null
    try {
      const res = await env.ASSETS.fetch(new Request(new URL('/search-index.json', request.url), { method: 'GET' }))
      if (res.ok) data = await res.json()
    } catch (_) { data = null }
    // A missing or corrupt index must not 500 the page: cache the miss
    // briefly and let the caller fall through to the plain shell.
    searchIx = { data, at: Date.now() }
    if (!data || !Array.isArray(data.ix)) return null
  }
  return searchIx.data && Array.isArray(searchIx.data.ix) ? searchIx.data : null
}

// Rank the query against the shipped index and inject the top hits into the
// shipped /search/ shell, where the client would render them. The query is
// echoed back into the input so the no-JS form round-trips. Any miss -- no
// index, no shell, an unrecognized shell -- returns null and the request
// falls through to the plain shell, never worse than today.
async function searchSsr (env, request, sp) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null
  const payload = await loadSearchIndex(env, request)
  if (!payload || !Array.isArray(payload.ix)) return null
  const cats = payload.cats || [], sigs = payload.sigs || [], auds = payload.auds || []
  const q = (sp.get('q') || '').trim()
  const { hits, total, words } = ssrRank(cats, sigs, auds, payload.ix, {
    q,
    cat: sp.get('cat') || '',
    sig: sp.get('sig') || '',
    aud: sp.get('aud') || '',
    releases: sp.get('releases') === '1'
  }, 20)
  const shell = await assetText(env, request, '/search/')
  if (!shell) return null
  const results = hits.length
    ? '<p class="search-ssr-count" role="status">MATCHES: ' + total + ' (server-rendered; top ' + hits.length + ' shown)</p>' +
      hits.map(e => ssrHitHtml(e, cats, sigs, auds, words)).join('')
    : '<div class="search-empty"><p>$ No matches found for pattern.</p></div>'
  const hitsOpen = '<div id="hits" role="region" aria-label="Search results" tabindex="-1">'
  if (!shell.includes(hitsOpen + '</div>')) return null
  const html = shell
    .split(hitsOpen + '</div>').join(hitsOpen + results + '</div>')
    .split('<input id="q" name="q" type="search"').join('<input id="q" name="q" type="search" value="' + ssrEsc(q) + '"')
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

// Same-day neighbours for Ask context: the closest entries in the same day
// shard, so "is this related to X?" questions have something true to stand
// on. Titles plus a short summary each, capped at four: the shard is already
// in hand, so this costs no extra fetch, and summaries stay snippet-length so
// attribution cannot bleed across commits unnoticed.
function nearbyRecords (records, entry, n = 4) {
  const at = Date.parse(entry?.date || '')
  const scored = []
  for (const r of records || []) {
    if (!r || r.sha === entry.sha || r.noise || !r.title) continue
    const t = Date.parse(r.date || '')
    scored.push({ r, d: Number.isFinite(at) && Number.isFinite(t) ? Math.abs(t - at) : 0 })
  }
  scored.sort((x, y) => x.d - y.d)
  return scored.slice(0, n).map(({ r }) => ({
    short: r.short || String(r.sha || '').slice(0, 12),
    title: r.title,
    ...(r.summary ? { summary: String(r.summary).slice(0, 600) } : {})
  }))
}

async function loadDayRecords (env, request, want) {
  const resolved = await resolveShaKey(env, request, want)
  if (!resolved) return null
  const shard = await assetText(env, request, `/api/records/${resolved.day}.json`)
  if (!shard) return null
  return { key: resolved.key, records: JSON.parse(shard).records || [] }
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
  // GET is a capability probe: the page asks it before it renders the widget,
  // and it answers a boolean and the configured ceiling. It spends nothing, so
  // it stays open to anything -- including the counters below, which are what
  // makes the spend visible.
  if (request.method === 'GET') {
    return json({
      configured: !!key,
      rpm: Number(env.ANSWER_RPM) > 0 ? Number(env.ANSWER_RPM) : ASK.rpm,
      counters: { ...askState.counters }
    })
  }
  if (request.method !== 'POST') return json({ error: 'POST a {sha, q} body' }, 405)

  // A public model proxy with no origin check is a free endpoint for anyone who
  // finds it, and this one spends money per call. So a POST has to prove it came
  // from a page on this site (see sameOriginRequest). The check used to run only
  // when an `Origin` header was present, which meant a request could pass by
  // saying nothing at all: `curl` sends neither header, reached the model, and
  // billed the key. Absence is now a refusal.
  const origin = sameOriginRequest(request)
  if (!origin.ok) return json({ error: origin.error }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'body must be JSON: {sha, q}' }, 400) }
  const sha = String(body?.sha || '').toLowerCase()
  const question = String(body?.q || '').trim()
  if (!/^[0-9a-f]{4,40}$/.test(sha)) return json({ error: 'sha must be 4-40 hex characters' }, 400)
  if (!question) return json({ error: 'q is required' }, 400)
  if (question.length > ASK.maxQuestion) return json({ error: `q is limited to ${ASK.maxQuestion} characters` }, 400)
  // Follow-up thread for this widget instance. Lenient by design: absent means
  // a first question, malformed means a 400, and over-long entries are
  // truncated (never a reason to spend a model call on a rejection).
  let history = []
  if (body?.history !== undefined) {
    try {
      history = normalizeAskHistory(body.history)
    } catch {
      return json({ error: 'history must be an array of {q, a}' }, 400)
    }
  }

  const ip = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local'
  const limit = await underRateLimit(env, ip)
  if (!limit.ok) {
    countAsk('rateLimited')
    return json({ error: 'too many asks; wait a moment', retryAfterSec: limit.retryAfterSec }, 429, { 'retry-after': String(limit.retryAfterSec) })
  }

  const loaded = await loadDayRecords(env, request, sha)
  const entry = loaded?.records.find(x => x.sha.startsWith(loaded.key) || loaded.key.startsWith(x.sha))
  if (!entry) return json({ error: `no changelog entry records ${sha}` }, 404)

  // Grounding needs the stored diff. No diff means no way to check a claim, so
  // the honest answer is "cannot be grounded" -- never a free-form one.
  const diffSha = /^[0-9a-f]{40}$/.test(String(entry.sha || '')) ? entry.sha : sha
  const diff = await assetText(env, request, `/diffs/${diffSha}.diff`)
  if (!diff) {
    countAsk('refused')
    return json({ error: 'no stored diff for this entry, so an answer cannot be grounded', grounded: false }, 422)
  }

  const evidence = answerEvidence({ entry, diff, neighbors: nearbyRecords(loaded.records, entry) })
  // The cache key includes the thread: the same words after a different
  // conversation are a different ask, and answering them from a first-question
  // cache would be a wrong answer, not a saving.
  const historyKey = history.map(h => `${h.q}\n${h.a}`).join('\n>>>\n')
  const cacheKey = `/__ask/${entry.sha}/${cacheHash(question + '\n>>>\n' + historyKey)}`
  const cached = await askCacheGet(cacheKey)
  if (cached) {
    countAsk('cacheHits')
    return json({ ...cached, cached: true })
  }

  if (!key) {
    countAsk('notConfigured')
    return json({ error: 'Ask is not configured on this deployment: set the LLM_API_KEY Worker secret.', configured: false }, 503)
  }

  let answer, verdict
  try {
    countAsk('asked')
    answer = await askModel(env, key, question, evidence, [], history)
    verdict = groundAnswer(answer, evidence)
    // One corrective re-ask, naming exactly what failed. Cheaper than a refusal
    // for the common slip (a token copied from memory), and still bounded: a
    // second failure is a real failure and is reported as one.
    for (let attempt = 0; !verdict.grounded && attempt < ASK.maxRetries; attempt++) {
      const retry = await askModel(env, key, question, evidence, verdict.ungrounded, history)
      const recheck = groundAnswer(retry, evidence)
      if (recheck.grounded) { answer = retry; verdict = recheck }
      else verdict = recheck
    }
  } catch (err) {
    countAsk('errors')
    throw err
  }
  if (!verdict.grounded) {
    countAsk('refused')
    const ungrounded = [...new Set(verdict.ungrounded)].slice(0, 8)
    // A prose failure is a different shape from a bad citation: the model
    // answered from general knowledge rather than the evidence, so the
    // refusal says that instead of accusing it of citing things.
    const proseOnly = ungrounded.length === 1 && ungrounded[0] === 'prose not grounded in this change'
    return json({
      error: proseOnly
        ? 'Refused: the answer was not based on this change.'
        : 'Refused: the answer cited things this change does not contain.',
      grounded: false,
      ungrounded
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

// The follow-up thread for one widget instance. Client-supplied and therefore
// untrusted: truncated and bounded here so a hostile or merely long thread
// cannot bloat the prompt, and the model is told (in askModel) that it is
// context for references only, never evidence. Throws on a wrong shape so the
// caller answers 400; over-long strings truncate instead of rejecting, because
// a first question should not die over a long previous answer.
function normalizeAskHistory (raw) {
  if (!Array.isArray(raw)) throw new Error('history must be an array')
  const out = []
  for (const item of raw.slice(-ASK.historyMax)) {
    if (!item || typeof item !== 'object') throw new Error('history must be an array of {q, a}')
    if (typeof item.q !== 'string' || typeof item.a !== 'string') throw new Error('history entries must be {q, a} strings')
    const q = item.q.trim().slice(0, ASK.maxQuestion)
    const a = item.a.trim().slice(0, ASK.historyAnswerMax)
    if (!q || !a) continue
    out.push({ q, a })
  }
  let total = out.reduce((n, h) => n + h.q.length + h.a.length, 0)
  while (out.length > 1 && total > ASK.historyTotalMax) {
    const dropped = out.shift()
    total -= dropped.q.length + dropped.a.length
  }
  if (out.length === 1 && total > ASK.historyTotalMax) {
    const only = out[0]
    const keep = Math.max(0, ASK.historyTotalMax - only.q.length)
    only.a = only.a.slice(0, keep)
  }
  return out
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
async function askModel (env, key, question, evidence, previousUngrounded, history = []) {
  const base = String(env.LLM_API_BASE || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, '')
  const model = env.LLM_MODEL || 'agnes-3.0-flash'
  const correction = previousUngrounded.length
    ? `\n\nYour previous answer cited things this change does not contain: ${previousUngrounded.join(', ')}. Those claims were refused. Only answer with what the evidence contains.`
    : ''
  // Earlier turns in this widget stay in the prompt so "it", "that" and "why"
  // resolve; they are explicitly not evidence, so a client-invented prior
  // answer cannot smuggle a claim past the grounding gate below.
  const thread = history.length
    ? `\n\nCONVERSATION SO FAR (use only to resolve references; only the EVIDENCE above counts as fact, previous answers may be wrong):\n${history.map((h, i) => `Q${i + 1}: ${h.q}\nA${i + 1}: ${h.a}`).join('\n')}`
    : ''
  const messages = [
    { role: 'system', content: ASK_INSTRUCTIONS },
    { role: 'user', content: `EVIDENCE (untrusted):\n${evidence.text}${thread}\n\nQUESTION: ${question}${correction}` }
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
      throw new UserError('the model is rate-limited right now; try again in a few seconds')
    }
    throw new UserError(`ask failed: HTTP ${res.status} ${detail.slice(0, 200)}`)
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
