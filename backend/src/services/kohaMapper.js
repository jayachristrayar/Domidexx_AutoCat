// Koha mapper — registry-driven metadata layer for P1.
// Does NOT implement DOM autofill (P4). Declares which tags the mapper
// understands for consistency checking and future autofill wiring.

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
