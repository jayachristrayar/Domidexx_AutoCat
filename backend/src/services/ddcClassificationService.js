import { buildRecommendation, classPathLabels } from './ddcCandidateService.js';
import { buildJustification, validateDecision } from './ddcJustificationService.js';
import { MAIN_CLASSES, findBundledClass } from './ddcKnowledgeBase.js';
import { classifyWithAi } from './ddcAiClassifier.js';
import { validateClassificationAgainstWorkType } from './literaryDdc.js';
import { deriveDdcKeywords } from '../llm/router.js';

const MAX_AI_ATTEMPTS = 2;

// Whole-book DDC 23 analysis: the deterministic rule-based engine
// (ddcCandidateService.js/literaryDdc.js) always runs first -- it is both
// the validator for whatever the AI proposes AND the fallback when no AI
// provider is configured, the AI call fails, or every AI attempt produces
// a number that fails validation. This is what makes "never a fake
// success" possible: a request never has to choose between "trust an
// unvalidated AI answer" and "show nothing" -- there's always a real,
// evidence-grounded answer to fall back to, honestly labeled as such.
async function attemptAiClassification(metadata, ruleBased, classifyWithAiFn, provider) {
  let candidates = [];
  try {
    // Dynamic import: ddcLookup.js touches the Postgres pool at module
    // load, so this stays scoped to "the DB-backed grounding step failed"
    // rather than making recommendDdc() itself impossible to import/run
    // without a database (it must remain usable DB-free via the
    // rule-based fallback -- see attemptAiClassification's caller).
    const { findCandidateDdcNumbers } = await import('./ddcLookup.js');
    candidates = await findCandidateDdcNumbers(deriveDdcKeywords(metadata));
  } catch (error) {
    // DB/table unavailable, etc. -- degrade to an ungrounded AI prompt
    // rather than failing the whole classification.
    console.error('DDC AI classification: candidate lookup failed, proceeding without grounding:', error.message);
  }

  let correction = null;
  let lastRejection = null;
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt += 1) {
    let ai;
    try {
      ai = await classifyWithAiFn({ metadata, candidates, correction, provider });
    } catch (error) {
      console.error(`DDC AI classification attempt ${attempt} failed:`, error.message);
      return { ai: null, attempted: true };
    }
    if (!ai) return { ai: null, attempted: false }; // no AI provider configured -- expected, not a failure

    const bundled = findBundledClass(ai.ddc);
    const workTypeCheck = validateClassificationAgainstWorkType(ai.ddc, ruleBased.analysis.literary ?? null);
    if (workTypeCheck.valid && bundled && bundled.status === 'ASSIGNED') {
      return { ai, attempted: true };
    }

    // Semantic contradiction / unrecognized number -- product spec section
    // 8/9: never display this, run another attempt with the rejection
    // reason folded into the prompt as an explicit correction.
    const reason = !workTypeCheck.valid
      ? workTypeCheck.reason
      : `${ai.ddc} is not a recognized, assignable DDC 23 number in AutoCat's reference.`;
    console.error(`DDC AI classification: rejected AI answer ${ai.ddc} on attempt ${attempt}: ${reason}`);
    lastRejection = { number: ai.ddc, reason };
    correction = lastRejection;
  }
  return { ai: null, attempted: true, rejected: lastRejection };
}

function fromAi(ai, ruleBased) {
  const breakdown = ai.number_breakdown?.length
    ? ai.number_breakdown.map((row) => ({ number: row.number, label: row.meaning }))
    : classPathLabels(ai.ddc);
  const bundled = findBundledClass(ai.ddc);
  // Combine the AI's own stated evidence with the rule-based engine's
  // curated bibliographic evidence (title/description/subjects/etc., and
  // literary form/language/period evidence when applicable) -- richer for
  // the librarian's "evidence used" section, and means a confident AI
  // answer is always backed by more than just the model's own say-so.
  const evidence = [
    ...(ai.evidence ?? []).map((value) => ({ type: 'ai_analysis', value })),
    ...ruleBased.analysis.evidence_summary,
  ];
  return {
    recommended: { number: ai.ddc, label: ai.class_name || bundled?.label || '', confidence: ai.confidence },
    breakdown,
    justification: ai.why || `Classified as ${ai.ddc} (${ai.class_name || bundled?.label || ''}) under DDC 23.`,
    evidence,
    sources: ai.sources?.length ? ai.sources : ['AI whole-book analysis'],
    work_type: ai.work_type || (ruleBased.analysis.literary ? ruleBased.analysis.literary.work_type : 'NONFICTION_OR_UNKNOWN'),
    classification_source: 'AI_ANALYZED',
    model: ai.model,
    alternatives_considered: ai.alternatives_considered ?? [],
    // Evidence-grounded only (see buildDdcAnalysisPrompt's explicit
    // "never guess" instruction) -- the client merges this into the
    // book's working metadata (only filling a still-empty field, never
    // overwriting a value structured/page evidence already supplied) so
    // MARC's 260$a has a real place instead of the AACR2 [S.l.]
    // placeholder whenever the evidence actually supports one.
    publication_place: ai.publication_place ?? null,
  };
}

function fromRuleBased(ruleBased) {
  const { analysis, recommended, alternatives } = ruleBased;
  const justification = buildJustification({ analysis, recommended, alternatives, metadata: {} });
  return {
    recommended: recommended ? { number: recommended.number, label: recommended.label, confidence: ruleBased.confidence } : null,
    breakdown: recommended ? classPathLabels(recommended.number) : [],
    justification,
    evidence: analysis.evidence_summary,
    sources: ['AutoCat DDC 23 evidence-based classifier'],
    work_type: analysis.literary ? analysis.literary.work_type : 'NONFICTION_OR_UNKNOWN',
    classification_source: 'RULE_BASED',
    model: null,
    alternatives_considered: [],
    publication_place: null,
  };
}

// The `classifyWithAiFn` override exists for tests only (see
// testAiDdcClassificationP8.js) -- production callers always get the real
// AI classifier. `provider` ('nvidia' | 'openai') is decided by the caller
// (ddc.js's /recommend route, via modelAccess.resolveAuthorizedModel against
// the requesting account's server-side grant) -- never invented here, and
// never silently substituted for a different provider than what was
// authorized.
export async function recommendDdc(metadata = {}, { classifyWithAiFn = classifyWithAi, provider = 'nvidia' } = {}) {
  const ruleBased = buildRecommendation(metadata);
  const { ai, attempted, rejected } = await attemptAiClassification(metadata, ruleBased, classifyWithAiFn, provider);

  if (!ai && !ruleBased.recommended && !rejected) {
    // Neither AI nor the rule-based engine could produce anything -- honest
    // insufficient-evidence result, never a guess (product spec section 17).
    return buildInsufficientEvidenceDecision(ruleBased);
  }

  const chosen = ai ? fromAi(ai, ruleBased) : fromRuleBased(ruleBased);
  const { analysis } = ruleBased;

  const mainClassNumber = chosen.recommended ? `${Math.floor(Number(String(chosen.recommended.number).slice(0, 3)) / 100) * 100}`.padStart(3, '0') : null;

  const decision = {
    primary_subject: ai ? chosen.recommended.label : analysis.primary_subject,
    disciplinary_domain: analysis.disciplinary_domain,
    secondary_subjects: analysis.secondary_subjects,
    related_topics: analysis.related_topics,
    tools_or_technologies: analysis.tools_or_technologies,
    application_areas: analysis.application_areas,
    main_class: mainClassNumber ? { number: mainClassNumber, label: MAIN_CLASSES[mainClassNumber], confidence: chosen.recommended?.confidence } : null,
    classification_path: chosen.breakdown.map((p) => p.number),
    number_breakdown: chosen.breakdown,
    recommended_ddc: chosen.recommended,
    class_name: chosen.recommended?.label ?? null,
    edition: 'DDC 23',
    work_type: chosen.work_type,
    literary_classification: analysis.literary || null,
    evidence: chosen.evidence,
    sources: chosen.sources,
    justification: chosen.justification,
    why: chosen.justification,
    alternatives: ruleBased.alternatives,
    // AI-stated "close numbers considered and rejected, and why" (product
    // spec: "ALTERNATIVE NUMBERS CONSIDERED / WHY THEY WERE NOT SELECTED")
    // -- distinct from `alternatives` above, which is the deterministic
    // rule-based engine's own near-miss candidates, always present
    // regardless of whether AI classification ran.
    alternatives_considered: chosen.alternatives_considered ?? [],
    publication_place: chosen.publication_place ?? null,
    classification_source: chosen.classification_source,
    ai_attempted: attempted,
    ai_model: chosen.model,
    ai_rejected: rejected ?? null,
    provenance: [chosen.classification_source === 'AI_ANALYZED' ? 'AI_ANALYZED' : 'RULE_DERIVED', 'SOURCE_DERIVED'],
    // approval_status starts PENDING regardless of outcome -- saveDdcDecision
    // (ddcApprovalService.js) is the one place that ever changes it, and it
    // does so automatically the moment a recommended_ddc exists (no separate
    // "cataloguer approval" step anywhere in this product).
    approval_status: 'PENDING',
  };

  const valid = validateDecision(decision);
  if (!valid.valid) throw new Error(valid.error);
  return decision;
}

function buildInsufficientEvidenceDecision(ruleBased) {
  const { analysis } = ruleBased;
  return {
    primary_subject: analysis.primary_subject,
    disciplinary_domain: analysis.disciplinary_domain,
    secondary_subjects: analysis.secondary_subjects,
    related_topics: analysis.related_topics,
    tools_or_technologies: analysis.tools_or_technologies,
    application_areas: analysis.application_areas,
    main_class: null,
    classification_path: [],
    number_breakdown: [],
    recommended_ddc: null,
    class_name: null,
    edition: 'DDC 23',
    work_type: 'NONFICTION_OR_UNKNOWN',
    literary_classification: null,
    evidence: analysis.evidence_summary,
    sources: [],
    justification: 'Insufficient bibliographic evidence for confident classification.',
    why: 'Insufficient bibliographic evidence for confident classification.',
    alternatives: [],
    alternatives_considered: [],
    publication_place: null,
    classification_source: 'INSUFFICIENT_EVIDENCE',
    ai_attempted: false,
    ai_model: null,
    ai_rejected: null,
    provenance: ['SOURCE_DERIVED'],
    // approval_status starts PENDING regardless of outcome -- saveDdcDecision
    // (ddcApprovalService.js) is the one place that ever changes it, and it
    // does so automatically the moment a recommended_ddc exists (no separate
    // "cataloguer approval" step anywhere in this product).
    approval_status: 'PENDING',
  };
}
