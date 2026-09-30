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

export function qualityOf (e = {}) {
  const ai = e.ai || {}
  const plain = e.eli5 || {}
  const edited = e.overridden || ai.overridden
  const statusOf = r => r.verify === 'passed' && ((r.policy === QUALITY_POLICY_V && !r.verifyHash) || (r.verifyHash && r.verifyHash !== artifactHash(r)))
    ? 'stale' : (r.verify || 'unchecked')
  const verify = edited ? 'human-edited' : statusOf(ai)
  const plainVerify = plain.model === 'template' ? 'deterministic' : plain.overridden ? 'human-edited' : statusOf(plain)
  const unverifiedNames = ai.ungrounded || []
  const valueErrors = ai.valueErrors || []
  const warnings = []
  if (ai.title && !edited) {
    if (verify !== 'passed') warnings.push(verify === 'flagged' ? 'The verifier objected to claims in this entry.' : `Technical claims ${verify === 'unavailable' ? 'could not be verified' : 'have no current verification'}.`)
    if (unverifiedNames.length) warnings.push(`Unverified names or numbers: ${unverifiedNames.join(', ')}.`)
    if (valueErrors.length) warnings.push(`Value errors: ${valueErrors.join('; ')}.`)
    for (const c of ai.verifyClaims || []) warnings.push(`${c.claim}${c.reason ? ` (${c.reason})` : ''}`)
    if (ai.manifest?.partial) warnings.push('Source evidence is partial; some changes may be omitted.')
  }
  if (plain.text && !['passed', 'deterministic', 'human-edited'].includes(plainVerify)) {
    warnings.push('The plain-English explanation has no successful current fact-check.')
    for (const c of plain.verifyClaims || []) warnings.push(`${c.claim}${c.reason ? ` (${c.reason})` : ''}`)
  }
  if (plain.text && plain.manifest?.partial) warnings.push('The plain-English explanation uses partial evidence; some changes may be omitted.')
  const uncertain = warnings.length > 0
  const confidence = ai.manifest?.partial ? 'low' : ai.confidence === 'high' && uncertain ? 'medium' : ai.confidence
  return {
    verify, plainVerify, confidence, uncertain,
    warnings: [...new Set(warnings)],
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

export function qualityText (e) {
  const q = qualityOf(e)
  return q.uncertain ? `[UNVERIFIED] ${q.warnings.join(' ')}` : ''
}
