// AI-driven DDC 23 classification -- the backend's whole-book analysis
// step. This is deliberately separate from the deterministic rule-based
// engine in ddcCandidateService.js/literaryDdc.js: that engine remains the
// validator AND the fallback (never a fake success -- see classifyDdc in
// ddcClassificationService.js), while this module is what actually
// "analyses the intellectual content and bibliographic identity of the
// complete work" per the product spec, when an AI provider is configured.
//
// Reuses the same OpenAI/NVIDIA calling primitives llm/router.js already
// built (callOpenAi/callNvidia/extractJson) rather than standing up a
// second provider-selection system.
import { callOpenAi, callNvidia, extractJson } from '../llm/router.js';

const RESPONSE_SHAPE =
  '{"ddc": string, "class_name": string, "work_type": string, "confidence": "HIGH"|"MEDIUM"|"LOW", "why": string, "number_breakdown": [{"number": string, "meaning": string}], "evidence": string[], "sources": string[], "alternatives_considered": [{"number": string, "class_name": string, "why_not_selected": string}], "publication_place": string|null}';

function clean(value) {
  return String(value ?? '').trim();
}

function arr(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
}

function summarizeBibliographicData(metadata) {
  const { isbn, title, subtitle, authors, editors, publisher, publication_place, publish_date, edition, language, subjects, description, table_of_contents, series, physical_description } = metadata;
  return JSON.stringify(
    { isbn, title, subtitle, authors, editors, publisher, publication_place, publish_date, edition, language, subjects, description, table_of_contents, series, physical_description },
    null,
    2
  );
}

function summarizeExternalClassifications(metadata) {
  const list = arr(metadata.existing_classifications);
  if (list.length === 0) return null;
  return list.map((c) => `${c.number}${c.edition ? ` (${c.source}, edition ${c.edition})` : ` (${c.source})`}`).join('; ');
}

function buildCandidateInstruction(candidates) {
  if (!candidates || candidates.length === 0) {
    return (
      'No candidate DDC 23 numbers were found in AutoCat\'s DDC relative index for this book\'s subject matter. ' +
      'Draft your answer from DDC 23 knowledge, but mark confidence as "LOW" in that case, since it is unverified against AutoCat\'s own DDC reference.'
    );
  }
  const list = candidates.map((c) => `- ${c.term}${c.qualifier ? ` (${c.qualifier})` : ''} -> ${c.ddc_number}`).join('\n');
  return (
    `Here are candidate DDC 23 numbers found in AutoCat's DDC 23 relative index for this book's subject matter:\n${list}\n\n` +
    'Prefer a number from this list if one genuinely fits. Only propose a number NOT in this list if none of these candidates are a reasonable match, and if you do, mark confidence as "LOW".'
  );
}

// buildDdcAnalysisPrompt(metadata, candidates, correction) -- pure and
// exported for testing. `correction` is set on a retry after the first
// attempt's number failed AutoCat's own validation (product spec section
// 8: "run another classification attempt"), and is folded into the prompt
// as an explicit instruction not to repeat the rejected number.
export function buildDdcAnalysisPrompt(metadata, candidates = [], correction = null) {
  const parts = [];
  parts.push(
    'You are a professional cataloguing librarian classifying a book under DEWEY DECIMAL CLASSIFICATION, 23rd EDITION (DDC 23) ONLY. ' +
      'Do not use DDC 22, DDC 21, generic Dewey knowledge from another edition, Library of Congress Classification, or a classification based on a single keyword. ' +
      'Analyse the intellectual content and bibliographic identity of the COMPLETE work before answering. Determine, in order: ' +
      'work type (e.g. novel, poetry collection, play, textbook, monograph, reference work); whether it is literary or non-literary; genre/form; language; ' +
      'literary tradition (e.g. American English, British/English, German, French...) if literary; subject; historical or literary period where applicable; ' +
      'intended intellectual purpose; and the specific content evidence supporting all of the above. Only then determine the relevant DDC 23 hierarchy and the ' +
      'MOST SPECIFIC valid DDC 23 number the evidence actually supports -- never stop at a bare main class (000/100/200/.../900) or an intermediate number when ' +
      'the evidence supports something more specific, and never invent a decimal digit the evidence does not support. ' +
      'Also identify 1-3 other DDC 23 numbers you seriously considered and rejected for this book (genuinely close alternatives from the same or an adjacent ' +
      'hierarchy, not arbitrary numbers), and state specifically why the evidence favors your chosen number over each of them.'
  );
  parts.push(`Respond with strict JSON matching exactly this shape, no markdown fences, no commentary: ${RESPONSE_SHAPE}`);
  parts.push(`Book bibliographic data:\n${summarizeBibliographicData(metadata)}`);
  parts.push(
    'Also report publication_place: the city the publisher\'s imprint is based in (e.g. "London", "New York"). If "publication_place" is already given above (non-null), just repeat that exact value. ' +
      'If it is null, only fill it in when the data above (description, table_of_contents, or the publisher name/edition text itself) directly states or clearly implies a specific place -- never guess a plausible city for a publisher you merely recognise. ' +
      'When genuinely no evidence gives a place, return null -- an unknown place is handled correctly downstream (AACR2\'s standard "[S.l.]" placeholder), a fabricated one is not.'
  );

  const externalClassifications = summarizeExternalClassifications(metadata);
  if (externalClassifications) {
    parts.push(
      `Existing classification(s) found on library catalogue records for this book: ${externalClassifications}. ` +
        'Treat this as supporting evidence only -- compare it against the book\'s actual content, language, and DDC 23 rules; do not copy it blindly.'
    );
  }

  parts.push(buildCandidateInstruction(candidates));

  if (correction) {
    parts.push(`IMPORTANT CORRECTION: your previous answer (${correction.number}) was rejected: ${correction.reason} Re-analyse and provide a different, valid answer.`);
  }

  return parts.join('\n\n');
}

class DdcAiResponseError extends Error {}

// parseAiDdcResponse(text) -- pure and exported for testing. Throws
// DdcAiResponseError on anything that isn't a well-formed response in the
// required shape; callers must treat that as "AI analysis unavailable",
// never fall back to displaying a malformed/partial number.
export function parseAiDdcResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    throw new DdcAiResponseError(`could not parse AI response as JSON: ${error.message}`);
  }

  const ddc = clean(parsed.ddc);
  if (!ddc) throw new DdcAiResponseError('AI response is missing a ddc number');
  const confidence = ['HIGH', 'MEDIUM', 'LOW'].includes(String(parsed.confidence).toUpperCase()) ? String(parsed.confidence).toUpperCase() : 'LOW';

  return {
    ddc,
    edition: 'DDC 23', // never trust the model's own echo of this -- it's fixed by AutoCat, not the AI
    class_name: clean(parsed.class_name) || null,
    work_type: clean(parsed.work_type) || null,
    confidence,
    why: clean(parsed.why) || null,
    number_breakdown: Array.isArray(parsed.number_breakdown)
      ? parsed.number_breakdown.map((row) => ({ number: clean(row?.number), meaning: clean(row?.meaning) })).filter((row) => row.number)
      : [],
    evidence: arr(parsed.evidence).map(clean).filter(Boolean),
    sources: arr(parsed.sources).map(clean).filter(Boolean),
    alternatives_considered: Array.isArray(parsed.alternatives_considered)
      ? parsed.alternatives_considered
          .map((row) => ({ number: clean(row?.number), class_name: clean(row?.class_name) || null, why_not_selected: clean(row?.why_not_selected) || null }))
          .filter((row) => row.number)
      : [],
    publication_place: clean(parsed.publication_place) || null,
  };
}

// classifyWithAi({ metadata, candidates, correction, provider, callModel })
// -- returns a parsed DDC AI result, or null if no AI provider is
// configured at all (a normal, expected outcome -- NOT an error). Throws
// only when a provider IS configured but the call/response itself failed,
// so the caller (ddcClassificationService.js) can distinguish "AI not
// available, use the rule-based result silently" from "AI was attempted
// and failed, note that honestly" per the product spec's "no fake
// success" requirement.
export async function classifyWithAi({ metadata, candidates = [], correction = null, provider, callModel } = {}) {
  const call = callModel ?? (provider === 'nvidia' ? callNvidia : callOpenAi);
  const prompt = buildDdcAnalysisPrompt(metadata, candidates, correction);

  let model;
  let text;
  try {
    ({ model, text } = await call(prompt));
  } catch (error) {
    if (/not configured|no usable/.test(error.message)) return null; // no provider available -- expected, not a failure
    throw error;
  }

  const parsed = parseAiDdcResponse(text);
  return { ...parsed, model, provider: provider ?? 'openai' };
}
