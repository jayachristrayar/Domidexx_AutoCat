import { buildSkeleton } from './marcBuilder.js';
import { validateRecord } from './marcValidator.js';
import { getRuleProfile, hasMarcRule, normalizeMarcTag } from './marcRuleRegistry.js';
import { findBundledClass, buildPath } from './ddcKnowledgeBase.js';
import { buildKohaFillPlan } from './kohaMapper.js';

const SOURCE_DERIVED = 'SOURCE_DERIVED';
const RULE_DERIVED = 'RULE_DERIVED';
const CATALOGUER_APPROVED = 'CATALOGUER_APPROVED';

// Tags this module mechanically constructs in buildAdditionalFields, beyond
// the skeleton marcBuilder.js emits. Declared here so marcConsistency.js can
// count them as builder-covered instead of flagging SUPPORTED_BUT_BUILDER_MISSING.
export function getPipelineEmittedTags() {
  return ['005'];
}

export function normalizeIsbn(value) {
  const raw = String(value ?? '').replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[0-9X]$/.test(raw)) return isbn10To13(raw);
  return raw;
}

function isbn10To13(isbn10) {
  const prefixed = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(prefixed[i]) * (i % 2 === 0 ? 1 : 3);
  return `${prefixed}${(10 - (sum % 10)) % 10}`;
}

export function isValidIsbn(value) {
  const isbn = String(value ?? '').replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[0-9X]$/.test(isbn)) {
    const sum = isbn.split('').reduce((acc, ch, idx) => acc + (ch === 'X' ? 10 : Number(ch)) * (10 - idx), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = isbn.split('').reduce((acc, ch, idx) => acc + Number(ch) * (idx % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
}

function cleanText(value) { return String(value ?? '').trim(); }
function array(value) { return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []; }
function first(value) { return array(value)[0] ?? null; }

export function normalizeMarcMetadata(input = {}) {
  const metadata = input.metadata ?? input;
  const normalized = {
    isbn: normalizeIsbn(metadata.isbn),
    title: cleanText(metadata.title),
    subtitle: cleanText(metadata.subtitle),
    authors: array(metadata.authors ?? metadata.author).map(cleanText),
    editors: array(metadata.editors).map(cleanText),
    illustrators: array(metadata.illustrators).map(cleanText),
    translators: array(metadata.translators).map(cleanText),
    publisher: cleanText(metadata.publisher),
    publish_date: cleanText(metadata.publish_date ?? metadata.publication_date),
    edition: cleanText(metadata.edition),
    language: cleanText(metadata.language ?? metadata.language_code),
    subjects: array(metadata.subjects ?? metadata.subject_headings).map(cleanText),
    description: cleanText(metadata.description ?? metadata.abstract),
    notes: array(metadata.notes).map(cleanText),
    bibliography_note: cleanText(metadata.bibliography_note),
    awards: array(metadata.awards).map(cleanText),
    urls: array(metadata.urls ?? metadata.url).map(cleanText),
    physical_description: metadata.physical_description ?? {},
    sources: metadata.sources ?? {},
  };
  return normalized;
}

export function detectMetadataConflicts(sources = {}) {
  const conflicts = [];
  const comparable = ['title', 'publisher', 'publish_date', 'edition'];
  for (const field of comparable) {
    const values = Object.entries(sources)
      .map(([source, data]) => ({ source, value: cleanText(data?.[field]) }))
      .filter((entry) => entry.value);
    const unique = [...new Map(values.map((v) => [v.value.toLowerCase(), v])).values()];
    if (unique.length > 1) {
      conflicts.push({ field, status: 'CONFLICT', preferred: unique[0], alternatives: unique.slice(1), evidence: values });
    }
  }
  return conflicts;
}

function withProvenance(field, source, provenance) {
  return { ...field, source, provenance, validation_status: 'UNVALIDATED' };
}

function controlField(tag, value, source = 'system', provenance = RULE_DERIVED) {
  return withProvenance({ tag, indicators: [null, null], subfields: [{ code: null, value }] }, source, provenance);
}

function dataField(tag, subfields, indicators = [' ', ' '], source = 'metadata', provenance = SOURCE_DERIVED) {
  return withProvenance({ tag, indicators, subfields }, source, provenance);
}

function build005(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}.0`;
}

function languageCode(language) {
  const value = cleanText(language).toLowerCase();
  if (!value) return null;
  if (/^[a-z]{3}$/.test(value)) return value;
  const map = { english: 'eng', malayalam: 'mal', hindi: 'hin', tamil: 'tam', sanskrit: 'san' };
  return map[value] ?? null;
}

function buildAdditionalFields(metadata, now) {
  const fields = [];
  if (hasMarcRule('005')) fields.push(controlField('005', build005(now)));
  const lang = languageCode(metadata.language);
  if (lang && hasMarcRule('041')) fields.push(dataField('041', [{ code: 'a', value: lang }]));
  if (metadata.description && hasMarcRule('520')) fields.push(dataField('520', [{ code: 'a', value: metadata.description }], [' ', ' ']));
  for (const note of metadata.notes) if (hasMarcRule('500')) fields.push(dataField('500', [{ code: 'a', value: note }]));
  if (metadata.bibliography_note && hasMarcRule('504')) fields.push(dataField('504', [{ code: 'a', value: metadata.bibliography_note }]));
  for (const award of metadata.awards) if (hasMarcRule('586')) fields.push(dataField('586', [{ code: 'a', value: award }]));
  for (const subject of metadata.subjects) if (hasMarcRule('650')) fields.push(dataField('650', [{ code: 'a', value: subject }], [' ', '0']));
  for (const url of metadata.urls) if (/^https?:\/\//i.test(url) && hasMarcRule('856')) fields.push(dataField('856', [{ code: 'u', value: url }], ['4', '0']));
  const author = first(metadata.authors);
  if (author && hasMarcRule('100')) fields.push(dataField('100', [{ code: 'a', value: author.endsWith('.') ? author : `${author}.` }], ['1', ' ']));
  return fields;
}

function ddcFailure(code, message) { return { ok: false, errors: [{ level: 'DDC_APPROVAL', code, tag: '082', message }], field: null }; }

export function buildApproved082(ddcApproval = {}, ruleProfile = getRuleProfile()) {
  if (!ddcApproval || ddcApproval.approval_status !== 'APPROVED') return ddcFailure('DDC_NOT_APPROVED', 'Final 082$a requires cataloguer-approved DDC.');
  const approved = cleanText(ddcApproval.approved_ddc);
  if (!approved) return ddcFailure('APPROVED_DDC_MISSING', 'Approved DDC number is missing.');
  const ddcClass = findBundledClass(approved);
  if (!ddcClass) return ddcFailure('DDC_NOT_FOUND', `Approved DDC ${approved} is not in the DDC knowledge base.`);
  if (ddcClass.status !== 'ASSIGNED') return ddcFailure('DDC_NOT_ASSIGNED', `Approved DDC ${approved} has status ${ddcClass.status}.`);
  const path = buildPath(approved);
  if (path.length === 0 || path[0] !== ddcClass.main_class) return ddcFailure('DDC_HIERARCHY_UNRESOLVED', `Approved DDC ${approved} hierarchy could not be resolved.`);
  const edition = ruleProfile?.ddc_edition_default || '23';
  return { ok: true, errors: [], field: dataField('082', [{ code: 'a', value: approved }, { code: '2', value: String(edition).replace(/\D/g, '') || '23' }], ['0', '4'], 'ddc_decision', CATALOGUER_APPROVED), ddc_class: ddcClass };
}

function toStructuredRecord(fields) {
  const leader = fields.find((f) => normalizeMarcTag(f.tag) === '000');
  return {
    leader: leader?.subfields?.[0]?.value ?? null,
    controlFields: fields.filter((f) => ['005', '008'].includes(normalizeMarcTag(f.tag))).map((f) => ({ tag: normalizeMarcTag(f.tag), value: f.subfields?.[0]?.value ?? f.value ?? '', source: f.source, provenance: f.provenance })),
    dataFields: fields.filter((f) => !['000', '005', '008'].includes(normalizeMarcTag(f.tag))).map((f) => ({ tag: normalizeMarcTag(f.tag), ind1: f.indicators?.[0] ?? ' ', ind2: f.indicators?.[1] ?? ' ', subfields: f.subfields ?? [], source: f.source, provenance: f.provenance })),
  };
}

function marcPreview(fields, validation) {
  return fields.map((field) => {
    const tag = normalizeMarcTag(field.tag);
    const status = validation.fields?.[tag]?.valid === false ? 'ERROR' : validation.fields?.[tag]?.warnings?.length ? 'WARNING' : 'OK';
    const indicators = field.indicators?.[0] == null ? '' : `${field.indicators[0]}${field.indicators[1]}`;
    const body = (field.subfields ?? []).map((sf) => (sf.code ? `$${sf.code} ${sf.value}` : sf.value)).join(' ');
    return { tag, indicators, value: body, source: field.source ?? 'unknown', provenance: field.provenance ?? 'UNKNOWN', validation_status: status };
  });
}

export function generateMarcRecord(input = {}, options = {}) {
  const ruleProfile = options.ruleProfile ?? getRuleProfile();
  const metadata = normalizeMarcMetadata(input.metadata ?? input);
  const conflicts = detectMetadataConflicts(input.sources ?? metadata.sources);
  let skeleton = buildSkeleton(metadata, ruleProfile).skeleton.map((f) => withProvenance(f, metadata.sources?.method === 'web_search' ? 'metadata_unverified' : 'metadata', f.tag === 'LDR' || f.tag === '008' || f.tag === '040' ? RULE_DERIVED : SOURCE_DERIVED));
  const lang = languageCode(metadata.language);
  if (lang) {
    skeleton = skeleton.map((field) => {
      if (normalizeMarcTag(field.tag) !== '008') return field;
      const value = field.subfields?.[0]?.value ?? '';
      if (value.length !== 40) return field;
      return { ...field, subfields: [{ code: null, value: `${value.slice(0, 35)}${lang}${value.slice(38)}` }] };
    });
  }
  const fields = [...skeleton, ...buildAdditionalFields(metadata, options.now ?? new Date())];
  const ddc = buildApproved082(input.ddc_approval ?? input.ddcDecision ?? {}, ruleProfile);
  const ddcErrors = ddc.errors;
  if (ddc.ok) fields.push(ddc.field);
  const ddcApproval = input.ddc_approval ?? input.ddcDecision ?? {};
  const validation = validateProductionMarc(fields, { metadata, ddcApproval, ddcErrors });
  const marcRecord = toStructuredRecord(fields);
  const result = { metadata, marc_record: marcRecord, fields, validation, preview: marcPreview(fields, validation), provenance: fields.map((f) => ({ tag: normalizeMarcTag(f.tag), source: f.source, provenance: f.provenance })), conflicts, status: validation.valid ? 'READY_FOR_KOHA' : 'REQUIRES_CATALOGUER_REVIEW' };
  // P4: only offer a Koha fill plan once the record validates. An invalid
  // record must not produce fill instructions.
  result.koha_fill = validation.valid ? buildKohaFillPlan(result, { ddcApproval }) : null;
  return result;
}

export function validateProductionMarc(fields, { metadata = {}, ddcApproval = {}, ddcErrors = [] } = {}) {
  const base = validateRecord(fields);
  const errors = base.issues.map((issue) => ({ level: 'STRUCTURAL', ...issue }));
  const warnings = [];
  const info = [];
  const byTag = Object.groupBy(fields, (f) => normalizeMarcTag(f.tag));
  if (metadata.isbn && !isValidIsbn(metadata.isbn)) errors.push({ level: 'CATALOGUING_PROFILE', tag: '020', code: 'INVALID_ISBN', message: '020$a must contain a valid ISBN-10 or ISBN-13.' });
  const marc020 = byTag['020']?.flatMap((f) => f.subfields ?? []).find((sf) => sf.code === 'a')?.value;
  if (marc020 && !isValidIsbn(marc020)) errors.push({ level: 'CATALOGUING_PROFILE', tag: '020', code: 'INVALID_020_ISBN', message: 'MARC 020$a is ISBN only and must validate as ISBN.' });
  if (ddcErrors.length) errors.push(...ddcErrors);
  const has082 = Boolean(byTag['082']?.some((f) => (f.subfields ?? []).some((sf) => sf.code === 'a')));
  if (has082 && ddcApproval.approval_status !== 'APPROVED') errors.push({ level: 'DDC_APPROVAL', tag: '082', code: '082_WITHOUT_APPROVAL', message: '082$a cannot be present without APPROVED DDC.' });
  if (metadata.language) {
    const lang = languageCode(metadata.language);
    if (!lang) warnings.push({ level: 'EVIDENCE', tag: '041', code: 'LANGUAGE_NOT_CODED', message: 'Language evidence was supplied but could not be mapped to a MARC code.' });
  }
  for (const tag of ['246', '440']) if (!byTag[tag] && hasMarcRule(tag)) info.push({ level: 'CATALOGUING_PROFILE', tag, code: 'NOT_AUTOMATED', message: `${tag} remains controlled by runtime status and is not fabricated by P3.` });
  const fieldsResult = {};
  for (const f of fields) {
    const tag = normalizeMarcTag(f.tag);
    fieldsResult[tag] = { valid: !errors.some((e) => e.tag === tag), warnings: warnings.filter((w) => w.tag === tag) };
  }
  return { valid: errors.length === 0, errors, warnings, info, fields: fieldsResult, base_scope: base.scope, levels: ['STRUCTURAL', 'CATALOGUING_PROFILE', 'EVIDENCE', 'DDC_APPROVAL'] };
}
