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
    try {
      const handled = await handle(request, env)
      if (handled) return handled
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: JSON_HEADERS })
    }
    return env.ASSETS.fetch(request)
  }
}

async function handle (request, env) {
  const url = new URL(request.url)

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
