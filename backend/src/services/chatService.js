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

// "check/search/look .../find ... web/online/internet" -- a librarian
// asking AutoCat to research the current ISBN on the web. Checked BEFORE
// the plain web_lookup pattern below (deep_web_lookup is the more specific
// match): "complete"/"entire"/"everywhere"/"all available sources"/"all
// over the web" signal a deeper, multi-source research pass rather than
// the normal single-pass lookup.
const DEEP_WEB_LOOKUP_RE =
  /\bcomplete(?:ly)?\b[\s\S]*\bweb\b|\bweb\b[\s\S]*\bcomplete(?:ly)?\b|search everywhere|all over the web|all available sources|entire web|research[\s\S]*\bcompletely\b/i;
const WEB_LOOKUP_RE = /\b(check|search|look|find)\b[\s\S]*\b(web|online|internet)\b/i;
const REANALYZE_RE = /reanaly[sz]e|re-?analy[sz]e|analy[sz]e (?:it |the book )?again|generate marc again|regenerate|redo|start over|try again|use the (?:table of contents|toc) more|reclassify/i;
const REJECT_MARC_FIELD_RE = /do not use that metadata|ignore that (?:metadata|source)/i;

// A rejection with NO proposed replacement ("025 is wrong", "this DDC is
// wrong", "that's not right") -- distinct from override_ddc (which always
// carries a specific number the librarian wants used instead). This must
// force real reconsideration, not just redraw the displayed text: the
// rejected number is excluded from the next classification pass (see
// metadata.excluded_ddc, consumed by ddcCandidateService.js).
const REJECT_DDC_RE = /\b(\d{2,3}(?:\.\d+)?)\s+is\s+wrong\b|\bthis\s+(?:ddc|classification|number)\s+is\s+wrong\b|\bthat'?s\s+(?:not\s+right|wrong)\b/i;

// Explicit genre/form statements ("this is a novel", "this is poetry") are
// strong, cataloguer-supplied evidence -- passed through as metadata.form_hint
// so literaryDdc.js treats them as authoritative rather than re-deriving
// form from incidental text.
const GENRE_STATEMENT_RE = /\bthis\s+is\s+(?:a|an)?\s*(novel|fiction|short stor(?:y|ies)|poem|poetry|verse|play|drama)\b/i;
const GENRE_TO_FORM = { novel: 'fiction', fiction: 'fiction', 'short story': 'fiction', 'short stories': 'fiction', poem: 'poetry', poetry: 'poetry', verse: 'poetry', play: 'drama', drama: 'drama' };

const NOT_DOMAIN_RE = /not a library (?:science|and information science)?\s*book|not (?:about|a) library (?:science|operations)|this is not (?:about )?(?:library science|library operations)/i;

const FIELD_NEEDS_VALUE_PATTERNS = [
  { field: 'authors', re: /^\s*(?:the )?author(?:'s|s')?\s*(?:name)? is wrong\.?\s*$/i },
  { field: 'publisher', re: /^\s*(?:the )?publisher(?:'s)?\s*(?:name)? is wrong\.?\s*$/i },
  { field: 'title', re: /^\s*(?:the )?title is wrong\.?\s*$/i },
  { field: 'edition', re: /^\s*(?:the )?edition is wrong\.?\s*$/i },
];

const FIELD_PATTERNS = [
  { field: 'authors', re: /\bauthor(?:'s|s')?\s*(?:name)?\s*(?:is|should be|:)\s*(?:wrong,?\s*)?(?:it'?s\s*)?([^.,\n]+)/i, arrayField: true },
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

// Fields whose value is stored as an array in metadata (see marcPipeline's
// normalizeMarcMetadata) -- used both by the explicit FIELD_PATTERNS below
// and by the pending-field fallback so a bare follow-up reply gets the
// same shape as an explicit "author is ..." statement would.
const ARRAY_FIELDS = new Set(['authors']);

function parseIntent(message, context = {}) {
  const text = clean(message);
  if (!text) return { intent: 'unknown' };

  if (WHY_RE.test(text)) return { intent: 'explain' };

  if (WRONG_BOOK_RE.test(text)) return { intent: 'wrong_book' };

  if (DEEP_WEB_LOOKUP_RE.test(text)) return { intent: 'deep_web_lookup' };
  if (WEB_LOOKUP_RE.test(text)) return { intent: 'web_lookup' };

  // A message that both rejects the current number AND proposes a specific
  // replacement ("this DDC is wrong, use 025 instead") is an override, not
  // a bare rejection -- checked first so the proposed number isn't lost.
  if (DDC_INTENT_RE.test(text) && DDC_NUMBER_RE.test(text)) {
    return { intent: 'override_ddc', number: extractDdcNumber(text) };
  }

  const rejectMatch = text.match(REJECT_DDC_RE);
  if (rejectMatch) return { intent: 'reject_ddc', rejectedNumber: rejectMatch[1] || null };

  const genreMatch = text.match(GENRE_STATEMENT_RE);
  if (genreMatch) {
    const form = GENRE_TO_FORM[genreMatch[1].toLowerCase()] ?? GENRE_TO_FORM[genreMatch[1].toLowerCase().replace(/s$/, '')];
    if (form) return { intent: 'genre_hint', form, label: genreMatch[1] };
  }

  if (NOT_DOMAIN_RE.test(text)) return { intent: 'reject_domain' };

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

  // Nothing above matched a recognizable command -- if AutoCat just asked a
  // clarifying question ("What is the correct author name?"), the whole
  // message is the librarian's plain-text answer to that question, not a
  // failed command (product spec: "author name is wrong" / "Emily Bronte"
  // must be understood as one continuous correction, not two disconnected
  // messages).
  if (context.pending_field) {
    return { intent: 'correct_metadata', field: context.pending_field, value: text, arrayField: ARRAY_FIELDS.has(context.pending_field) };
  }

  return { intent: 'unknown' };
}

// ---------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------

function friendlyFieldLabel(field) {
  return { authors: 'author', publisher: 'publisher', title: 'title', edition: 'edition', publish_date: 'publication date' }[field] ?? field;
}

export function handleChatMessage({ message, context = {} } = {}) {
  const parsed = parseIntent(message, context);
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

    // web_lookup / deep_web_lookup never fabricate a result themselves --
    // they hand the current ISBN back to the extension's existing
    // action-dispatch mechanism (the same one request_relookup/ddc_override/
    // needs_reanalysis already use) as a `web_research` action, which the
    // extension picks up and sends to the real backend research endpoint
    // (POST /records/research/:isbn -> isbnLookup.js's
    // lookupIsbnWebFallback/researchIsbnOnWeb -- the actual web-search
    // service, reused as-is).
    case 'web_lookup':
    case 'deep_web_lookup': {
      const deep = parsed.intent === 'deep_web_lookup';
      if (!context.isbn) {
        return {
          reply: "I don't have an ISBN to research yet -- scan or enter one first, then ask me to check the web.",
          intent: parsed.intent,
        };
      }
      return {
        reply: deep
          ? `Researching ISBN ${context.isbn} across multiple web sources now -- this may take a moment.`
          : `Checking the web for ISBN ${context.isbn} now.`,
        intent: parsed.intent,
        web_research: { isbn: context.isbn, deep },
      };
    }

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

    case 'reject_ddc': {
      const rejected = parsed.rejectedNumber || ddc?.recommended_ddc?.number || null;
      return {
        reply: rejected
          ? `Understood -- ${rejected} is rejected. I'm reconsidering the classification from the book's actual content, not just changing the displayed text.`
          : "Understood -- reconsidering the classification from the book's actual content.",
        intent: parsed.intent,
        metadata_patch: rejected ? { excluded_ddc_add: [rejected] } : undefined,
        needs_reanalysis: true,
      };
    }

    case 'genre_hint':
      return {
        reply: `Thanks -- I'll treat this as ${parsed.label} and reclassify it under DDC 23's Literature class accordingly, rather than a subject-domain guess.`,
        intent: parsed.intent,
        // Authoritative cataloguer-supplied evidence -- literaryDdc.js
        // trusts an explicit form_hint over its own text-based detection.
        metadata_patch: { form_hint: parsed.form },
        needs_reanalysis: true,
      };

    case 'reject_domain':
      return {
        reply: "Understood -- I won't classify this as library science. Re-analysing based on the book's actual content.",
        intent: parsed.intent,
        metadata_patch: ddc?.recommended_ddc?.number ? { excluded_ddc_add: [ddc.recommended_ddc.number] } : undefined,
        needs_reanalysis: true,
      };

    case 'correct_metadata_needs_value':
      return {
        reply: `Sure -- what is the correct ${friendlyFieldLabel(parsed.field)}? I won't guess; tell me the value and I'll use it.`,
        intent: parsed.intent,
        // Remembered so the librarian's next plain-text reply (no keyword
        // needed) is understood as the answer -- see parseIntent's
        // pending_field fallback.
        pending_field: parsed.field,
      };

    case 'correct_metadata': {
      const value = parsed.arrayField ? [parsed.value] : parsed.value;
      return {
        reply: `Got it. I've updated the ${friendlyFieldLabel(parsed.field)} to ${parsed.value}. I'll use the corrected ${friendlyFieldLabel(parsed.field)} when rechecking the classification.`,
        intent: parsed.intent,
        metadata_patch: { [parsed.field]: value },
        // A corrected author/title/etc. can change the correct DDC number,
        // so re-run classification and MARC automatically rather than
        // leaving a stale recommendation on screen (product spec section 4).
        needs_reanalysis: true,
        pending_field: null,
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
        reply: "I can help with things like: \"025 is wrong\", \"this DDC is wrong, use 332.6\", \"this is a novel\", \"this is mainly about investment\", \"the author is wrong, it's Jane Doe\", \"this is the wrong book\", \"why this number?\", \"reclassify this book\", \"check the web\", or \"check complete web to find this ISBN\". What would you like to change?",
        intent: 'unknown',
      };
  }
}
