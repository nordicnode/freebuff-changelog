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
}// Rows a regeneration run could not finish. With the verifier on, that is
// exactly `generationState(...) !== 'complete'`. With it deliberately off, text
// that is otherwise clean is finished even though no verdict was requested: the
// missing read is the policy, not a repair failure, so `review-pending` alone
// must not fail the run (missing text and needs-repair still do).
export function regenUnfinished (entries = [], { verify = true } = {}) {
  return entries.filter(e => {
    const state = generationState(e)
    if (state.status === 'complete') return false
    if (!verify && state.status === 'review-pending' && !state.missing.length) return false
    return true
  })
}

// Text presence is not completion: both artifacts need exact-text verdicts,
// complete evidence, and no unresolved grounding/claim objections.

export function generationState (e = {}) {
  const ai = e.ai || {}, plain = e.eli5 || {}
  const missing = []
  if (!ai.title || !ai.summary) missing.push('summary')
  if (!plain.text) missing.push('plain-English')
  if (e.noise) return { status: 'not-required', missing: [] }
  if (missing.length) return { status: 'missing', missing }
  const edited = e.overridden || ai.overridden
  const technical = edited ? 'human-edited' : qualityStatus(ai)
  const explanation = plain.model === 'template' ? 'deterministic' : plain.overridden ? 'human-edited' : qualityStatus(plain)
  if ((!edited && (ai.ungrounded?.length || ai.valueErrors?.length || ai.verifyClaims?.length || ai.manifest?.partial)) || (!plain.overridden && (plain.verifyClaims?.length || plain.manifest?.partial)) || ['flagged', 'stale'].includes(technical) || ['flagged', 'stale'].includes(explanation)) return { status: 'needs-repair', missing }
  if (technical === 'pre-policy' || explanation === 'pre-policy') return { status: 'legacy-unreviewed', missing }
  return { status: VERIFIED_STATUSES.includes(technical) && PLAIN_VERIFIED_STATUSES.includes(explanation) ? 'complete' : 'review-pending', missing }
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
  // backwards. `notes` disclose pending automated review or pre-policy text
  // without portraying a provider outage as an unsupported factual claim. Neither
  // covers a missing verdict: `unchecked` text (a deliberately disabled verifier)
  // prints nothing on the row and stays visible only as the stored status, so the
  // warning is spent only where a check actually failed.
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
    else if (verify === 'unavailable') {
      notes.push('Automated review is pending; the source diff is available below.')
      if (ai.verifyClaims?.length) warnings.push('Earlier factual objections remain unresolved.')
    }
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
    } else if (plainVerify === 'unavailable') {
      notes.push('Automated review of the plain-English explanation is pending.')
      if (plain.verifyClaims?.length) warnings.push('Earlier plain-English factual objections remain unresolved.')
    }
    for (const c of dedupeClaims(plain.verifyClaims)) warnings.push(`${c.claim}${c.reason ? ` (${c.reason})` : ''}`)
  }
  if (plain.text && plain.manifest?.partial) warnings.push('The plain-English explanation uses partial evidence; some changes may be omitted.')
  const uncertain = warnings.length > 0
  const confidence = ai.manifest?.partial ? 'low' : ai.confidence === 'high' && (uncertain || demoteActions) ? 'medium' : ai.confidence
  const plainNotes = notes.filter(n => /plain-English/.test(n))
  return {
    verify, plainVerify, confidence, uncertain, demoteActions,
    generation: generationState(e),
    prePolicy: verify === 'pre-policy' || plainVerify === 'pre-policy',
    reviewPending: verify === 'unavailable' || plainVerify === 'unavailable',
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

// The objection text, unmarked. Nothing stamps "[UNVERIFIED]" onto a row: a
// stored objection is listed in the entry's own Evidence block and JSON record,
// which is where a reader asks for provenance. Long lists are still cut to a
// character budget for the compact callers (the PR-preview note, the story
// index); `qualityOf().warnings` and the Evidence block keep every one in full.
export function qualityText (e, { max = 600 } = {}) {
  const q = qualityOf(e)
  if (!q.uncertain) return ''
  const joined = q.warnings.join(' ')
  if (joined.length <= max) return joined
  const kept = []
  let used = 0
  for (const w of q.warnings) {
    if (kept.length && used + w.length > max) break
    kept.push(w)
    used += w.length + 1
  }
  const more = q.warnings.length - kept.length
  return `${kept.join(' ')}${more > 0 ? ` (+${more} more objection${more === 1 ? '' : 's'} on this entry)` : ''}`
}

// The quiet form: history disclosure without an alarm. Used where a reader has
// asked for this entry's provenance (its own Evidence block, the JSON API).
export function qualityNote (e) {
  return qualityOf(e).notes.join(' ')
}
