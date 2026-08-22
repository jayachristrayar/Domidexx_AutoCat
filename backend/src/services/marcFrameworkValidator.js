// P5/framework validation engine: validates a cataloguing-form MARC record
// against a framework's configuration (never against the General MARC21
// vocabulary directly -- General doesn't say what's required for anyone).
//
// NOTE on reuse: marcValidator.js (P1) validates structural shape against
// its own marc_runtime_rules.json registry, which only covers the ~29
// tags the P3 generation pipeline emits -- not the full General MARC21
// vocabulary this framework engine spans (505, 856's siblings, 6XX
// subject fields beyond 650, etc. aren't in it). Calling validateRecord()
// here would raise a false "NO_RULE" error for every framework field
// outside that pipeline subset, so this module does its own lightweight
// structural (leader/control-field shape) check instead of delegating to
// it -- delegating to a mechanism scoped to a different, narrower field
// set isn't "reuse", it's a wrong fit.

import { getFrameworkFieldTree } from './marcFrameworkService.js';

/**
 * Apply a framework's configured default values to a record's fields
 * in-place (returns a new array; does not mutate the input). A subfield
 * already present with any value (including empty string) is left alone --
 * defaults only fill in genuinely missing subfields, matching "the user
 * should not have to type it every time" rather than "the system
 * overrides what they typed."
 */
export function applyFrameworkDefaults(fields, frameworkFields) {
  const byTag = new Map(frameworkFields.map((f) => [f.tag, f]));
  const result = fields.map((f) => ({ ...f, subfields: [...(f.subfields ?? [])] }));

  for (const frameworkField of frameworkFields) {
    const defaultSubfields = frameworkField.subfields.filter((sf) => sf.default_value != null && sf.default_value !== '');
    if (frameworkField.default_value == null && defaultSubfields.length === 0) continue;

    let existing = result.find((f) => f.tag === frameworkField.tag);
    if (!existing) {
      if (frameworkField.field_type === 'CONTROL_FIELD') {
        if (frameworkField.default_value == null) continue;
        result.push({ tag: frameworkField.tag, indicators: null, subfields: [{ code: null, value: frameworkField.default_value }] });
        continue;
      }
      if (defaultSubfields.length === 0) continue;
      existing = { tag: frameworkField.tag, indicators: [' ', ' '], subfields: [] };
      result.push(existing);
    }
    for (const sf of defaultSubfields) {
      const has = existing.subfields.some((present) => present.code === sf.code);
      if (!has) existing.subfields.push({ code: sf.code, value: sf.default_value });
    }
  }

  return result;
}

function fieldValue(field) {
  return field.subfields?.find((sf) => sf.code == null)?.value ?? field.value ?? '';
}

/**
 * Validate `fields` (shape: [{ tag, indicators: [ind1, ind2] | null,
 * subfields: [{code, value}] }]) against the given framework code.
 *
 * Runs, in order: (1) required fields, (2) required subfields, (3)
 * indicator values, (4) allowed subfields, (5) framework restrictions
 * (tag must be enabled in the framework), (6) repeatability, (7) default
 * values were applied where configured, (8) MARC structural formatting
 * (delegated to marcValidator's validateRecord), (9) Koha-specific
 * requirements (any is_koha_field with required subfields, e.g. 942$c).
 *
 * Returns { valid, errors, warnings, fields_used } -- errors always carry
 * a `tag`/`subfield`/`code`/`message` so the UI can render exactly what's
 * wrong (see spec section 15 -- never just "Invalid MARC record").
 */
export async function validateAgainstFramework(fields, frameworkCode) {
  const tree = await getFrameworkFieldTree(frameworkCode, { onlyEnabled: true });
  if (!tree) {
    return { valid: false, errors: [{ code: 'UNKNOWN_FRAMEWORK', message: `Unknown framework: ${frameworkCode}` }], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  const frameworkByTag = new Map(tree.fields.map((f) => [f.tag, f]));
  const submittedByTag = new Map();
  for (const f of fields ?? []) {
    if (!submittedByTag.has(f.tag)) submittedByTag.set(f.tag, []);
    submittedByTag.get(f.tag).push(f);
  }

  // (5) framework restriction: every submitted tag must be enabled in the framework.
  for (const tag of submittedByTag.keys()) {
    if (!frameworkByTag.has(tag)) {
      errors.push({ code: 'FIELD_NOT_IN_FRAMEWORK', tag, message: `${tag} is not enabled in the ${tree.framework.name} framework.` });
    }
  }

  // (6) repeatability: a non-repeatable field must not appear more than once.
  for (const [tag, occurrences] of submittedByTag) {
    const frameworkField = frameworkByTag.get(tag);
    if (frameworkField && !frameworkField.repeatable && occurrences.length > 1) {
      errors.push({ code: 'FIELD_NOT_REPEATABLE', tag, message: `${tag} (${frameworkField.label}) is not repeatable but appears ${occurrences.length} times.` });
    }
  }

  for (const frameworkField of tree.fields) {
    const occurrences = submittedByTag.get(frameworkField.tag) ?? [];

    // (1) required field.
    if (frameworkField.required && occurrences.length === 0) {
      errors.push({ code: 'FIELD_REQUIRED', tag: frameworkField.tag, message: `${frameworkField.tag} ${frameworkField.label} is required.` });
      continue;
    }

    for (const occurrence of occurrences) {
      if (frameworkField.field_type === 'CONTROL_FIELD') {
        if (frameworkField.required && !fieldValue(occurrence)) {
          errors.push({ code: 'FIELD_REQUIRED', tag: frameworkField.tag, message: `${frameworkField.tag} ${frameworkField.label} is required.` });
        }
        continue;
      }

      // (3) indicators: if the framework defines allowed codes for a
      // position, a submitted indicator must be one of them.
      const [ind1, ind2] = occurrence.indicators ?? [' ', ' '];
      for (const [position, value] of [[1, ind1], [2, ind2]]) {
        const allowed = frameworkField.indicators.filter((i) => i.position === position).map((i) => i.code);
        if (allowed.length === 0) continue;
        const rangeAllowed = allowed.some((code) => /^\d-\d$/.test(code));
        const valueOk = allowed.includes(value ?? ' ') || (rangeAllowed && /^\d$/.test(value ?? ''));
        if (!valueOk) {
          warnings.push({ code: 'INDICATOR_NOT_RECOGNIZED', tag: frameworkField.tag, position, value, message: `${frameworkField.tag} indicator ${position} value "${value}" is not one of the documented codes.` });
        }
      }

      const submittedCodes = new Set((occurrence.subfields ?? []).map((sf) => sf.code));
      const allowedSubfields = new Map(frameworkField.subfields.map((sf) => [sf.code, sf]));

      // (4) allowed subfields: a submitted subfield code must be configured for this framework field.
      for (const code of submittedCodes) {
        if (!allowedSubfields.has(code)) {
          errors.push({ code: 'SUBFIELD_NOT_ALLOWED', tag: frameworkField.tag, subfield: code, message: `${frameworkField.tag}$${code} is not enabled in the ${tree.framework.name} framework.` });
        }
      }

      // (2) required subfields.
      for (const sf of frameworkField.subfields) {
        if (!sf.required) continue;
        const present = (occurrence.subfields ?? []).find((s) => s.code === sf.code);
        if (!present || present.value == null || present.value === '') {
          errors.push({ code: 'SUBFIELD_REQUIRED', tag: frameworkField.tag, subfield: sf.code, message: `${frameworkField.tag}$${sf.code} ${sf.label} is required.` });
        }
      }

      // (6) repeatability at subfield level.
      const counts = {};
      for (const sf of occurrence.subfields ?? []) counts[sf.code] = (counts[sf.code] ?? 0) + 1;
      for (const [code, count] of Object.entries(counts)) {
        const def = allowedSubfields.get(code);
        if (def && !def.repeatable && count > 1) {
          errors.push({ code: 'SUBFIELD_NOT_REPEATABLE', tag: frameworkField.tag, subfield: code, message: `${frameworkField.tag}$${code} is not repeatable but appears ${count} times in one occurrence.` });
        }
      }
    }
  }

  // (9) Koha-specific requirement surfacing -- not a different rule engine,
  // just labeled distinctly so the UI can show "this is local/Koha
  // configuration, not standard MARC21" per spec section 8.
  const kohaErrors = errors.filter((e) => frameworkByTag.get(e.tag)?.is_koha_field);
  for (const e of kohaErrors) e.koha_specific = true;

  // (8) MARC structural formatting -- leader/control-field shape only;
  // subfield/indicator content was already checked above against the
  // framework's own configuration.
  for (const [tag, occurrences] of submittedByTag) {
    const frameworkField = frameworkByTag.get(tag);
    if (frameworkField?.field_type !== 'CONTROL_FIELD') continue;
    for (const occurrence of occurrences) {
      const hasSubfieldCodes = (occurrence.subfields ?? []).some((sf) => sf.code != null);
      if (hasSubfieldCodes || Array.isArray(occurrence.indicators)) {
        errors.push({ code: 'CONTROL_FIELD_SHAPE', tag, message: `${tag} is a control field and must not use indicators/subfield codes.` });
      }
    }
  }
  const leader = submittedByTag.get('000')?.[0];
  if (leader) {
    const value = fieldValue(leader);
    if (value && value.length !== 24) {
      errors.push({ code: 'LEADER_LENGTH', tag: '000', message: `Leader (000) must be 24 characters, got ${value.length}.` });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    framework: { code: tree.framework.code, name: tree.framework.name },
  };
}
