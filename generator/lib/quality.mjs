// Pure quality/provenance helpers. No provider calls and no historical rewrites.
import { shortHash } from './util.mjs'

export const QUALITY_POLICY_V = 1
export const CLAIM_FIELDS = ['title', 'summary', 'evidence', 'audience', 'userVisible', 'breaking', 'migration', 'newEnvVars', 'newFlags', 'unknowns', 'changes', 'text']

export function artifactHash (record = {}) {
  return shortHash(JSON.stringify(Object.fromEntries(CLAIM_FIELDS.filter(k => record[k] !== undefined).map(k => [k, record[k]]))))
}

export function evidenceManifest (entry, material, prompt, model) {
  return {
    policy: QUALITY_POLICY_V,
    head: entry.sha,
    base: entry.prevSha || null,
    sourceHash: shortHash(material),
    promptHash: shortHash(prompt),
    model,
    chars: String(prompt).length,
    partial: /\[(?:[^\]\n]*(?:truncated|partial evidence)|diff omitted)/i.test(String(material) + '\n' + String(prompt))
  }
}

// A stored artifact answers to the current policy when it carries the policy
// stamp, an input manifest, or a verdict bound to an exact hash. Text older than
// that was never checked under this policy at all -- which is a different fact
// from "a check ran and did not pass", and must not be reported as a failure.
export function isCurrentRecord (r = {}) {
  return !!(r.policy === QUALITY_POLICY_V || r.manifest || r.verifyHash)
}

// The single place a stored verification field becomes a readable status.
// Every verdict the pipeline can write ('passed', 'flagged', 'unavailable') is
// returned as itself. A missing verdict on current-policy text is 'unchecked';
// a missing verdict on pre-policy text is 'pre-policy', not a failure.
export function qualityStatus (r = {}) {
  if (r.verify === 'passed' && ((r.policy === QUALITY_POLICY_V && !r.verifyHash) || (r.verifyHash && r.verifyHash !== artifactHash(r)))) return 'stale'
  if (r.verify !== undefined) return r.verify
  return isCurrentRecord(r) ? 'unchecked' : 'pre-policy'
}

export const VERIFIED_STATUSES = ['passed', 'human-edited']
export const PLAIN_VERIFIED_STATUSES = ['passed', 'deterministic', 'human-edited']

// The verifier can report the same objection twice: once as a free-text issue
// and once as the quoted claim it refers to ("with ad-request update" inside a
// sentence that already names it). A reader needs one of them, not both. When
// two objections overlap, the fuller text is the one kept.
const claimText = c => String(c?.claim || '').toLowerCase().replace(/[`"'\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim()
// A bare identifier or number is a legitimate objection of its own, and it is
// trivially "contained" in any sentence that mentions it, so containment only
// counts for a claim of at least two words that the other one clearly wraps.
const contained = (t, u) => t === u || (t.split(' ').length >= 2 && u.includes(t) && u.length >= t.length * 1.5)

export function dedupeClaims (claims = []) {
  const out = []
  for (const c of claims) {
    const t = claimText(c)
    if (!t) continue
    const at = out.findIndex(o => {
      const u = claimText(o)
      return contained(t, u) || contained(u, t)
    })
    if (at === -1) { out.push(c); continue }
    if (claimText(out[at]).length >= t.length) continue
    out[at] = c
  }
  return out
}

export function qualityOf (e = {}) {
  const ai = e.ai || {}
  const plain = e.eli5 || {}
  const edited = e.overridden || ai.overridden
  const statusOf = qualityStatus
  const verify = edited ? 'human-edited' : statusOf(ai)
  const plainVerify = plain.model === 'template' ? 'deterministic' : plain.overridden ? 'human-edited' : statusOf(plain)
  const unverifiedNames = ai.ungrounded || []
  const valueErrors = ai.valueErrors || []
  // Two levels, deliberately. `warnings` are problems a reader must not skim
  // past: a check ran and did not pass, a name could not be grounded, a value is
  // backwards. `notes` are the quieter disclosure that stored text predates the
  // current policy. Treating the second as the first put an "unverified" box on
  // every historical row, which spent the warning on the rows that were fine and
  // left the ones that actually failed indistinguishable.
  const warnings = []
  const notes = []
  // An actionable claim (a migration step, a breaking change) is demoted only
  // when something contradicts it: a recorded negative verdict, or a
  // current-policy row whose check never ran. Pre-policy text is rendered as it
  // was stored, with the note, rather than silently relabelled as a failure.
  const demoteActions = ['flagged', 'stale', 'unavailable'].includes(verify) || (verify === 'unchecked' && isCurrentRecord(ai))
  if (ai.title && !edited) {
    if (verify === 'flagged') warnings.push('The verifier objected to claims in this entry.')
    else if (verify === 'stale') warnings.push('The stored verification no longer matches this text, so it is not current.')
    // A check that could not run raises no reader-facing notification (2026-09-30,
    // by request): a provider outage marked a large number of healthy rows
    // `unavailable`, so the notice read as a defect on rows with nothing wrong
    // with their text. Nothing about the state is hidden elsewhere -- the
    // recorded verdict, `demoteActions` (actions still demoted) and the /stats/
    // coverage buckets all key off `verify`, not off this sentence.
    else if (verify === 'unchecked') warnings.push('Technical claims have no current verification.')
    else if (verify === 'pre-policy') notes.push('This summary predates the current verification policy, so it has no fresh fact-check.')
    if (unverifiedNames.length) warnings.push(`Unverified names or numbers: ${unverifiedNames.join(', ')}.`)
    if (valueErrors.length) warnings.push(`Value errors: ${valueErrors.join('; ')}.`)
    for (const c of dedupeClaims(ai.verifyClaims)) warnings.push(`${c.claim}${c.reason ? ` (${c.reason})` : ''}`)
    if (ai.manifest?.partial) warnings.push('Source evidence is partial; some changes may be omitted.')
  }
  if (plain.text && !PLAIN_VERIFIED_STATUSES.includes(plainVerify)) {
    if (plainVerify === 'pre-policy') {
      notes.push('This plain-English explanation predates the current verification policy, so it has no fresh fact-check.')
    } else if (plainVerify === 'flagged') {
      warnings.push('The fact-check objected to claims in the plain-English explanation.')
    } else if (plainVerify === 'stale') {
      warnings.push('The stored fact-check no longer matches this plain-English text, so it is not current.')
    }
    // `unavailable`/`unchecked` plain-English states notify no one, for the same
    // reason the technical side above stays quiet. Recorded objections on the
    // line itself (plain.verifyClaims) are still printed below.
    for (const c of dedupeClaims(plain.verifyClaims)) warnings.push(`${c.claim}${c.reason ? ` (${c.reason})` : ''}`)
  }
  if (plain.text && plain.manifest?.partial) warnings.push('The plain-English explanation uses partial evidence; some changes may be omitted.')
  const uncertain = warnings.length > 0
  const confidence = ai.manifest?.partial ? 'low' : ai.confidence === 'high' && uncertain ? 'medium' : ai.confidence
  const plainNotes = notes.filter(n => /plain-English/.test(n))
  return {
    verify, plainVerify, confidence, uncertain, demoteActions,
    prePolicy: verify === 'pre-policy' || plainVerify === 'pre-policy',
    warnings: [...new Set(warnings)],
    notes: [...new Set(notes)],
    ...(plainNotes.length ? { plainNotes } : {}),
    ...(ai.verifyModel ? { verifyModel: ai.verifyModel } : {}),
    ...(ai.verifyHash ? { verifyHash: ai.verifyHash } : {}),
    ...(ai.verifyClaims?.length ? { verifyClaims: ai.verifyClaims } : {}),
    ...(unverifiedNames.length ? { unverifiedNames } : {}),
    ...(valueErrors.length ? { valueErrors } : {}),
    ...(ai.manifest ? { manifest: ai.manifest } : {}),
    ...(plain.manifest ? { plainManifest: plain.manifest } : {}),
    ...(plain.verifyClaims?.length ? { plainVerifyClaims: plain.verifyClaims } : {}),
    ...(ai.at ? { generatedAt: ai.at } : {})
  }
}

// The loud form: a marker that means "a check did not pass". Pre-policy text
// carries no marker, because nothing about it failed. Long objection lists are
// cut to a character budget for the surfaces that have to stay scannable (the
// badge tooltip, an RSS description, a Discord message); `qualityOf().warnings`
// and the entry's own Evidence block keep every objection in full.
export function qualityText (e, { max = 600 } = {}) {
  const q = qualityOf(e)
  if (!q.uncertain) return ''
  const joined = q.warnings.join(' ')
  if (joined.length <= max) return `[UNVERIFIED] ${joined}`
  const kept = []
  let used = 0
  for (const w of q.warnings) {
    if (kept.length && used + w.length > max) break
    kept.push(w)
    used += w.length + 1
  }
  const more = q.warnings.length - kept.length
  return `[UNVERIFIED] ${kept.join(' ')}${more > 0 ? ` (+${more} more objection${more === 1 ? '' : 's'} on this entry)` : ''}`
}

// The quiet form: history disclosure without an alarm. Used where a reader has
// asked for this entry's provenance (its own Evidence block, the JSON API).
export function qualityNote (e) {
  return qualityOf(e).notes.join(' ')
}
