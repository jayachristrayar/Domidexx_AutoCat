// Content-first classification of literary works (fiction, poetry, drama,
// essays, etc.) into DDC 23's Literature main class (800).
//
// This exists so a literary work is classified from what it actually IS --
// language/literary tradition + form + (where evidence supports it)
// historical period -- rather than by incidental keyword matches against
// unrelated metadata text. That keyword-matching approach is what
// previously misclassified "Wuthering Heights" (a 19th-century English
// novel) as 025 "Library operations": boilerplate catalog text such as
// "Includes bibliographical references and index" -- extremely common in
// real bibliographic metadata for annotated/classics editions, and utterly
// unrelated to the book's actual subject -- contains the word "reference",
// which a blind regex-over-JSON.stringify(metadata) approach would match
// against a library-operations alias. A literary work must never be run
// through that kind of generic subject matching at all; see
// ddcCandidateService.js, which now calls classifyLiteraryWork() FIRST and
// only falls through to the non-fiction subject matcher when this returns
// null.
//
// The language-block and form-digit tables below are DDC 23's own,
// published class structure -- not project-specific data. The Literatures
// main class (800) is subdivided by language into ten-number blocks (810
// American literature in English, 820 English & Old English literatures,
// 830 German, 840 French, 850 Italian/Romanian, 860 Spanish/Portuguese,
// 870 Latin/Italic, 880 Classical Greek/Hellenic, 890 other languages), and
// each block is subdivided by the same final-digit pattern for literary
// form (1 poetry, 2 drama, 3 fiction, 4 essays, 5 speeches, 6 letters,
// 7 satire & humor, 8 miscellaneous writings). English literature's
// historical-period table (the decimal digit appended to 821/822/823/etc,
// e.g. 823.8 for the Victorian period) is likewise DDC 23's own table, not
// invented here -- see ENGLISH_PERIODS below for exact boundaries used.
//
// Deliberately conservative: a period digit is only ever appended when
// there is real evidence of the work's original publication era (an
// explicit "first published"/"originally published" year, or -- lacking
// that -- a plausible original-edition publish_date). Absent that
// evidence, classifyLiteraryWork() returns the base form number (e.g. 823)
// with no invented decimal, and says so via `period: null` / lower
// confidence -- "never invent decimal numbers" (product spec section 10).

function clean(value) {
  return String(value ?? '').trim();
}

function arr(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
}

// Curated evidence fields only -- NEVER JSON.stringify(metadata) wholesale.
// Provenance/source blobs, raw provider payloads, and other non-content
// metadata must never be treated as classification evidence.
function evidenceText(metadata = {}) {
  return [
    metadata.title,
    metadata.subtitle,
    metadata.edition,
    ...arr(metadata.subjects ?? metadata.subject_headings),
    ...arr(metadata.genre),
    ...arr(metadata.keywords),
    metadata.description ?? metadata.abstract,
    ...arr(metadata.table_of_contents),
    ...arr(metadata.chapter_titles),
    metadata.physical_description?.format,
  ]
    .filter(Boolean)
    .map(String)
    .join(' \n ');
}

const FICTION_SUBJECT_RE = /\bfiction\b|\bnovel(?:s|la)?\b|short stories/i;
const POETRY_RE = /\bpoetry\b|\bpoems?\b|\bverse\b/i;
// "theatre"/"theater" deliberately excluded: overwhelmingly a discipline/
// venue/subject-area word in real bibliographic metadata ("Theatre Studies",
// "Performance Studies", a subject heading for a book ABOUT the performing
// arts) rather than evidence the book itself IS a play -- keeping it here
// previously misclassified nonfiction scholarship on theatre/performance
// (e.g. a research-methods volume with a "Theatre" subject heading) as
// literary drama (820s), the exact class of false positive this module's
// own header comment (see "Wuthering Heights"/025 example) exists to avoid.
// "drama"/"play(s)" are kept -- those words far more specifically name the
// literary form itself, not just the surrounding discipline.
const DRAMA_RE = /\bdrama\b|\bplays?\b/i;
const NON_LITERARY_FORM_RE = /\bnonfiction\b|\btextbook\b|\breference work\b/i;

const LANGUAGE_BLOCKS = [
  { block: 'american_english', base: 810, langs: ['eng'] },
  { block: 'english', base: 820, langs: ['eng'] },
  { block: 'german', base: 830, langs: ['ger', 'deu'] },
  { block: 'french', base: 840, langs: ['fre', 'fra'] },
  { block: 'italian_romanian', base: 850, langs: ['ita', 'ron', 'rum'] },
  { block: 'spanish_portuguese', base: 860, langs: ['spa', 'por'] },
  { block: 'latin_italic', base: 870, langs: ['lat'] },
  { block: 'classical_greek', base: 880, langs: ['grc', 'gre', 'ell'] },
];
const OTHER_LANGUAGE_BASE = 890;

const FORM_DIGIT = { poetry: 1, drama: 2, fiction: 3, essays: 4, speeches: 5, letters: 6, satire_humor: 7, miscellany: 8 };
const FORM_LABEL = {
  poetry: 'poetry',
  drama: 'drama',
  fiction: 'fiction',
  essays: 'essays',
  speeches: 'speeches',
  letters: 'letters',
  satire_humor: 'satire & humor',
  miscellany: 'miscellaneous writings',
};

const LANGUAGE_LABEL = {
  american_english: 'American literature in English',
  english: 'English & Old English literatures',
  german: 'German literature',
  french: 'French literature',
  italian_romanian: 'Italian, Romanian & related literatures',
  spanish_portuguese: 'Spanish & Portuguese literatures',
  latin_italic: 'Latin & Italic literatures',
  classical_greek: 'Classical Greek (Hellenic) literatures',
  other: 'Literature of another language',
};

// DDC 23's historical-period table for English-language literature,
// applied to the American (810) and English (820) blocks. Boundaries:
// Victoria's reign begins 1837, hence 1838-1900 for the Victorian period.
const ENGLISH_PERIODS = [
  { digit: '1', from: -Infinity, to: 1099, label: 'Old English (Anglo-Saxon) period' },
  { digit: '2', from: 1100, to: 1500, label: 'Middle English period' },
  { digit: '3', from: 1501, to: 1660, label: 'Elizabethan & early Stuart (Renaissance) period' },
  { digit: '4', from: 1661, to: 1700, label: 'Restoration period' },
  { digit: '5', from: 1701, to: 1745, label: 'Augustan / early 18th-century period' },
  { digit: '6', from: 1746, to: 1800, label: 'Later 18th-century period' },
  { digit: '7', from: 1801, to: 1837, label: 'Romantic period' },
  { digit: '8', from: 1838, to: 1900, label: 'Victorian period' },
  { digit: '9', from: 1901, to: Infinity, label: '20th-century and later' },
];

function periodForYear(year) {
  return ENGLISH_PERIODS.find((p) => year >= p.from && year <= p.to) ?? null;
}

// --- Form (genre) detection ---------------------------------------------

function detectForm(text) {
  // Order matters: poetry/drama signals are checked before the broader
  // "fiction" signal so a book of "poetry" isn't also read as prose fiction
  // just because a description happens to say "a work of fiction and verse".
  if (POETRY_RE.test(text)) return 'poetry';
  if (DRAMA_RE.test(text)) return 'drama';
  if (FICTION_SUBJECT_RE.test(text)) return 'fiction';
  return null;
}

// --- Language block detection -------------------------------------------

function normalizeLanguageCode(language) {
  const value = clean(language).toLowerCase();
  if (!value) return null;
  if (/^[a-z]{3}$/.test(value)) return value;
  const map = { english: 'eng', german: 'ger', deutsch: 'ger', french: 'fre', italian: 'ita', spanish: 'spa', portuguese: 'por', latin: 'lat', greek: 'grc' };
  return map[value] ?? null;
}

function detectLanguageBlock(metadata) {
  const lang = normalizeLanguageCode(metadata.language) || 'eng'; // most AutoCat catalogues are English-language collections; absent explicit evidence, prose/verse/drama text is assumed English until told otherwise (still surfaced as MEDIUM confidence, never HIGH, when language wasn't explicit)
  const langWasExplicit = Boolean(normalizeLanguageCode(metadata.language));

  if (lang === 'eng') {
    // American vs. British/other English: look for an explicit nationality
    // signal rather than guessing. Absent one, default to the broader 820
    // "English & Old English literatures" block (correct home for English
    // fiction whenever it is not specifically identified as American).
    const nationalityText = `${clean(metadata.publisher)} ${clean(metadata.publish_place)} ${evidenceText(metadata)}`;
    const isAmerican = /\bAmerican literature\b|\bUnited States\b/i.test(nationalityText);
    return { block: isAmerican ? 'american_english' : 'english', base: isAmerican ? 810 : 820, langWasExplicit };
  }

  const known = LANGUAGE_BLOCKS.find((b) => b.langs.includes(lang));
  if (known) return { block: known.block, base: known.base, langWasExplicit };
  return { block: 'other', base: OTHER_LANGUAGE_BASE, langWasExplicit };
}

// --- Period (era) detection ----------------------------------------------

const FIRST_PUBLISHED_RE = /\b(?:first|originally)\s+published(?:\s+in)?\s+(\d{4})\b/i;
const WRITTEN_IN_RE = /\bwritten\s+in\s+(\d{4})\b/i;
const PARENTHETICAL_YEAR_RE = /\((\d{4})\)/;

function detectOriginalYear(metadata) {
  const text = evidenceText(metadata);
  const explicit = text.match(FIRST_PUBLISHED_RE) || text.match(WRITTEN_IN_RE);
  if (explicit) return { year: Number(explicit[1]), source: 'explicit_first_published_evidence' };

  const parenthetical = clean(metadata.title).match(PARENTHETICAL_YEAR_RE) || text.match(PARENTHETICAL_YEAR_RE);
  if (parenthetical) return { year: Number(parenthetical[1]), source: 'parenthetical_year_in_evidence' };

  // Fall back to the edition's own publish_date ONLY when nothing else is
  // available -- and only when it looks like an early/likely-original
  // edition (no reprint/edition marker like "2nd ed.", "reprint",
  // "anniversary edition"), since a reprint's publish_date is frequently
  // decades or centuries after the work's real original period and using
  // it would fabricate false precision.
  const editionLooksLikeReprint = /reprint|anniversary|revised|new edition|\b\d+(?:st|nd|rd|th)\s+ed(?:ition)?\b/i.test(clean(metadata.edition));
  const publishYearMatch = clean(metadata.publish_date).match(/(\d{4})/);
  if (publishYearMatch && !editionLooksLikeReprint) {
    return { year: Number(publishYearMatch[1]), source: 'edition_publish_date_weak_evidence' };
  }

  return null;
}

// --- Public API ------------------------------------------------------------

/**
 * Classify a book as a literary work, or return null if it doesn't look
 * like one. Never returns a library-science/subject-domain number -- a
 * literary work's DDC number always comes from language + form (+ period),
 * per DDC 23's Literature main class structure.
 */
export function classifyLiteraryWork(metadata = {}) {
  const text = evidenceText(metadata);
  // An explicit, cataloguer-supplied form (via chat: "this is a novel") is
  // authoritative and skips text-based detection/the NON_LITERARY_FORM_RE
  // guard entirely -- the librarian has already told us what this is.
  const hintedForm = clean(metadata.form_hint).toLowerCase();
  const form = FORM_DIGIT[hintedForm] ? hintedForm : (NON_LITERARY_FORM_RE.test(text) ? null : detectForm(text));
  if (!form) return null;

  const digit = FORM_DIGIT[form];
  const { block, base, langWasExplicit } = detectLanguageBlock(metadata);
  const baseNumber = String(base + digit);

  const originalYear = ['american_english', 'english'].includes(block) ? detectOriginalYear(metadata) : null;
  const period = originalYear ? periodForYear(originalYear.year) : null;

  const finalNumber = period ? `${baseNumber}.${period.digit}` : baseNumber;

  const evidence = [];
  const formWasHinted = FORM_DIGIT[hintedForm] === digit;
  if (formWasHinted) evidence.push({ type: 'cataloguer_form_hint', value: `Cataloguer confirmed this is ${FORM_LABEL[form]}.` });
  else if (FICTION_SUBJECT_RE.test(text) && form === 'fiction') evidence.push({ type: 'form_evidence', value: 'Metadata identifies this as fiction/a novel.' });
  else if (POETRY_RE.test(text) && form === 'poetry') evidence.push({ type: 'form_evidence', value: 'Metadata identifies this as poetry/verse.' });
  else if (DRAMA_RE.test(text) && form === 'drama') evidence.push({ type: 'form_evidence', value: 'Metadata identifies this as drama/a play.' });
  if (langWasExplicit) evidence.push({ type: 'language_evidence', value: `Language metadata: ${metadata.language}.` });
  if (originalYear) evidence.push({ type: 'period_evidence', value: `Original publication era evidence (${originalYear.source}): ${originalYear.year}.` });

  let confidence = 'MEDIUM';
  if (period && originalYear?.source === 'explicit_first_published_evidence' && langWasExplicit) confidence = 'HIGH';
  else if (formWasHinted && (period || langWasExplicit)) confidence = 'HIGH';
  else if (!period && !langWasExplicit && !formWasHinted) confidence = 'LOW';

  return {
    work_type: form.toUpperCase(),
    form,
    language_block: block,
    language_label: LANGUAGE_LABEL[block] ?? LANGUAGE_LABEL.other,
    base_number: baseNumber,
    period: period ? { digit: period.digit, label: period.label, year: originalYear.year, source: originalYear.source } : null,
    number: finalNumber,
    label: period
      ? `${languageAdjective(block)} ${FORM_LABEL[form]} — ${period.label}`
      : `${languageAdjective(block)} ${FORM_LABEL[form]}`,
    evidence,
    confidence,
  };
}

function languageAdjective(block) {
  return { american_english: 'American', english: 'English', german: 'German', french: 'French', italian_romanian: 'Italian/Romanian', spanish_portuguese: 'Spanish/Portuguese', latin_italic: 'Latin', classical_greek: 'Classical Greek', other: 'Literary' }[block] ?? 'Literary';
}

// ---------------------------------------------------------------------
// Classification validation guard (product spec: "validate before display,
// never show a bare main class or wrong-domain number for an identified
// work type"). Used both by the automatic pipeline (ddcCandidateService)
// and the chatbot (chatService, when a librarian proposes a number).
// ---------------------------------------------------------------------

const MAIN_CLASS_ONLY_RE = /^\d00$/;

export function validateClassificationAgainstWorkType(number, literaryClassification) {
  const n = clean(number);
  if (MAIN_CLASS_ONLY_RE.test(n)) {
    return { valid: false, reason: `${n} is only a DDC main class, not a complete classification.` };
  }
  if (!literaryClassification) return { valid: true };

  const mainClass = Math.floor(Number(n.slice(0, 3)) / 100) * 100;
  if (mainClass !== 800) {
    return {
      valid: false,
      reason: `${n} is outside Literature (800) but this work was identified as ${literaryClassification.form} (${literaryClassification.language_label}); a literary work's classification must come from DDC 23's Literature main class, not a subject-domain guess.`,
    };
  }
  return { valid: true };
}
