// Pure, deterministic construction of a partial MARC record from a
// normalized ISBN-lookup result (see isbnLookup.js's mergeSources output
// shape). No LLM calls happen here -- see fields_needing_llm in the return
// value for what's left for a later AI-drafting step to fill in.
//
// P1: consults the runtime rule registry. Every emitted tag must have a
// rule; missing rules are reported as BUILDER_WITHOUT_RULE (never silent).

import {
  getCataloguingSourceConfig,
  getMarcRule,
  hasMarcRule,
  normalizeMarcTag,
} from './marcRuleRegistry.js';

// Tags this module is responsible for constructing mechanically when LOC
// didn't already supply them.
const MECHANICAL_TAGS = ['020', '245', '250', '260', '300'];

/** Tags the builder may emit (mechanical + control + optional config-driven). */
export function getBuilderMechanicalTags() {
  return [...MECHANICAL_TAGS];
}

export function getBuilderEmittedTags() {
  // Actual generation surface for consistency checking.
  return ['000', '008', '020', '040', '245', '250', '260', '300', '082', '100', '110', '111', '520', '600', '610', '650', '700', '710', '711'];
}

// Tags/tag-families that need cataloguing JUDGMENT (classification,
// main/added entry choice, subject analysis, a summary) rather than
// mechanical transcription -- per rules/shared/isbd_and_entry_rules.json
// "AACR2 main/added entry choice rules" (section 5), choosing 100 vs. a
// 700 added entry, or whether a corporate body qualifies for 110, requires
// judging the work itself (single vs. shared vs. mixed responsibility,
// AACR2 21.1B2's corporate-responsibility test) -- not something pure code
// can decide from a flat bibliographic-data object. Grouped by family
// (matching the task's own "1xx"/"6xx"/"7xx" notation) since we can't
// commit to a specific member (e.g. 100 vs. 110 vs. 111) without that same
// judgment. buildSkeleton never invents content for these; it only passes
// through whatever LOC's real MARC record already supplied for them.
const LLM_FAMILY_TAGS = {
  '082': ['082'],
  '1xx': ['100', '110', '111'],
  '6xx': ['600', '610', '650'],
  '520': ['520'],
  '7xx': ['700', '710', '711'],
};

function getLocFields(normalizedBiblioData) {
  if (!normalizedBiblioData?.sources?.loc_marc) return [];
  return normalizedBiblioData.sources.z3950?.fields ?? [];
}

// Converts z3950Lookup.js's internal { tag, indicators: "1 "|null,
// subfields: [{code,value}]|null, value? } shape (see toInternalMarc there)
// into this module's { tag, indicators: [ind1, ind2], subfields } shape.
// Used verbatim for LOC-supplied fields -- no reformatting, no
// re-punctuating, exactly as the task requires ("use those exact fields
// as-is").
function toSkeletonEntry(locEntry) {
  if (locEntry.indicators === null) {
    // Control field (001, 008, ...) -- no indicators/subfields in real
    // MARC; represented with a single pseudo-subfield carrying the raw value
    // so every skeleton entry shares one shape.
    return { tag: locEntry.tag, indicators: [null, null], subfields: [{ code: null, value: locEntry.value }] };
  }
  const [ind1, ind2] = locEntry.indicators.split('');
  return {
    tag: locEntry.tag,
    indicators: [ind1 ?? ' ', ind2 ?? ' '],
    subfields: (locEntry.subfields ?? []).map((subfield) => ({ code: subfield.code, value: subfield.value })),
  };
}

// --- 020: International Standard Book Number ---
// rules/marc_field_rules.json, tag "020": "$a: Enter the 13-digit ISBN
// with no spaces or hyphens" + "If the item shows a 10-digit ISBN only,
// convert to the current 13-digit form for entry". 020 has no defined
// MARC21 indicator values (both blank) -- matches the rule's own "Full
// field example" showing no indicator content.
function isbn10to13(isbn10) {
  const core = isbn10.slice(0, 9).replace(/[^0-9]/g, '');
  const prefixed = `978${core}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += parseInt(prefixed[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return `${prefixed}${checkDigit}`;
}

function build020(normalizedBiblioData) {
  const isbn = (normalizedBiblioData.isbn || '').replace(/[-\s]/g, '');
  if (!isbn) return null;
  const isbn13 = isbn.length === 10 ? isbn10to13(isbn) : isbn;
  return {
    tag: '020',
    indicators: [' ', ' '],
    subfields: [{ code: 'a', value: isbn13 }],
  };
}

// --- 245: Title Statement ---
// rules/marc_field_rules.json, tag "245": "$a ends with ' :' only if $b
// follows; otherwise ends the whole field with a full stop if $c is
// absent. $b always ends with ' /' before $c." + rules/shared/
// isbd_and_entry_rules.json "Statement of responsibility (245$c)
// scenarios" (section 3) for $c's own construction.
//
// The field rule doesn't explicitly state what $a ends with when $b is
// ABSENT but $c is present (no subtitle, but a statement of responsibility
// follows) -- extrapolated here from $b's stated " /"-before-$c pattern:
// by symmetry, $a takes that same " /" when it's the subfield directly
// preceding $c. Flagging this as an inference, not a rule taken verbatim.
const NONFILING_ARTICLES = new Set(['the', 'a', 'an']);

function countNonfilingChars(title) {
  const match = (title || '').match(/^(\p{L}+)\s+/u);
  if (!match || !NONFILING_ARTICLES.has(match[1].toLowerCase())) return 0;
  return match[1].length + 1;
}

// section 3.2: same-function names joined by comma/'and' up to three in
// full; a fourth or more truncated to the first name + ' [et al.]'
// (3.2(c)/(e), AACR2 1.1F5).
function formatNameList(names) {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]} [et al.]`;
}

// section 3.1: different-function clauses joined by ' ; '; whole statement
// ends with a full stop (3.1). Group order (author, editor, illustrator,
// translator) is a fixed convention, NOT a transcription of actual
// title-page order (3.2(j) calls for reading the title page top-to-bottom,
// which normalizedBiblioData -- already split into role arrays -- has no
// way to reconstruct).
function buildStatementOfResponsibility(normalizedBiblioData) {
  const roleGroups = [
    { names: normalizedBiblioData.authors ?? [], label: 'by' },
    { names: normalizedBiblioData.editors ?? [], label: 'edited by' },
    { names: normalizedBiblioData.illustrators ?? [], label: 'illustrated by' },
    { names: normalizedBiblioData.translators ?? [], label: 'translated by' },
  ].filter((group) => group.names.length > 0);

  if (roleGroups.length === 0) return null;

  return roleGroups.map((group) => `${group.label} ${formatNameList(group.names)}`).join(' ; ');
}

function build245(normalizedBiblioData) {
  const title = normalizedBiblioData.title;
  if (!title) return null;

  const subtitle = normalizedBiblioData.subtitle;
  const statementOfResponsibility = buildStatementOfResponsibility(normalizedBiblioData);

  const subfields = [];

  let titleValue = title.trim();
  if (subtitle) {
    titleValue += ' :';
  } else if (statementOfResponsibility) {
    titleValue += ' /'; // see comment above: extrapolated from $b's " /" pattern
  } else {
    titleValue += '.';
  }
  subfields.push({ code: 'a', value: titleValue });

  if (subtitle) {
    let subtitleValue = subtitle.trim();
    subtitleValue += statementOfResponsibility ? ' /' : '.';
    subfields.push({ code: 'b', value: subtitleValue });
  }

  if (statementOfResponsibility) {
    subfields.push({ code: 'c', value: `${statementOfResponsibility}.` });
  }

  // ind1 (title added entry): 1 if a 1xx main entry exists, else 0. At
  // skeleton-build time this is only knowable when LOC already supplied a
  // 1xx (main/added entry CHOICE is otherwise an AI-drafting decision --
  // see LLM_FAMILY_TAGS['1xx'] above, AACR2 ch. 21). Defaults to '0'
  // (title main entry) when unknown; may need correcting once the LLM step
  // resolves 1xx.
  const locFields = getLocFields(normalizedBiblioData);
  const hasLoc1xx = locFields.some((field) => ['100', '110', '111'].includes(field.tag));
  const ind1 = hasLoc1xx ? '1' : '0';
  const ind2 = String(countNonfilingChars(title));

  return { tag: '245', indicators: [ind1, ind2], subfields };
}

// --- 250: Edition Statement ---
// rules/marc_field_rules.json, tag "250": "$a: Copy as printed, abbreviated
// per AACR2 (e.g. 'ed.' for edition, 'rev.' for revised)" + "ends with a
// full stop unless $b ... follows". 250 has no defined indicators (blank).
//
// Common-terms abbreviation table only -- this is NOT the full AACR2
// Appendix B abbreviation list, just the cases the field rule itself names
// plus a few frequent equivalents. Expand here if more show up in practice.
const EDITION_ABBREVIATIONS = [
  [/\bedition\b/gi, 'ed.'],
  [/\brevised\b/gi, 'rev.'],
  [/\babridged\b/gi, 'abr.'],
  [/\billustrated\b/gi, 'ill.'],
  [/\benlarged\b/gi, 'enl.'],
];

function abbreviateEdition(edition) {
  let text = edition;
  for (const [pattern, replacement] of EDITION_ABBREVIATIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function build250(normalizedBiblioData) {
  const edition = normalizedBiblioData.edition;
  if (!edition) return null;

  let value = abbreviateEdition(edition.trim());
  if (!/\.$/.test(value)) value += '.';

  return { tag: '250', indicators: [' ', ' '], subfields: [{ code: 'a', value }] };
}

// extractYear(dateStr) -- AACR2 1.4F/rules/marc_field_rules.json's 260 rule
// calls for $c to be the publication YEAR, never a full date -- a source
// commonly gives "2025-09-15" (ISO) or "September 15, 2025" (prose); either
// way the first 4-digit token in the string IS the year. Shared with
// build008Entry's own year extraction below so both fields agree.
function extractYear(dateStr) {
  const match = String(dateStr ?? '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match ? match[1] : null;
}

// --- 260: Publication, Distribution, etc. ---
// rules/marc_field_rules.json, tag "260": "$a ends ' :' before $b; $b ends
// ',' before $c; $c ends '.' " + "if place/publisher is unknown, supply
// '[S.l.]' / '[s.n.]' per AACR2 1.4C6/1.4D6." No defined indicators for a
// simple monograph (blank/blank, matching the rule's own "260 ## " example).
//
// $a uses normalizedBiblioData.publication_place when the research pipeline
// actually found one (isbnLookup.js: Open Library's publish_places, a real
// LOC MARC 260/264 $a, or page/AI evidence -- see mergeSources/
// fetchPageEvidence/ddcAiClassifier.js) -- never invented. Only falls back
// to the AACR2 1.4C6 "place unknown" bracketed placeholder when the
// research genuinely turned up nothing, exactly as the rule itself
// prescribes for that case.
function build260(normalizedBiblioData) {
  const publisher = normalizedBiblioData.publisher;
  const publishDate = normalizedBiblioData.publish_date;
  const place = normalizedBiblioData.publication_place;
  if (!publisher && !publishDate) return null;

  const subfields = [
    { code: 'a', value: place ? `${place.trim()} :` : '[S.l.] :' }, // AACR2 1.4C6 -- bracketed placeholder only when place is genuinely unavailable
  ];
  subfields.push({ code: 'b', value: publisher ? `${publisher.trim()},` : '[s.n.],' }); // AACR2 1.4D6
  if (publishDate) {
    const year = extractYear(publishDate);
    subfields.push({ code: 'c', value: `${year ?? publishDate.trim()}.` });
  }

  return { tag: '260', indicators: [' ', ' '], subfields };
}

// --- 300: Physical Description ---
// rules/marc_field_rules.json, tag "300": "$a is followed by ' :' if $b
// (illustration statement) is present; $b is followed by ' ;' before $c
// (dimensions)". No defined indicators.
//
// Data-model gap: no source currently supplies an illustration statement
// ($b, e.g. "ill."), so $a/$c are joined directly with ' ;' -- the master
// punctuation table (rules/shared/isbd_and_entry_rules.json, mark ' ; ')
// covers "dimensions after other physical details" generically, not only
// specifically after $b.
function build300(normalizedBiblioData) {
  const { pages, dimensions } = normalizedBiblioData.physical_description ?? {};
  if (!pages && !dimensions) return null;

  const subfields = [];
  if (pages) {
    subfields.push({ code: 'a', value: dimensions ? `${pages} p. ;` : `${pages} p.` });
  }
  if (dimensions) {
    subfields.push({ code: 'c', value: `${dimensions}.` });
  }

  return { tag: '300', indicators: [' ', ' '], subfields };
}

const MECHANICAL_BUILDERS = {
  '020': build020,
  '245': build245,
  '250': build250,
  '260': build260,
  '300': build300,
};

// --- Leader / 008: basic defaults for a printed monograph ---
// TODO: this is a deliberately minimal placeholder, not a full MARC21
// fixed-field implementation. Positions with no basis in normalizedBiblioData
// (encoding level, contents/audience/form codes, government/conference/
// festschrift/index/literary-form/biography codes in 008/18-34, and the
// place-of-publication code in 008/15-17 -- same place-data gap as 260
// above) are left blank ("not coded") rather than guessed. Revisit once
// this backend actually has that data (or once Koha's own defaults can be
// relied on to fill these in on import).
function buildLeaderEntry(normalizedBiblioData, ruleProfile) {
  // Prefer LOC's real leader when we have one -- it reflects the actual
  // record, not a generic default.
  if (normalizedBiblioData?.sources?.loc_marc && normalizedBiblioData.sources.z3950?.leader) {
    return { tag: 'LDR', indicators: [null, null], subfields: [{ code: null, value: normalizedBiblioData.sources.z3950.leader }] };
  }

  const isAacr2 = /AACR2/i.test(ruleProfile?.cataloguing_standard ?? '');
  const leader =
    '00000' + // 00-04 record length -- computed at final encoding time, not here
    'n' + // 05 record status: new
    'a' + // 06 type of record: language material
    'm' + // 07 bibliographic level: monograph/item
    ' ' + // 08 type of control
    'a' + // 09 character coding: UTF-8
    '2' + // 10 indicator count (fixed)
    '2' + // 11 subfield code count (fixed)
    '00000' + // 12-16 base address of data -- computed at final encoding time
    ' ' + // 17 encoding level
    (isAacr2 ? 'a' : ' ') + // 18 descriptive cataloging form, from ruleProfile.cataloguing_standard
    ' ' + // 19 multipart resource record level
    '4500'; // 20-23 entry map (always 4500 in a valid MARC21 leader)

  return { tag: 'LDR', indicators: [null, null], subfields: [{ code: null, value: leader }] };
}

function build008Entry(normalizedBiblioData) {
  const now = new Date();
  const dateEntered =
    String(now.getFullYear()).slice(-2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0'); // 00-05

  const extractedYear = extractYear(normalizedBiblioData.publish_date);
  const year = extractedYear ?? 'uuuu'; // 07-10
  const dateType = extractedYear ? 's' : 'n'; // 06: single known date vs. unknown

  const value =
    dateEntered +
    dateType +
    year +
    '    ' + // 11-14 date2 (blank -- not a serial)
    '   ' + // 15-17 place-of-publication code -- unknown, see comment above
    '                 ' + // 18-34 (17 chars) material-specific codes -- not coded
    'eng' + // 35-37 language -- default assumption, not derived from any source field
    ' ' + // 38 modified record
    'd'; // 39 cataloging source: other

  return { tag: '008', indicators: [null, null], subfields: [{ code: null, value }] };
}

// --- 040: Cataloguing Source (configuration-driven) ---
// Only emit subfields that have non-empty configured values. Never hardcode
// a particular institution's agency code.
function build040(_normalizedBiblioData, ruleProfile) {
  const cfg = ruleProfile?.cataloguing_source ?? getCataloguingSourceConfig() ?? {};
  const subfields = [];
  if (cfg.original_agency) subfields.push({ code: 'a', value: String(cfg.original_agency).trim() });
  if (cfg.language) subfields.push({ code: 'b', value: String(cfg.language).trim() });
  if (cfg.transcribing_agency) subfields.push({ code: 'c', value: String(cfg.transcribing_agency).trim() });
  if (cfg.description_conventions) {
    subfields.push({ code: 'e', value: String(cfg.description_conventions).trim() });
  }
  if (subfields.length === 0) return null;
  return { tag: '040', indicators: [' ', ' '], subfields };
}

function assertEmittedTagsHaveRules(skeleton) {
  const issues = [];
  for (const field of skeleton) {
    const tag = normalizeMarcTag(field.tag);
    if (!hasMarcRule(tag)) {
      issues.push({ code: 'BUILDER_WITHOUT_RULE', tag, message: `Builder emitted ${field.tag} with no runtime rule` });
    }
  }
  return issues;
}

// buildSkeleton(normalizedBiblioData, ruleProfile) -> { skeleton,
// fields_needing_llm, fields_from_loc }
//
// normalizedBiblioData is the shape isbnLookup.js's mergeSources()/
// lookupIsbn() produce internally (title/authors/.../sources.z3950/
// sources.loc_marc). ruleProfile is backend/rules/rule_profile.json.
export function buildSkeleton(normalizedBiblioData, ruleProfile) {
  const locFields = getLocFields(normalizedBiblioData);
  const skeleton = [];
  const fieldsFromLoc = [];

  for (const tag of MECHANICAL_TAGS) {
    // Registry consultation: mechanical tags must be registered.
    if (!getMarcRule(tag)) {
      // Still attempt build, but consistency layer will flag BUILDER_WITHOUT_RULE.
    }
    const locEntries = locFields.filter((field) => field.tag === tag);
    if (locEntries.length > 0) {
      for (const entry of locEntries) {
        skeleton.push(toSkeletonEntry(entry));
      }
      fieldsFromLoc.push(tag);
      continue;
    }

    const built = MECHANICAL_BUILDERS[tag](normalizedBiblioData, ruleProfile);
    if (built) skeleton.push(built);
  }

  // Leader is stored as tag LDR in skeleton; registry canonical tag is 000.
  skeleton.push(buildLeaderEntry(normalizedBiblioData, ruleProfile));

  const locEightFields = locFields.filter((field) => field.tag === '008');
  if (locEightFields.length > 0) {
    skeleton.push(toSkeletonEntry(locEightFields[0]));
    fieldsFromLoc.push('008');
  } else {
    skeleton.push(build008Entry(normalizedBiblioData));
  }

  const loc040 = locFields.filter((field) => field.tag === '040');
  if (loc040.length > 0) {
    for (const entry of loc040) skeleton.push(toSkeletonEntry(entry));
    fieldsFromLoc.push('040');
  } else {
    const built040 = build040(normalizedBiblioData, ruleProfile);
    if (built040) skeleton.push(built040);
  }

  const fieldsNeedingLlm = [];
  for (const [familyTag, memberTags] of Object.entries(LLM_FAMILY_TAGS)) {
    const locEntries = locFields.filter((field) => memberTags.includes(field.tag));
    if (locEntries.length > 0) {
      for (const entry of locEntries) {
        skeleton.push(toSkeletonEntry(entry));
        if (!fieldsFromLoc.includes(entry.tag)) fieldsFromLoc.push(entry.tag);
      }
    } else {
      fieldsNeedingLlm.push(familyTag);
    }
  }

  const rule_consistency = assertEmittedTagsHaveRules(skeleton);

  return {
    skeleton,
    fields_needing_llm: fieldsNeedingLlm,
    fields_from_loc: fieldsFromLoc,
    rule_consistency,
  };
}
