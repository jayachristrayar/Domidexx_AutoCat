import { MAIN_CLASSES } from './ddcKnowledgeBase.js';
import { classPathLabels } from './ddcCandidateService.js';

function buildLiteraryJustification({ literary, recommended, alternatives }) {
  const periodText = literary.period ? ` (${literary.period.label}, evidence: ${literary.period.source === 'explicit_first_published_evidence' ? `first published ${literary.period.year}` : `publication era c. ${literary.period.year}`})` : '';
  const alt = alternatives?.length ? ` Plausible alternatives (${alternatives.map((a) => a.number).join(', ')}) were not used because they fit secondary or incidental topics, not the book's actual literary nature.` : '';
  return (
    `This work was first identified by content type, not by keyword matching: it is ${literary.form} in ${literary.language_label}${periodText}. ` +
    `Under DDC 23, literature is classified by language and form in the 800 Literature class, so it is classified as ${recommended.number} (${recommended.label}) rather than by any subject-domain guess (e.g. Library & Information Science, Education, or another 000-700/900 class) that incidental metadata text might otherwise suggest.${alt}`
  );
}

export function buildJustification({ analysis, recommended, alternatives, metadata }) {
  if (!recommended) return 'Insufficient whole-book evidence to establish a reliable DDC recommendation.';
  if (analysis.literary) return buildLiteraryJustification({ literary: analysis.literary, recommended, alternatives });
  const ev = analysis.evidence_summary.slice(0, 3).map((e) => `${e.type}: ${e.value}`).join('; ');
  const alt = alternatives?.length ? ` Plausible alternatives (${alternatives.map((a) => a.number).join(', ')}) are weaker because they fit secondary topics rather than the primary subject.` : '';
  return `The book is primarily about ${analysis.primary_subject}, within ${analysis.disciplinary_domain}. The selected hierarchy ${classPathLabels(recommended.number).map((p) => p.number).join(' → ')} fits because ${recommended.label} is the closest assigned class supported by the supplied whole-book evidence (${ev}).${alt}`;
}
export function validateDecision(decision){ if(decision.recommended_ddc && !decision.justification) return {valid:false,error:'DDC recommendation requires justification'}; if(decision.recommended_ddc?.confidence==='HIGH' && (decision.evidence||[]).length<3) return {valid:false,error:'HIGH confidence requires sufficient evidence'}; return {valid:true}; }
