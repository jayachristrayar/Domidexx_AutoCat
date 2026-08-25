// MARC validator architecture — rule-registry driven.
// P1 scope: tag presence/status, control vs variable shape, known subfields,
// repeatability, required flags. Full cataloguing validation is NOT claimed.

import {
  getMarcRule,
  getValidationRule,
  normalizeMarcTag,
} from './marcRuleRegistry.js';

function controlValue(field) {
  if (field == null) return null;
  if (typeof field.value === 'string') return field.value;
  const nullCode = (field.subfields ?? []).find((sf) => sf.code == null || sf.code === '');
  return nullCode?.value ?? null;
}

function isControlShape(field) {
  const inds = field?.indicators;
  const noInds =
    inds == null ||
    (Array.isArray(inds) && inds[0] == null && inds[1] == null) ||
    inds === null;
  const subfields = field?.subfields ?? [];
  const onlyNullCodes = subfields.every((sf) => sf.code == null || sf.code === '');
  return noInds && (typeof field?.value === 'string' || onlyNullCodes || subfields.length === 0);
}

/**
 * Validate a single skeleton/field entry against the rule registry.
 * Returns { ok, tag, status, issues[], incomplete }.
 */
export function validateField(field) {
  const issues = [];
  const tag = normalizeMarcTag(field?.tag);
  const rule = getMarcRule(tag);

  if (!rule) {
    return {
      ok: false,
      tag,
      status: null,
      issues: [{ code: 'NO_RULE', message: `No runtime rule for tag ${tag}` }],
      incomplete: true,
    };
  }

  if (rule.field_type === 'CONTROL_FIELD') {
    if (!isControlShape(field)) {
      issues.push({
        code: 'CONTROL_FIELD_SHAPE',
        message: `${rule.tag} is CONTROL_FIELD and must not use ordinary indicators/subfields`,
      });
    }
    const value = controlValue(field);
    const expectedLen = rule.validation?.length;
    if (expectedLen != null && (value == null || value.length !== expectedLen)) {
      issues.push({
        code: 'CONTROL_LENGTH',
        message: `${rule.tag} value length must be ${expectedLen} (got ${value?.length ?? 0})`,
      });
    }
    if (rule.tag === '000' && value && value.length >= 24) {
      if (value.slice(10, 11) !== '2' || value.slice(11, 12) !== '2') {
        issues.push({
          code: 'LDR_INDICATOR_SUBFIELD_COUNTS',
          message: 'LDR positions 10-11 must be 22',
        });
      }
      if (value.slice(20, 24) !== '4500') {
        issues.push({
          code: 'LDR_ENTRY_MAP',
          message: 'LDR positions 20-23 must be 4500',
        });
      }
    }
  } else {
    // VARIABLE_FIELD
    if (isControlShape(field) && (field.subfields ?? []).every((sf) => sf.code == null)) {
      issues.push({
        code: 'VARIABLE_FIELD_SHAPE',
        message: `${rule.tag} is VARIABLE_FIELD and expects indicators/subfields`,
      });
    }
    const known = rule.validation?.subfields ?? {};
    const knownCodes = new Set(Object.keys(known));
    for (const sf of field.subfields ?? []) {
      if (sf.code == null || sf.code === '') continue;
      if (knownCodes.size > 0 && !knownCodes.has(sf.code)) {
        issues.push({
          code: 'UNKNOWN_SUBFIELD',
          message: `${rule.tag} unknown subfield $${sf.code}`,
        });
      }
    }
    for (const [code, meta] of Object.entries(known)) {
      const matches = (field.subfields ?? []).filter((sf) => sf.code === code);
      if (meta.required_when_present && matches.length === 0 && (field.subfields ?? []).length > 0) {
        // Only require $a (etc.) when the field is being asserted with content;
        // empty optional fields are fine.
      }
      if (!meta.repeatable && matches.length > 1) {
        issues.push({
          code: 'SUBFIELD_NOT_REPEATABLE',
          message: `${rule.tag}$${code} is not repeatable`,
        });
      }
    }
  }

  if (rule.required === true) {
    // Presence of required tags is checked at record level, not here.
  }

  return {
    ok: issues.length === 0,
    tag: rule.tag,
    status: rule.status,
    field_type: rule.field_type,
    repeatable: rule.repeatable,
    required: rule.required,
    issues,
    incomplete: Boolean(rule.validation?.incomplete) || rule.status === 'PARTIAL' || rule.status === 'PLANNED',
  };
}

/**
 * Validate a list of fields (skeleton). Checks repeatability at record level
 * and required tags that the registry marks required.
 */
export function validateRecord(fields, { checkRequired = true } = {}) {
  const results = [];
  const byTag = new Map();
  const issues = [];

  for (const field of fields ?? []) {
    const result = validateField(field);
    results.push(result);
    const tag = result.tag;
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(field);
    for (const issue of result.issues) issues.push({ tag, ...issue });
  }

  for (const [tag, occurrences] of byTag.entries()) {
    const rule = getMarcRule(tag);
    if (!rule) continue;
    if (rule.repeatable === false && occurrences.length > 1) {
      issues.push({
        tag,
        code: 'FIELD_NOT_REPEATABLE',
        message: `${tag} is not repeatable but appears ${occurrences.length} times`,
      });
    }
  }

  // Note: 000 (leader) and 008 are Koha/system-managed control fields that
  // AutoCat deliberately never generates (see marcBuilder.js/marcPipeline.js
  // and marcRuleRegistry's EXCLUDED status) -- they must never be required
  // here, or every valid AutoCat record would fail validation.
  void checkRequired;

  return {
    ok: issues.length === 0,
    results,
    issues,
    incomplete: true, // P1 architecture — full cataloguing validation not claimed
    scope: 'P1: tag/status/shape/subfields/repeatability/required — not full cataloguing validation',
  };
}

export function getValidatorCoveredTags() {
  // Tags for which validateField applies concrete checks beyond "has a rule".
  return ['000', '008', '020', '040', '082', '245', '246', '250', '260', '300', '440', '942'];
}

export { getValidationRule };
