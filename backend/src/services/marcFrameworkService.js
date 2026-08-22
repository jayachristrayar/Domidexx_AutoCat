// MARC21 framework engine service.
//
// Two layers, kept structurally separate (see schema.sql):
//   - marc_fields / marc_subfields / marc_indicators: the master General
//     MARC21 vocabulary. Seeded once from rules/marc21_general.js. Never
//     mutated by a custom framework's configuration.
//   - marc_frameworks + framework_field_settings + framework_subfield_settings:
//     one settings row per (framework, field) and (framework field, subfield)
//     saying whether it's enabled/required/default-valued/ordered *for that
//     framework*. The GENERAL framework gets its own settings rows too
//     (all enabled, not required) so "what does framework X show" is
//     always the same settings-table query, never a GENERAL special case.
//
// This module owns all reads and admin mutations. It never renders HTML
// (that's admin.js) and never touches a browser DOM (that's the
// extension). AI-pipeline callers should use filterFieldsToFramework().

import pool from '../db/index.js';
import { GENERAL_MARC21_FIELDS } from '../../rules/marc21_general.js';
import { CUSTOM_LIBRARY_FRAMEWORK, CUSTOM_FIELD_CONFIG } from '../../rules/marc_custom_framework.js';

const GENERAL_FRAMEWORK_CODE = 'GENERAL';

async function getClient(client) {
  return client ?? pool;
}

// ---------------------------------------------------------------------
// Seeding -- idempotent, ON CONFLICT upserts, safe to re-run on boot.
// ---------------------------------------------------------------------

async function upsertFramework(client, { code, name, description, framework_type }) {
  const { rows } = await client.query(
    `INSERT INTO marc_frameworks (code, name, description, framework_type, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()
     RETURNING id`,
    [code, name, description, framework_type]
  );
  return rows[0].id;
}

async function upsertMasterField(client, def, displayOrder) {
  const { rows } = await client.query(
    `INSERT INTO marc_fields (tag, label, description, section, repeatable, field_type, authority_control, is_koha_field, minimal_definition, display_order, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (tag) DO UPDATE SET
       label = EXCLUDED.label, description = EXCLUDED.description, section = EXCLUDED.section,
       repeatable = EXCLUDED.repeatable, field_type = EXCLUDED.field_type,
       authority_control = EXCLUDED.authority_control, is_koha_field = EXCLUDED.is_koha_field,
       minimal_definition = EXCLUDED.minimal_definition, display_order = EXCLUDED.display_order, updated_at = now()
     RETURNING id`,
    [def.tag, def.label, def.description, def.section, def.repeatable, def.field_type, def.authority_control, def.is_koha_field, def.minimal_definition, displayOrder]
  );
  const fieldId = rows[0].id;

  for (const [idx, i] of (def.indicators ?? []).entries()) {
    await client.query(
      `INSERT INTO marc_indicators (field_id, position, code, label, description)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (field_id, position, code) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description`,
      [fieldId, i.position, i.code, i.label, i.description]
    );
  }

  const subfieldIds = {};
  for (const [idx, sf] of (def.subfields ?? []).entries()) {
    const code = sf.code ?? '_CONTROL_'; // control-field "no subfield code" sentinel; unique per field
    const { rows: sfRows } = await client.query(
      `INSERT INTO marc_subfields (field_id, code, label, description, repeatable, required, default_value, display_order, authority_control)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (field_id, code) DO UPDATE SET
         label = EXCLUDED.label, description = EXCLUDED.description, repeatable = EXCLUDED.repeatable,
         required = EXCLUDED.required, default_value = EXCLUDED.default_value, display_order = EXCLUDED.display_order,
         authority_control = EXCLUDED.authority_control
       RETURNING id`,
      [fieldId, code, sf.label, sf.description, sf.repeatable, sf.required, sf.default_value ?? null, idx, sf.authority_control ?? false]
    );
    subfieldIds[sf.code ?? null] = sfRows[0].id;
  }

  return { fieldId, subfieldIds };
}

async function upsertFrameworkFieldSetting(client, { frameworkId, fieldId, enabled, required, defaultValue, section, displayOrder }) {
  const { rows } = await client.query(
    `INSERT INTO framework_field_settings (framework_id, field_id, enabled, required, default_value, section, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (framework_id, field_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, required = EXCLUDED.required, default_value = EXCLUDED.default_value,
       section = EXCLUDED.section, display_order = EXCLUDED.display_order
     RETURNING id`,
    [frameworkId, fieldId, enabled, required, defaultValue ?? null, section, displayOrder]
  );
  return rows[0].id;
}

async function upsertFrameworkSubfieldSetting(client, { fieldSettingId, subfieldId, enabled, required, defaultValue, displayOrder }) {
  await client.query(
    `INSERT INTO framework_subfield_settings (framework_field_setting_id, subfield_id, enabled, required, default_value, display_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (framework_field_setting_id, subfield_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, required = EXCLUDED.required, default_value = EXCLUDED.default_value, display_order = EXCLUDED.display_order`,
    [fieldSettingId, subfieldId, enabled, required, defaultValue ?? null, displayOrder]
  );
}

/**
 * Seed the master General MARC21 vocabulary, the GENERAL framework
 * (mirroring every master field, all enabled, none required), and the
 * CUSTOM "My Library" framework (only the configured tags/subfields from
 * rules/marc_custom_framework.js, enabled, with the given required/default
 * overrides). Idempotent -- safe to re-run on every boot or via
 * `npm run seed:marc-frameworks`.
 */
export async function seedMarcFrameworks(client = null) {
  const c = await getClient(client);

  const masterByTag = {};
  for (const [idx, def] of GENERAL_MARC21_FIELDS.entries()) {
    masterByTag[def.tag] = await upsertMasterField(c, def, idx);
  }

  // --- GENERAL framework: mirrors every master field/subfield, enabled,
  // not required (see module docstring -- General must not dictate use).
  const generalFrameworkId = await upsertFramework(c, {
    code: GENERAL_FRAMEWORK_CODE,
    name: 'General MARC21',
    description: 'The complete MARC21 bibliographic vocabulary this application knows about. Reusable reference layer -- does not determine what any specific library catalogues with.',
    framework_type: 'GENERAL',
  });
  for (const [idx, def] of GENERAL_MARC21_FIELDS.entries()) {
    const { fieldId, subfieldIds } = masterByTag[def.tag];
    const fieldSettingId = await upsertFrameworkFieldSetting(c, {
      frameworkId: generalFrameworkId, fieldId, enabled: true, required: false, defaultValue: null, section: def.section, displayOrder: idx,
    });
    for (const [sfIdx, sf] of (def.subfields ?? []).entries()) {
      await upsertFrameworkSubfieldSetting(c, {
        fieldSettingId, subfieldId: subfieldIds[sf.code ?? null], enabled: true, required: false, defaultValue: null, displayOrder: sfIdx,
      });
    }
  }

  // --- CUSTOM "My Library" framework: only the configured tags.
  const customFrameworkId = await upsertFramework(c, {
    code: CUSTOM_LIBRARY_FRAMEWORK.code,
    name: CUSTOM_LIBRARY_FRAMEWORK.name,
    description: CUSTOM_LIBRARY_FRAMEWORK.description,
    framework_type: 'CUSTOM',
  });

  let order = 0;
  for (const [tag, cfg] of Object.entries(CUSTOM_FIELD_CONFIG)) {
    const master = masterByTag[tag];
    if (!master) {
      throw new Error(`Custom framework references tag ${tag}, which is missing from the General MARC21 vocabulary -- add it there first.`);
    }
    const { fieldId, subfieldIds } = master;
    const fieldSettingId = await upsertFrameworkFieldSetting(c, {
      frameworkId: customFrameworkId, fieldId, enabled: true, required: Boolean(cfg.fieldRequired), defaultValue: null, section: cfg.section, displayOrder: order++,
    });

    if (cfg.subfieldsSource === 'explicit') {
      for (const [sfIdx, sf] of cfg.subfields.entries()) {
        const subfieldId = subfieldIds[sf.code];
        if (!subfieldId) {
          throw new Error(`Custom framework field ${tag}$${sf.code} has no matching General MARC21 subfield -- add it to rules/marc21_general.js first.`);
        }
        await upsertFrameworkSubfieldSetting(c, {
          fieldSettingId, subfieldId, enabled: true, required: Boolean(sf.required), defaultValue: sf.default ?? null, displayOrder: sfIdx,
        });
      }
    } else {
      // 'general' (control fields) / 'general_fallback' (no explicit
      // subfield list given in the request text): carry every General
      // subfield through as enabled, none required, no defaults.
      for (const [sfIdx, sf] of (GENERAL_MARC21_FIELDS.find((f) => f.tag === tag).subfields ?? []).entries()) {
        await upsertFrameworkSubfieldSetting(c, {
          fieldSettingId, subfieldId: subfieldIds[sf.code ?? null], enabled: true, required: false, defaultValue: null, displayOrder: sfIdx,
        });
      }
    }
  }

  return { generalFields: GENERAL_MARC21_FIELDS.length, customFields: Object.keys(CUSTOM_FIELD_CONFIG).length };
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export async function listFrameworks() {
  const { rows } = await pool.query(
    `SELECT id, code, name, description, framework_type, active, created_at, updated_at FROM marc_frameworks ORDER BY framework_type DESC, name`
  );
  return rows;
}

export async function getFrameworkByCode(code) {
  const { rows } = await pool.query(`SELECT * FROM marc_frameworks WHERE code = $1`, [code]);
  return rows[0] ?? null;
}

/**
 * Compose the full field tree for a framework: every field it has a
 * settings row for (regardless of enabled -- callers filter), each with
 * its subfields and indicators, sourced from the master vocabulary but
 * carrying this framework's own enabled/required/default_value/section.
 */
export async function getFrameworkFieldTree(code, { onlyEnabled = true } = {}) {
  const framework = await getFrameworkByCode(code);
  if (!framework) return null;

  const { rows: fieldRows } = await pool.query(
    `SELECT ffs.id AS setting_id, ffs.enabled AS field_enabled, ffs.required AS field_required,
            ffs.default_value AS field_default_value, ffs.section AS framework_section, ffs.display_order,
            mf.id AS field_id, mf.tag, mf.label, mf.description, mf.section AS marc_section,
            mf.repeatable, mf.field_type, mf.authority_control, mf.is_koha_field, mf.minimal_definition
     FROM framework_field_settings ffs
     JOIN marc_fields mf ON mf.id = ffs.field_id
     WHERE ffs.framework_id = $1 ${onlyEnabled ? 'AND ffs.enabled = true' : ''}
     ORDER BY ffs.display_order, mf.tag`,
    [framework.id]
  );

  if (fieldRows.length === 0) return { framework, fields: [] };

  const fieldIds = fieldRows.map((f) => f.field_id);
  const settingIds = fieldRows.map((f) => f.setting_id);

  const { rows: indicatorRows } = await pool.query(
    `SELECT field_id, position, code, label, description FROM marc_indicators WHERE field_id = ANY($1::int[]) ORDER BY field_id, position, code`,
    [fieldIds]
  );
  const { rows: subfieldRows } = await pool.query(
    `SELECT fss.framework_field_setting_id AS field_setting_id, fss.enabled, fss.required AS setting_required, fss.default_value AS setting_default_value, fss.display_order,
            ms.id AS subfield_id, ms.code, ms.label, ms.description, ms.repeatable, ms.required AS master_required,
            ms.default_value AS master_default_value, ms.hidden, ms.authority_control
     FROM framework_subfield_settings fss
     JOIN marc_subfields ms ON ms.id = fss.subfield_id
     WHERE fss.framework_field_setting_id = ANY($1::int[]) ${onlyEnabled ? 'AND fss.enabled = true' : ''}
     ORDER BY fss.framework_field_setting_id, fss.display_order`,
    [settingIds]
  );

  const indicatorsByField = {};
  for (const row of indicatorRows) (indicatorsByField[row.field_id] ??= []).push(row);
  const subfieldsBySetting = {};
  for (const row of subfieldRows) (subfieldsBySetting[row.field_setting_id] ??= []).push(row);

  const fields = fieldRows.map((f) => ({
    tag: f.tag,
    label: f.label,
    description: f.description,
    marc_section: f.marc_section,
    section: f.framework_section ?? f.marc_section,
    repeatable: f.repeatable,
    field_type: f.field_type,
    authority_control: f.authority_control,
    is_koha_field: f.is_koha_field,
    minimal_definition: f.minimal_definition,
    required: f.field_required,
    default_value: f.field_default_value,
    display_order: f.display_order,
    indicators: (indicatorsByField[f.field_id] ?? []).map((i) => ({ position: i.position, code: i.code, label: i.label, description: i.description })),
    subfields: (subfieldsBySetting[f.setting_id] ?? [])
      .filter((sf) => !sf.hidden)
      .map((sf) => ({
        code: sf.code === '_CONTROL_' ? null : sf.code,
        label: sf.label,
        description: sf.description,
        repeatable: sf.repeatable,
        required: sf.setting_required,
        default_value: sf.setting_default_value ?? sf.master_default_value ?? null,
        authority_control: sf.authority_control,
      })),
  }));

  return { framework, fields };
}

export async function getFrameworkSections(code, options) {
  const tree = await getFrameworkFieldTree(code, options);
  if (!tree) return null;
  const sections = {};
  for (const field of tree.fields) {
    (sections[field.section ?? 'UNSPECIFIED'] ??= []).push(field);
  }
  return { framework: tree.framework, sections };
}

// ---------------------------------------------------------------------
// AI-pipeline contract (see spec sections 16-17): the framework is the
// single source of truth for what fields/subfields the AI may output. A
// caller building fields for the AI to consider should always go through
// filterFieldsToFramework() rather than checking marc21_general.js
// directly -- that would bypass the framework layer entirely.
// ---------------------------------------------------------------------

/**
 * Reduce a set of MARC fields (shape: [{ tag, subfields: [{code,value}], ... }])
 * to only the tags/subfields enabled in the given framework. Returns both
 * the allowed subset and what was dropped, so a caller (AI pipeline, API
 * response) can report why something was excluded instead of silently
 * vanishing it.
 */
export async function filterFieldsToFramework(fields, frameworkCode) {
  const tree = await getFrameworkFieldTree(frameworkCode, { onlyEnabled: true });
  if (!tree) throw new Error(`Unknown framework: ${frameworkCode}`);

  const fieldByTag = new Map(tree.fields.map((f) => [f.tag, f]));
  const allowed = [];
  const dropped = [];

  for (const field of fields ?? []) {
    const allowedField = fieldByTag.get(field.tag);
    if (!allowedField) {
      dropped.push({ tag: field.tag, reason: 'field_not_in_framework' });
      continue;
    }
    const allowedCodes = new Set(allowedField.subfields.map((sf) => sf.code));
    const keptSubfields = (field.subfields ?? []).filter((sf) => allowedCodes.has(sf.code ?? null));
    const droppedSubfields = (field.subfields ?? []).filter((sf) => !allowedCodes.has(sf.code ?? null));
    if (droppedSubfields.length) {
      dropped.push({ tag: field.tag, reason: 'subfield_not_in_framework', subfields: droppedSubfields.map((sf) => sf.code) });
    }
    if (keptSubfields.length === 0) continue;
    allowed.push({ ...field, subfields: keptSubfields });
  }

  return { framework: { code: tree.framework.code, name: tree.framework.name }, allowed, dropped };
}

/**
 * The framework constraint bundle an AI/cataloguing engine should receive
 * alongside its metadata input, per spec section 17: enabled fields,
 * enabled subfields, required fields/subfields, and default values --
 * nothing else. The AI is expected to only ever propose tags/subfields
 * present in `fields` below.
 */
export async function getFrameworkConstraints(frameworkCode) {
  const tree = await getFrameworkFieldTree(frameworkCode, { onlyEnabled: true });
  if (!tree) throw new Error(`Unknown framework: ${frameworkCode}`);
  return {
    framework: { code: tree.framework.code, name: tree.framework.name, type: tree.framework.framework_type },
    fields: tree.fields.map((f) => ({
      tag: f.tag,
      required: f.required,
      repeatable: f.repeatable,
      field_type: f.field_type,
      is_koha_field: f.is_koha_field,
      subfields: f.subfields.map((sf) => ({ code: sf.code, required: sf.required, default_value: sf.default_value })),
    })),
  };
}

// ---------------------------------------------------------------------
// Admin mutations. All scoped to framework_field_settings /
// framework_subfield_settings -- never touch marc_fields/marc_subfields,
// so General MARC21 is never modified by a framework-level change (see
// spec section 20 / "IMPORTANT DATA RULE").
// ---------------------------------------------------------------------

async function requireFieldSetting(frameworkId, tag) {
  const { rows } = await pool.query(
    `SELECT ffs.id FROM framework_field_settings ffs JOIN marc_fields mf ON mf.id = ffs.field_id WHERE ffs.framework_id = $1 AND mf.tag = $2`,
    [frameworkId, tag]
  );
  return rows[0]?.id ?? null;
}

export async function setFieldSetting(frameworkCode, tag, patch) {
  const framework = await getFrameworkByCode(frameworkCode);
  if (!framework) throw new Error(`Unknown framework: ${frameworkCode}`);
  const settingId = await requireFieldSetting(framework.id, tag);
  if (!settingId) throw new Error(`Framework ${frameworkCode} has no field ${tag} configured`);

  const sets = [];
  const values = [];
  let i = 1;
  for (const key of ['enabled', 'required', 'default_value', 'section', 'display_order']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = $${i++}`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(settingId);
  await pool.query(`UPDATE framework_field_settings SET ${sets.join(', ')} WHERE id = $${i}`, values);
}

export async function setSubfieldSetting(frameworkCode, tag, subfieldCode, patch) {
  const framework = await getFrameworkByCode(frameworkCode);
  if (!framework) throw new Error(`Unknown framework: ${frameworkCode}`);
  const settingId = await requireFieldSetting(framework.id, tag);
  if (!settingId) throw new Error(`Framework ${frameworkCode} has no field ${tag} configured`);

  const code = subfieldCode ?? '_CONTROL_';
  const { rows } = await pool.query(
    `SELECT fss.id FROM framework_subfield_settings fss JOIN marc_subfields ms ON ms.id = fss.subfield_id WHERE fss.framework_field_setting_id = $1 AND ms.code = $2`,
    [settingId, code]
  );
  const subfieldSettingId = rows[0]?.id;
  if (!subfieldSettingId) throw new Error(`Framework ${frameworkCode} field ${tag} has no subfield $${subfieldCode} configured`);

  const sets = [];
  const values = [];
  let i = 1;
  for (const key of ['enabled', 'required', 'default_value', 'display_order']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = $${i++}`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(subfieldSettingId);
  await pool.query(`UPDATE framework_subfield_settings SET ${sets.join(', ')} WHERE id = $${i}`, values);
}

/** Create a new empty custom framework (no fields enabled yet). */
export async function createFramework({ code, name, description }) {
  const { rows } = await pool.query(
    `INSERT INTO marc_frameworks (code, name, description, framework_type) VALUES ($1,$2,$3,'CUSTOM') RETURNING id, code, name, description, framework_type, active`,
    [code, name, description ?? null]
  );
  return rows[0];
}

/** Enable a General field (with all its General subfields) in a custom framework, e.g. "add field to framework" from the admin UI. */
export async function addFieldToFramework(frameworkCode, tag, { section = null, required = false } = {}) {
  const framework = await getFrameworkByCode(frameworkCode);
  if (!framework) throw new Error(`Unknown framework: ${frameworkCode}`);
  const { rows: fieldRows } = await pool.query(`SELECT id FROM marc_fields WHERE tag = $1`, [tag]);
  const fieldId = fieldRows[0]?.id;
  if (!fieldId) throw new Error(`Tag ${tag} is not defined in the General MARC21 vocabulary -- add it there first.`);

  const { rows: sfRows } = await pool.query(`SELECT id, code, display_order FROM marc_subfields WHERE field_id = $1 ORDER BY display_order`, [fieldId]);

  const fieldSettingId = await upsertFrameworkFieldSetting(pool, {
    frameworkId: framework.id, fieldId, enabled: true, required, defaultValue: null, section, displayOrder: 0,
  });
  for (const sf of sfRows) {
    await upsertFrameworkSubfieldSetting(pool, { fieldSettingId, subfieldId: sf.id, enabled: true, required: false, defaultValue: null, displayOrder: sf.display_order });
  }
}

// ---------------------------------------------------------------------
// Import / export of framework configuration (spec section 18).
// ---------------------------------------------------------------------

export async function exportFrameworkAsJson(frameworkCode) {
  const tree = await getFrameworkFieldTree(frameworkCode, { onlyEnabled: false });
  if (!tree) return null;
  return {
    code: tree.framework.code,
    name: tree.framework.name,
    description: tree.framework.description,
    framework_type: tree.framework.framework_type,
    exported_at: new Date().toISOString(),
    fields: tree.fields,
  };
}
