// AutoCat cataloguing chatbot -- a structured-intent assistant, not a
// generic open-ended chatbot. It never runs its own DDC engine or MARC
// engine: DDC override numbers are only ever validated (never invented)
// against the same bundled DDC 23 reference marcPipeline.js's
// buildApproved082 uses (ddcKnowledgeBase.findBundledClass/buildPath), and
// re-classification / MARC regeneration is left to the extension, which
// re-calls the existing /api/ddc/recommend, /api/ddc/:id/approve and
// /records/generate-marc endpoints -- this file only decides WHAT the
// librarian is asking for and validates any number they propose.
//
// Deliberately rule-based rather than a free-form LLM conversation: every
// action this returns (a DDC override, a metadata correction, a request to
// re-analyse) is something the extension can act on deterministically, and
// none of it depends on an LLM provider being configured. Section 30 of the
// product spec ("no fabrication") is easiest to honour when the assistant
// only ever proposes things it can point back to real evidence for.
import { findBundledClass, buildPath, MAIN_CLASSES } from './ddcKnowledgeBase.js';

function clean(value) {
  return String(value ?? '').trim();
}

function classPathLabelsSync(number) {
  return buildPath(number).map((n) => ({ number: n, label: findBundledClass(n)?.label || MAIN_CLASSES[n] || n }));
}

// ---------------------------------------------------------------------
// DDC number validation (sync, DB-free -- same bundled reference marcPipeline
// uses for the final 082$a gate, so a chat-proposed number is held to
// exactly the same standard as the AI's own recommendation).
// ---------------------------------------------------------------------

export function evaluateProposedDdc(number) {
  const normalized = clean(number);
  const ddcClass = findBundledClass(normalized);
  if (!ddcClass) {
    return { number: normalized, valid: false, reason: `${normalized} is not a recognized DDC 23 number in AutoCat's reference.` };
  }
  if (ddcClass.status !== 'ASSIGNED') {
    return { number: normalized, valid: false, reason: `${normalized} (${ddcClass.label}) is not an assignable DDC 23 number (status: ${ddcClass.status}).` };
  }
  const path = buildPath(normalized);
  if (path.length === 0 || path[0] !== ddcClass.main_class) {
    return { number: normalized, valid: false, reason: `${normalized}'s DDC hierarchy could not be resolved.` };
  }
  return {
    number: normalized,
    label: ddcClass.label,
    valid: true,
    breakdown: classPathLabelsSync(normalized),
  };
}

// ---------------------------------------------------------------------
// Intent parsing
// ---------------------------------------------------------------------

const DDC_NUMBER_RE = /\b\d{2,3}(?:\.\d+)?\b/;
const DDC_INTENT_RE = /\b(ddc|classification|dewey|call number|082)\b|should be|change (?:it |the (?:ddc|number|classification) )?to|use\s+\d|try\s+\d|i think (?:this|it) should be/i;

const WHY_RE = /^\s*(why|explain|justif)/i;
const WRONG_BOOK_RE = /wrong book|not the (?:right|correct) (?:book|edition)|different (?:book|edition)|look for another edition/i;
const REANALYZE_RE = /reanaly[sz]e|re-?analy[sz]e|analy[sz]e (?:it |the book )?again|generate marc again|regenerate|redo|start over|try again|use the (?:table of contents|toc) more/i;
const REJECT_MARC_FIELD_RE = /do not use that metadata|ignore that (?:metadata|source)/i;

const FIELD_NEEDS_VALUE_PATTERNS = [
  { field: 'authors', re: /^\s*(?:the )?author(?:'s name)? is wrong\.?\s*$/i },
  { field: 'publisher', re: /^\s*(?:the )?publisher is wrong\.?\s*$/i },
  { field: 'title', re: /^\s*(?:the )?title is wrong\.?\s*$/i },
  { field: 'edition', re: /^\s*(?:the )?edition is wrong\.?\s*$/i },
];

const FIELD_PATTERNS = [
  { field: 'authors', re: /\bauthor(?:'s name)?\s*(?:is|should be|:)\s*(?:wrong,?\s*)?(?:it'?s\s*)?([^.,\n]+)/i, arrayField: true },
  { field: 'publisher', re: /\bpublisher\s*(?:is|should be|:)\s*(?:wrong,?\s*)?(?:it'?s\s*)?([^.,\n]+)/i },
  { field: 'title', re: /\btitle\s*(?:is|should be|:)\s*(?:wrong,?\s*)?(?:it'?s\s*)?([^.,\n]+)/i },
  { field: 'edition', re: /\bedition\s*(?:is|should be|:)\s*(?:wrong,?\s*)?(?:it'?s\s*)?([^.,\n]+)/i },
  { field: 'publish_date', re: /\b(?:year|publication date|publish date)\s*(?:is|should be|:)\s*([^.,\n]+)/i },
];

const SUBJECT_HINT_RE = /(?:mainly|primarily|really|actually)?\s*about\s+([^.,\n]+)|subject is\s+([^.,\n]+)|this is (?:mainly |primarily )?about\s+([^.,\n]+)/i;

function extractDdcNumber(message) {
  const match = message.match(DDC_NUMBER_RE);
  return match ? match[0] : null;
}

function parseIntent(message) {
  const text = clean(message);
  if (!text) return { intent: 'unknown' };

  if (WHY_RE.test(text)) return { intent: 'explain' };

  if (WRONG_BOOK_RE.test(text)) return { intent: 'wrong_book' };

  if (DDC_INTENT_RE.test(text) && DDC_NUMBER_RE.test(text)) {
    return { intent: 'override_ddc', number: extractDdcNumber(text) };
  }

  for (const pattern of FIELD_NEEDS_VALUE_PATTERNS) {
    if (pattern.re.test(text)) return { intent: 'correct_metadata_needs_value', field: pattern.field };
  }

  for (const pattern of FIELD_PATTERNS) {
    const match = text.match(pattern.re);
    if (match) {
      const value = clean(match[1]);
      if (value && value.toLowerCase() !== 'wrong') return { intent: 'correct_metadata', field: pattern.field, value, arrayField: Boolean(pattern.arrayField) };
    }
  }

  const subjectMatch = text.match(SUBJECT_HINT_RE);
  if (subjectMatch) {
    const hint = clean(subjectMatch[1] || subjectMatch[2] || subjectMatch[3]);
    if (hint) return { intent: 'subject_hint', hint };
  }

  if (REJECT_MARC_FIELD_RE.test(text)) return { intent: 'reanalyze' };
  if (REANALYZE_RE.test(text)) return { intent: 'reanalyze' };

  return { intent: 'unknown' };
}

// ---------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------

function friendlyFieldLabel(field) {
  return { authors: 'author', publisher: 'publisher', title: 'title', edition: 'edition', publish_date: 'publication date' }[field] ?? field;
}

export function handleChatMessage({ message, context = {} } = {}) {
  const parsed = parseIntent(message);
  const ddc = context.ddc?.decision ?? null;

  switch (parsed.intent) {
    case 'explain': {
      if (!ddc) {
        return {
          reply: "AutoCat hasn't classified a book yet -- look up an ISBN first, and I can explain the DDC recommendation once one exists.",
          intent: parsed.intent,
        };
      }
      const breakdownItems = ddc.number_breakdown?.length
        ? ddc.number_breakdown
        : (ddc.classification_path ?? []).map((n) => ({ number: n, label: findBundledClass(n)?.label || MAIN_CLASSES[n] || '' }));
      const breakdown = breakdownItems.length ? breakdownItems.map((p) => `${p.number} — ${p.label}`).join(' → ') : null;
      return {
        reply: [
          ddc.justification || 'No justification is available for this recommendation.',
          breakdown ? `Number breakdown: ${breakdown}.` : null,
          `Confidence: ${ddc.recommended_ddc?.confidence ?? 'UNKNOWN'}.`,
        ].filter(Boolean).join(' '),
        intent: parsed.intent,
      };
    }

    case 'wrong_book':
      return {
        reply: "Understood -- this doesn't look right. Enter the correct ISBN (or edition) and I'll research that instead. I won't reuse anything from this lookup.",
        intent: parsed.intent,
        request_relookup: true,
      };

    case 'override_ddc': {
      if (!parsed.number) {
        return { reply: "I heard you want to change the DDC number, but I couldn't find a number in your message. What number would you like?", intent: parsed.intent };
      }
      const evaluation = evaluateProposedDdc(parsed.number);
      if (!evaluation.valid) {
        return {
          reply: `I can't accept ${parsed.number} as-is: ${evaluation.reason} AutoCat's current recommendation${ddc?.recommended_ddc ? ` (${ddc.recommended_ddc.number} — ${ddc.recommended_ddc.label})` : ''} stays in place unless you give me a valid DDC 23 number.`,
          intent: parsed.intent,
          ddc_override: evaluation,
        };
      }
      return {
        reply: `${evaluation.number} (${evaluation.label}) is a valid DDC 23 number. I've set it as your cataloguer-approved classification, replacing AutoCat's recommendation${ddc?.recommended_ddc ? ` of ${ddc.recommended_ddc.number}` : ''}. MARC will be regenerated with this number.`,
        intent: parsed.intent,
        ddc_override: evaluation,
      };
    }

    case 'correct_metadata_needs_value':
      return {
        reply: `What is the correct ${friendlyFieldLabel(parsed.field)}? I won't guess -- tell me the value and I'll use it.`,
        intent: parsed.intent,
      };

    case 'correct_metadata': {
      const value = parsed.arrayField ? [parsed.value] : parsed.value;
      return {
        reply: `Got it -- I've recorded ${friendlyFieldLabel(parsed.field)} as "${parsed.value}" (your correction, not from a source lookup). MARC will be regenerated with this value.`,
        intent: parsed.intent,
        metadata_patch: { [parsed.field]: value },
      };
    }

    case 'subject_hint':
      return {
        reply: `Thanks -- I'll weigh "${parsed.hint}" heavily and re-analyse the book's whole-book subject with that in mind.`,
        intent: parsed.intent,
        // Fed into wholeBookSubjectAnalyzer's evidence via metadata.keywords
        // (merged with, not replacing, any existing keywords) rather than a
        // one-off field the analyzer doesn't read -- this is real evidence
        // weighting, not a cosmetic label.
        metadata_patch: { keywords_add: [parsed.hint] },
        needs_reanalysis: true,
      };

    case 'reanalyze':
      return {
        reply: "Re-analysing the book and regenerating the DDC recommendation and MARC record now.",
        intent: parsed.intent,
        needs_reanalysis: true,
      };

    default:
      return {
        reply: "I can help with things like: \"this DDC is wrong, use 332.6\", \"this is mainly about investment\", \"the author is wrong, it's Jane Doe\", \"this is the wrong book\", \"why this number?\", or \"reanalyse the book\". What would you like to change?",
        intent: 'unknown',
      };
  }
}
