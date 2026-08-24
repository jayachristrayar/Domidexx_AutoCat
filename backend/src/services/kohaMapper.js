// Koha mapper — registry-driven metadata layer.
// P1: mapping metadata for consistency checking (getMapperTags/canMapTag/
// mapFieldToKoha/mapRecordToKoha below).
// P4: buildKohaFillPlan() turns a validated MARC record into a structured,
// DOM-agnostic set of fill instructions. This module only produces data —
// it never touches a browser DOM. Turning a fill instruction into an actual
// DOM write, verify-before-write, and post-write read-back happens in the
// extension content script (extension/src/content-scripts/kohaFillEngine.js).

import {
  getAllMarcRules,
  getKohaMapping,
  getMarcRule,
  normalizeMarcTag,
} from './marcRuleRegistry.js';

/**
 * Tags the mapper currently claims structural knowledge of.
 * Control fields + variable fields with koha_mapping.kind VARIABLE_FIELD
 * and status SUPPORTED or PARTIAL (rule metadata ready). PLANNED tags are
 * listed as known policy targets but not "mapped" for runtime write.
 */
export function getMapperTags() {
  return getAllMarcRules()
    .filter((rule) => {
      if (!rule.koha_supported) return false;
      const kind = rule.koha_mapping?.kind;
      if (kind === 'CONTROL_FIELD') return true;
      if (kind === 'VARIABLE_FIELD' && (rule.status === 'SUPPORTED' || rule.status === 'PARTIAL')) {
        return true;
      }
      return false;
    })
    .map((rule) => rule.tag);
}

export function canMapTag(tag) {
  const rule = getMarcRule(tag);
  if (!rule?.koha_supported) return false;
  const kind = rule.koha_mapping?.kind;
  if (kind === 'NOT_MAPPED' || kind == null) return false;
  if (rule.status === 'PLANNED' || rule.status === 'OPTIONAL' || rule.status === 'LEGACY') {
    return false;
  }
  return kind === 'CONTROL_FIELD' || kind === 'VARIABLE_FIELD';
}

/**
 * Map a single AutoCat field to a Koha-oriented descriptor.
 * Returns null when the tag is not mappable yet.
 */
export function mapFieldToKoha(field) {
  const tag = normalizeMarcTag(field?.tag);
  const rule = getMarcRule(tag);
  const mapping = getKohaMapping(tag);
  if (!rule || !mapping || !canMapTag(tag)) {
    return null;
  }

  if (mapping.kind === 'CONTROL_FIELD') {
    const value =
      field.value ??
      (field.subfields ?? []).find((sf) => sf.code == null)?.value ??
      null;
    return {
      tag: rule.tag,
      kind: 'CONTROL_FIELD',
      value,
      koha_supported: true,
      status: rule.status,
      notes: mapping.notes ?? null,
    };
  }

  return {
    tag: rule.tag,
    kind: 'VARIABLE_FIELD',
    indicators: field.indicators ?? [' ', ' '],
    subfields: (field.subfields ?? []).filter((sf) => sf.code != null),
    primary_subfield: mapping.primary_subfield ?? null,
    koha_supported: true,
    status: rule.status,
    notes: mapping.notes ?? null,
  };
}

export function mapRecordToKoha(fields) {
  const mapped = [];
  const skipped = [];
  for (const field of fields ?? []) {
    const result = mapFieldToKoha(field);
    if (result) mapped.push(result);
    else skipped.push(normalizeMarcTag(field?.tag));
  }
  return { mapped, skipped, incomplete: true, scope: 'P1 mapper metadata only — DOM autofill is P4' };
}

// ---------------------------------------------------------------------
// P4: MARC record -> structured Koha fill plan
// ---------------------------------------------------------------------

function toFillSubfields(field) {
  return (field.subfields ?? [])
    .filter((sf) => sf.code != null)
    .map((sf) => ({ code: sf.code, value: sf.value }));
}

/**
 * Build the P4 "fill plan": a DOM-agnostic description of exactly what may
 * be written into the Koha MARC editor, derived only from fields that are
 * (a) already present in a validated MARC record, (b) mappable per the P1
 * registry (canMapTag), and (c) not flagged invalid by validateProductionMarc.
 *
 * This never invents a field. A tag absent from marcResult.fields, or
 * present but not koha_supported/mappable, or present but invalid, is
 * reported in `skipped` rather than written.
 *
 * @param {object} marcResult - the object returned by generateMarcRecord().
 * @param {object} [options]
 * @param {object} [options.ddcApproval] - the DDC decision under review
 *   (same shape passed into generateMarcRecord's ddc_approval).
 * @returns {{ fields: object[], skipped: object[], notes: object[], ddc_gate: object, generated_at: string }}
 */
// Control fields (000/005/008) render in Koha's advanced MARC editor
// through per-position plugin widgets (marc21_leader.pl, marc21_field_008.pl
// -- a grid of dropdowns/selects), not a single free-text value input. There
// is no verified, safe way for the generic DOM writer to populate that grid,
// so these must never be sent through the normal write path -- attempting it
// always ends in a spurious "value_input_not_found" failure. Skip them
// cleanly instead: Koha itself manages the leader/005 transaction stamp, and
// 008 is left for the cataloguer (or a future dedicated fixed-field handler)
// rather than fabricated or forced through the wrong writer.
const KOHA_FILL_UNSUPPORTED_CONTROL_FIELDS = new Set(['000', '005', '008']);

// 942 is a Koha-local, per-institution field (item type defaults etc.) that
// requires explicit, verified framework configuration before AutoCat can
// safely write it. It is excluded from automatic fill entirely -- even
// though the current builders never generate it -- so a future generation
// path can never accidentally push it into the Koha editor unconfigured.
const KOHA_LOCAL_FIELDS_EXCLUDED_FROM_AUTOFILL = new Set(['942']);

export function buildKohaFillPlan(marcResult, options = {}) {
  const ddcApproval = options.ddcApproval ?? {};
  const fields = [];
  const skipped = [];
  const notes = [];
  const ddcApproved = ddcApproval.approval_status === 'APPROVED' && Boolean(ddcApproval.approved_ddc);

  for (const field of marcResult?.fields ?? []) {
    const tag = normalizeMarcTag(field?.tag);
    if (!tag) continue;

    if (KOHA_FILL_UNSUPPORTED_CONTROL_FIELDS.has(tag)) {
      skipped.push({ tag, reason: 'control_field_not_automated' });
      continue;
    }

    if (KOHA_LOCAL_FIELDS_EXCLUDED_FROM_AUTOFILL.has(tag)) {
      skipped.push({ tag, reason: 'koha_local_field_excluded' });
      continue;
    }

    if (!canMapTag(tag)) {
      skipped.push({ tag, reason: 'not_koha_mapped' });
      continue;
    }

    const fieldValidation = marcResult?.validation?.fields?.[tag];
    if (fieldValidation && fieldValidation.valid === false) {
      skipped.push({ tag, reason: 'validation_error' });
      continue;
    }

    // Defense in depth: marcPipeline already omits 082 unless the DDC
    // decision is APPROVED, but the fill plan re-checks so this gate can
    // never be bypassed by a caller that hand-assembles a marcResult.
    if (tag === '082' && !ddcApproved) {
      skipped.push({ tag, reason: 'ddc_not_approved' });
      continue;
    }

    const rule = getMarcRule(tag);
    const mapping = getKohaMapping(tag);
    const kind = mapping?.kind === 'CONTROL_FIELD' ? 'CONTROL_FIELD' : 'VARIABLE_FIELD';
    const repeatable = Boolean(rule?.repeatable);

    if (kind === 'CONTROL_FIELD') {
      const value = field.subfields?.find((sf) => sf.code == null)?.value ?? field.value ?? null;
      if (value == null || value === '') {
        skipped.push({ tag, reason: 'empty_control_value' });
        continue;
      }
      fields.push({ tag, field_type: 'CONTROL_FIELD', indicators: null, subfields: [{ code: null, value }], repeatable });
      continue;
    }

    const subfields = toFillSubfields(field);
    if (subfields.length === 0) {
      skipped.push({ tag, reason: 'no_subfields' });
      continue;
    }
    if (tag === '040' && !subfields.some((sf) => sf.code === 'a')) {
      notes.push({ code: '040_not_configured', tag, message: '040$a (original cataloguing agency) is not configured for this institution; it will not be written.' });
    }
    const [ind1, ind2] = field.indicators ?? [' ', ' '];
    fields.push({
      tag,
      field_type: 'VARIABLE_FIELD',
      indicators: { ind1: ind1 ?? ' ', ind2: ind2 ?? ' ' },
      subfields,
      repeatable,
    });
  }

  return {
    fields,
    skipped,
    notes,
    ddc_gate: { approved: ddcApproved, approved_ddc: ddcApproval.approved_ddc ?? null },
    generated_at: new Date().toISOString(),
  };
}
