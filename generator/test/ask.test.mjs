// generator/test/ask.test.mjs - the "Ask the AI" feature.
//
// Two things are being defended here, and they are the two things that make the
// feature safe rather than merely present:
//   1. the grounding gate refuses an answer that claims code this commit does
//      not contain -- including the citation forms and the line ranges;
//   2. the edge route cannot be used as a free model proxy: it validates,
//      rate limits, refuses when ungrounded, and costs nothing twice.
import test from 'node:test'
import assert from 'node:assert/strict'
import worker, { resetAskStateForTests } from '../../worker.js'
import { parseDiff, answerEvidence, groundAnswer, ASK_INSTRUCTIONS } from '../lib/grounding.mjs'
import { entryCard } from '../lib/site.mjs'

const SHA = 'a'.repeat(40)
const DIFF = [
  'diff --git a/src/agents/freebuff.ts b/src/agents/freebuff.ts',
  'index 1111111..2222222 100644',
  '--- a/src/agents/freebuff.ts',
  '+++ b/src/agents/freebuff.ts',
  '@@ -10,6 +10,9 @@ export function freebuffAgent () {',
  '   const model = resolveModel()',
  '-  const name = "mimo-2.5"',
  '+  const name = MODEL.displayName',
  '+  prompt.instructions = `Use ${MODEL.displayName}`',
  '+  cache.displayName = MODEL.displayName',
  '   return name',
  ' }',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,3 @@',
  '+The assistant now names the current model.'
].join('\n')

const entry = {
  sha: SHA,
  title: 'MiMo free agents use current model display name in prompts',
  ai: { title: 'MiMo free agents use current model display name in prompts', summary: 'The free-tier assistant now prints the current model name.' },
  eli5: { text: 'The assistant refers to the model by its current name.' }
}

const evidence = () => answerEvidence({ entry, diff: DIFF })

// --- grounding -----------------------------------------------------------------

test('parseDiff: which files it touched and which new-file lines each hunk covers', () => {
  const { files, ranges } = parseDiff(DIFF)
  assert.deepEqual([...files].sort(), ['README.md', 'src/agents/freebuff.ts'])
  // @@ -10,6 +10,9 @@ covers new-file lines 10..18; @@ -1,2 +1,3 @@ covers 1..3.
  assert.deepEqual(ranges.get('src/agents/freebuff.ts'), [[10, 18]])
  assert.deepEqual(ranges.get('README.md'), [[1, 3]])
})

test('groundAnswer: an answer built from the evidence passes, with its citations', () => {
  const answer = 'The model name now comes from `MODEL.displayName` [src/agents/freebuff.ts:12], and `prompt.instructions` is set the same way [src/agents/freebuff.ts:13].'
  const v = groundAnswer(answer, evidence())
  assert.equal(v.grounded, true, JSON.stringify(v.ungrounded))
  assert.deepEqual(v.citations.map(c => `${c.file}:${c.line}`), ['src/agents/freebuff.ts:12', 'src/agents/freebuff.ts:13'])
})

test('groundAnswer: a claim about code this change does not contain is refused, and named', () => {
  const v = groundAnswer('It also sets `RETRY_BACKOFF_MS` and touches [src/gateway/retry.ts].', evidence())
  assert.equal(v.grounded, false)
  assert.deepEqual(v.ungrounded, ['`RETRY_BACKOFF_MS`', '[src/gateway/retry.ts]'])
})

test('groundAnswer: a citation outside every hunk is a line this change never wrote', () => {
  const inside = groundAnswer('Changed at [src/agents/freebuff.ts:10].', evidence())
  assert.equal(inside.grounded, true, 'the first line of the hunk is inside it')
  const outside = groundAnswer('Changed at [src/agents/freebuff.ts:99].', evidence())
  assert.equal(outside.grounded, false, 'line 99 is not in any hunk')
  assert.deepEqual(outside.ungrounded, ['[src/agents/freebuff.ts:99]'])
  const deletedOnly = groundAnswer('Touched [README.md:7].', evidence())
  assert.equal(deletedOnly.grounded, false, 'README.md covers lines 1-3 only')
})

test('groundAnswer: fences, placeholders and bare numbers are not claims', () => {
  const v = groundAnswer('```ts\nconst name = MODEL.displayName\n```\nSee <sha> or version 42 and 1.2.3.', evidence())
  assert.equal(v.grounded, true, JSON.stringify(v.ungrounded))
  // The content inside a fence is still checked: only the markers are stripped.
  const bad = groundAnswer('```ts\nconst x = RETRY_BACKOFF_MS\n```', evidence())
  assert.equal(bad.grounded, false, 'code inside a fence is a claim too')
  // Reported as it was written, without inventing backticks the answer did not use.
  assert.deepEqual(bad.ungrounded, ['RETRY_BACKOFF_MS'])
})

test('groundAnswer: a multi-word backticked phrase is judged word by word', () => {
  const ok = groundAnswer('Runs `freebuffAgent model`.', evidence())
  assert.equal(ok.grounded, true, JSON.stringify(ok.ungrounded))
  const bad = groundAnswer('Runs `freebuffAgent deployAll`.', evidence())
  assert.equal(bad.grounded, false, '`deployAll` is not in the diff')
  assert.deepEqual(bad.ungrounded, ['`deployAll`'])
})

test('groundAnswer: an unbackticked identifier in prose is still a claim; a capitalized English word is not', () => {
  // The prompt asks for backticks, but a reader cannot tell whether the model
  // obeyed, so code-like names are checked wherever they appear.
  const invented = groundAnswer('This changes how RETRY_BACKOFF_MS is read.', evidence())
  assert.equal(invented.grounded, false, JSON.stringify(invented.ungrounded))
  assert.ok(invented.ungrounded.includes('RETRY_BACKOFF_MS'))
  const present = groundAnswer('This changes how MODEL.displayName is read.', evidence())
  assert.equal(present.grounded, true, JSON.stringify(present.ungrounded))
  // Sentence-case prose must never be read as a PascalCase identifier: flagging
  // `Changed` would refuse honest answers until nobody trusted the gate.
  const prose = groundAnswer('Changed how the model name is printed.', evidence())
  assert.equal(prose.grounded, true, JSON.stringify(prose.ungrounded))
})

test('groundAnswer: a truncated token cannot pass as a cut of a longer name', () => {
  // The whole-token rule exists for exactly this: a prefix of a real name is a
  // different identifier, and letting it through would let an answer cite a
  // name the change never wrote.
  const v = groundAnswer('It reads `MODEL.display`.', evidence())
  assert.equal(v.grounded, false, JSON.stringify(v.ungrounded))
})

test('answerEvidence: bounded so one huge diff cannot make an interactive ask time out', () => {
  const huge = `diff --git a/big.ts b/big.ts\n+++ b/big.ts\n@@ -1,2 +1,2 @@\n+${'x'.repeat(120000)}\n`
  const ev = answerEvidence({ entry, diff: huge, maxChars: 5000 })
  assert.ok(ev.text.length < 5200, 'the evidence is cut')
  assert.match(ev.text, /diff truncated/, 'and says so, because a cut can only make the gate stricter')
  assert.match(ev.text, /MiMo free agents use current model/, 'the entry text survives the cut')
})

test('ASK_INSTRUCTIONS: the contract the prompt promises is the one the gate enforces', () => {
  // If the prompt stops demanding backticks and citations while the gate keeps
  // enforcing them, every answer would be refused for a rule the reader never
  // saw. Assert both halves together.
  assert.match(ASK_INSTRUCTIONS, /backticks/)
  assert.match(ASK_INSTRUCTIONS, /\[path\/to\/file\.ext\]/)
  assert.match(ASK_INSTRUCTIONS, /untrusted/i)
  assert.match(ASK_INSTRUCTIONS, /does not contain the answer/i, 'and says what to do when it does not know')
  assert.match(ASK_INSTRUCTIONS, /plain English/i, 'answers default to non-technical language')
  assert.match(ASK_INSTRUCTIONS, /no technical jargon/i, 'rather than leading with identifiers')
})

// --- /api/ask ------------------------------------------------------------------

const fakeEnv = (files, extra = {}) => ({
  ...extra,
  ASSETS: {
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      return path in files ? new Response(files[path], { status: 200 }) : new Response('not found', { status: 404 })
    }
  }
})

const assets = (diff = DIFF) => ({
  '/api/sha-day.json': JSON.stringify({ [SHA]: '2026-10-05' }),
  '/api/records/2026-10-05.json': JSON.stringify({ day: '2026-10-05', records: [entry] }),
  [`/diffs/${SHA}.diff`]: diff
})

const ask = (env, { sha = SHA, q = 'Where does the model name come from?', history, method = 'POST', origin = null, headers = {} } = {}) => {
  const req = new Request('https://x.test/api/ask', {
    method,
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers },
    ...(method === 'POST' ? { body: JSON.stringify({ sha, q, ...(history !== undefined ? { history } : {}) }) } : {})
  })
  return worker.fetch(req, env)
}

// A model reply that is fully grounded in DIFF.
const groundedReply = 'The name comes from `MODEL.displayName` [src/agents/freebuff.ts:12].'
const sse = (content) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\ndata: [DONE]\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })

test.beforeEach(() => { resetAskStateForTests() })

test('worker /api/ask: GET reports whether the feature is configured', async () => {
  const off = await worker.fetch(new Request('https://x.test/api/ask'), fakeEnv(assets()))
  assert.equal(off.status, 200)
  assert.equal((await off.json()).configured, false)
  const on = await worker.fetch(new Request('https://x.test/api/ask'), fakeEnv(assets(), { LLM_API_KEY: 'k' }))
  assert.equal((await on.json()).configured, true)
})

test('worker /api/ask: unconfigured asks fail as unconfigured, never as a model error', async () => {
  const res = await ask(fakeEnv(assets()))
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.configured, false)
  assert.match(body.error, /LLM_API_KEY/)
})

test('worker /api/ask: a grounded answer is served, built from this entry\'s diff', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return sse(groundedReply)
  })
  const res = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.grounded, true)
  assert.equal(body.answer, groundedReply)
  assert.deepEqual(body.citations.map(c => c.file), ['src/agents/freebuff.ts'])
  assert.equal(calls.length, 1)
  // The prompt must actually carry the evidence and the instruction contract.
  const [system, user] = calls[0].body.messages
  assert.equal(system.content, ASK_INSTRUCTIONS)
  assert.match(user.content, /EVIDENCE \(untrusted\)/)
  assert.match(user.content, /MODEL\.displayName/, 'the diff reached the model')
  assert.match(user.content, /Where does the model name come from/, 'and so did the question')
  assert.match(calls[0].url, /\/chat\/completions$/)
})

test('worker /api/ask: an ungrounded answer is corrected once, then refused', async (t) => {
  const UNFIXED = 'It sets `RETRY_BACKOFF_MS` [src/gateway/retry.ts:12].'
  const FIXED = 'The change sets `MODEL.displayName` [src/agents/freebuff.ts:12].'
  let n = 0
  let mode = 'corrects'
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    n++
    seen.push(JSON.parse(init.body).messages[1].content)
    return sse(mode === 'corrects' && n > 1 ? FIXED : UNFIXED)
  })
  const ok = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }))
  assert.equal(ok.status, 200, 'the corrective re-ask produced a grounded answer')
  assert.equal(n, 2, 'exactly one correction')
  assert.match(seen[1], /RETRY_BACKOFF_MS/, 'the correction names what failed')

  // A model that doubles down is refused with the offending claims, not shown.
  resetAskStateForTests()
  n = 0
  mode = 'stubborn'
  const stubborn = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }), { q: 'Different question' })
  assert.equal(stubborn.status, 422)
  const body = await stubborn.json()
  assert.equal(body.grounded, false)
  assert.deepEqual(body.ungrounded, ['`RETRY_BACKOFF_MS`', '[src/gateway/retry.ts:12]'])
  assert.equal(body.answer, undefined, 'the refused text is never returned to the reader')
})

test('worker /api/ask: an identical question is answered once and then from cache', async (t) => {
  let n = 0
  t.mock.method(globalThis, 'fetch', async () => { n++; return sse(groundedReply) })
  const env = fakeEnv(assets(), { LLM_API_KEY: 'k' })
  const first = await ask(env)
  assert.equal(first.status, 200)
  assert.equal(n, 1)
  const second = await ask(env)
  assert.equal(second.status, 200)
  const body = await second.json()
  assert.equal(body.cached, true, 'the reader is told it is a cached answer')
  assert.equal(body.answer, groundedReply)
  assert.equal(n, 1, 'the second ask cost no model call')
})

test('worker /api/ask: per-IP rate limiting answers 429 instead of spending', async (t) => {
  let n = 0
  t.mock.method(globalThis, 'fetch', async () => { n++; return sse(groundedReply) })
  const env = fakeEnv(assets(), { LLM_API_KEY: 'k', ANSWER_RPM: '2' })
  assert.equal((await ask(env, { q: 'one?' })).status, 200)
  assert.equal((await ask(env, { q: 'two?' })).status, 200)
  const third = await ask(env, { q: 'three?' })
  assert.equal(third.status, 429)
  assert.equal(third.headers.get('retry-after'), '60', 'and says how long to wait')
  assert.equal(n, 2, 'the refused ask never reaches the model')
})

test('worker /api/ask: a gateway rate limit rides out with a bounded ladder and never shows the reader the gateway page', async (t) => {
  let n = 0
  let mode = 'recovers'
  const limited = () => new Response('<html>Rate limited due to many requests. Error code: 1015</html>',
    { status: 429, headers: { 'retry-after': '0' } })
  t.mock.method(globalThis, 'fetch', async () => {
    n++
    if (mode === 'recovers') return n === 1 ? limited() : sse(groundedReply)
    return limited()
  })

  // One 429 from the provider's gateway is weather, not an answer: the ladder
  // retries it inside the ask's budget and the reader gets the grounded reply.
  const ok = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }))
  assert.equal(ok.status, 200)
  assert.equal(n, 2, 'the first rate limit was retried, not surfaced')
  assert.equal((await ok.json()).grounded, true)

  // A gateway that stays shut fails bounded and readable: no Cloudflare HTML,
  // no error code, and a count that proves the ladder stops.
  n = 0
  mode = 'stuck'
  const stuck = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }), { q: 'A different question?' })
  assert.equal(stuck.status, 500)
  const body = await stuck.json()
  assert.match(body.error, /rate-limited right now/)
  assert.doesNotMatch(body.error, /1015|<html>/i, "the gateway's page never reaches the answer box")
  assert.equal(n, 3, 'bounded: the initial call plus ASK.rateRetries')
})

test('worker /api/ask: validation and abuse checks answer before any spend', async (t) => {
  let n = 0
  t.mock.method(globalThis, 'fetch', async () => { n++; return sse(groundedReply) })
  const env = fakeEnv(assets(), { LLM_API_KEY: 'k' })
  assert.equal((await worker.fetch(new Request('https://x.test/api/ask', { method: 'DELETE' }), env)).status, 405, 'method')
  assert.equal((await ask(env, { origin: 'https://evil.test' })).status, 403, 'cross-origin')
  assert.equal((await ask(env, { sha: 'not-a-sha' })).status, 400, 'sha shape')
  assert.equal((await ask(env, { q: '' })).status, 400, 'empty question')
  assert.equal((await ask(env, { q: 'x'.repeat(401) })).status, 400, 'over-long question')
  assert.equal((await ask(env, { sha: 'b'.repeat(40) })).status, 404, 'unknown entry')
  assert.equal(n, 0, 'none of them reached the model')
})

test('worker /api/ask: no stored diff means no answer, because nothing could be grounded', async () => {
  const env = fakeEnv(assets(''), { LLM_API_KEY: 'k' })
  const res = await ask(env)
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.grounded, false)
  assert.match(body.error, /cannot be grounded/)
})

test('worker /api/ask: an answer claiming an unrelated file is refused at the edge', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse('It updates [docs/security.md] and reads `TOKEN_TTL_MS`.'))
  const res = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }))
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.grounded, false)
  assert.ok(body.ungrounded.includes('[docs/security.md]'))
  assert.ok(body.ungrounded.includes('`TOKEN_TTL_MS`'))
})

test('worker /api/ask: a follow-up question carries its thread to the model', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(JSON.parse(init.body))
    return sse(groundedReply)
  })
  const env = fakeEnv(assets(), { LLM_API_KEY: 'k' })
  const history = [{ q: 'Where does the model name come from?', a: groundedReply }]
  const res = await ask(env, { q: 'Why that file?', history })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  const prompt = calls[0].messages[1].content
  assert.match(prompt, /Where does the model name come from\?/, 'the first question is in the prompt')
  assert.match(prompt, /MODEL\.displayName/, 'the first answer is in the prompt')
  assert.match(prompt, /Why that file\?/, 'and so is the follow-up')
  assert.match(prompt, /CONVERSATION SO FAR/, 'labelled as context, not evidence')
})

test('worker /api/ask: the same words after a different thread are a different cache entry', async (t) => {
  let n = 0
  t.mock.method(globalThis, 'fetch', async () => { n++; return sse(groundedReply) })
  const env = fakeEnv(assets(), { LLM_API_KEY: 'k' })
  const h1 = [{ q: 'First?', a: groundedReply }]
  const h2 = [{ q: 'Something else?', a: groundedReply }]
  assert.equal((await ask(env, { q: 'Why?', history: h1 })).status, 200)
  assert.equal((await ask(env, { q: 'Why?', history: h1 })).status, 200, 'identical thread hits the cache')
  assert.equal(n, 1)
  assert.equal((await ask(env, { q: 'Why?', history: h2 })).status, 200, 'a different thread spends again')
  assert.equal(n, 2)
})

test('worker /api/ask: a poisoned thread cannot smuggle a claim past the gate', async (t) => {
  // The client invents a prior answer naming code the diff never touched. A
  // grounded reply still passes; a reply that copies the invention is refused.
  t.mock.method(globalThis, 'fetch', async () => sse(groundedReply))
  const poison = [{ q: 'What else?', a: 'It also sets `RETRY_BACKOFF_MS`.' }]
  const ok = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }), { q: 'And?', history: poison })
  assert.equal(ok.status, 200, 'history alone never fails the gate')
  resetAskStateForTests()
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => sse('Yes, it sets `RETRY_BACKOFF_MS`.'))
  const bad = await ask(fakeEnv(assets(), { LLM_API_KEY: 'k' }), { q: 'And?', history: poison })
  assert.equal(bad.status, 422, 'an answer repeating the invention is still refused')
})

test('worker /api/ask: history shape is validated and bounded before any spend', async (t) => {
  let n = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    n++
    const prompt = JSON.parse(init.body).messages[1].content
    // 20 long turns must never reach the model whole: the bound keeps the
    // prompt interactive and the evidence in frame.
    assert.ok(prompt.length < 60000, `prompt bounded, got ${prompt.length}`)
    return sse(groundedReply)
  })
  const env = fakeEnv(assets(), { LLM_API_KEY: 'k' })
  assert.equal((await ask(env, { history: 'not-an-array' })).status, 400, 'wrong shape')
  assert.equal((await ask(env, { history: [{ q: 1, a: 2 }] })).status, 400, 'entries must be objects with text')
  assert.equal(n, 0, 'neither reached the model')
  const long = Array.from({ length: 20 }, (_, i) => ({ q: `Q${i}?`, a: 'x'.repeat(2000) }))
  assert.equal((await ask(env, { q: 'Why?', history: long })).status, 200, 'long threads truncate, not reject')
})

// --- the widget on a rendered entry -------------------------------------------

const card = (extra) => entryCard({
  sha: SHA, date: '2026-10-05T11:04:00Z', day: '2026-10-05',
  category: 'CLI', significance: 'notable',
  stats: { additions: 19, deletions: 4 }, files: { total: 4 },
  ai: { title: 'MiMo free agents use current model display name in prompts', summary: 'Prints the current model name.' },
  ...extra
}, true, null, {})

test('the Ask-the-AI widget ships on rows that have a diff, and only those', () => {
  const withDiff = card({ hasDiff: true })
  assert.match(withDiff, /class="ask-ai" data-sha="[0-9a-f]{40}"/, 'the widget carries the sha the route needs')
  assert.match(withDiff, /<button class="ask-open" type="button" aria-expanded="false">.*Ask the AI about this change.*<\/button>/s)
  assert.match(withDiff, /<span class="ask-hint">grounded in this diff<\/span>/, 'the toggle names its grounding so it reads as peer to the technical blocks')
  assert.match(withDiff, /<form class="ask-form"/)
  assert.match(withDiff, /maxlength="400"/, 'the input matches the route\'s question cap')
  assert.match(withDiff, /aria-live="polite"/, 'answers are announced to screen readers')
  // It sits above the collapsed technical details, next to the plain-English
  // line: reader-facing, not buried behind the power toggle.
  assert.ok(withDiff.indexOf('class="ask-ai"') < withDiff.indexOf('tech-details'), 'above the fold of the technical section')

  const noDiff = card({ hasDiff: false })
  assert.doesNotMatch(noDiff, /ask-ai/, 'a row with no diff cannot be grounded, so it is not offered')
})

test('worker: the ask route does not disturb the routes that already exist', async () => {
  const env = fakeEnv(assets())
  const entryRes = await worker.fetch(new Request(`https://x.test/api/entry/${SHA}.json`), env)
  assert.equal(entryRes.status, 200)
  assert.equal((await entryRes.json()).sha, SHA)
  const fallthrough = await worker.fetch(new Request('https://x.test/day/2026-10-05/'), env)
  assert.equal(await fallthrough.text(), 'not found', 'untouched requests still reach the asset server')
  const broken = await worker.fetch(new Request('https://x.test/api/ask'), {})
  assert.equal(broken.status, 500, 'a missing binding still degrades to the readable 500')
  assert.match(await broken.text(), /assets binding missing/)
})
