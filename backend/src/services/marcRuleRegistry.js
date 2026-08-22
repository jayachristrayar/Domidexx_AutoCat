// Centralized MARC rule registry — runtime source of truth for AutoCat.
// All subsystems (builder, validator, Koha mapper, Admin Rules UI,
// consistency checker) must load rules through this module. Do not parse
// marc_runtime_rules.json elsewhere.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(__dirname, '..', '..', 'rules');

export const RULE_STATUSES = Object.freeze([
  'SUPPORTED',
  'PARTIAL',
  'OPTIONAL',
  'PROFILE_DEPENDENT',
  'LEGACY',
  'PLANNED',
  'NOT_SUPPORTED',
]);

export const FIELD_TYPES = Object.freeze(['CONTROL_FIELD', 'VARIABLE_FIELD']);

let cache = null;

function loadJson(filename) {
  return JSON.parse(readFileSync(join(RULES_DIR, filename), 'utf8'));
}

function normalizeTag(tag) {
  if (tag == null) return null;
  const raw = String(tag).trim().toUpperCase();
  if (raw === 'LDR' || raw === 'LEADER') return '000';
  if (/^\d{1,3}$/.test(raw)) return raw.padStart(3, '0');
  return raw;
}

function attachCataloguingProse(rulesByTag) {
  let proseRules = [];
  try {
    proseRules = loadJson('marc_field_rules.json');
  } catch {
    return;
  }
  for (const prose of proseRules) {
    const tag = normalizeTag(prose.tag);
    const rule = rulesByTag.get(tag);
    if (!rule) continue;
    rule.content_markdown = prose.content_markdown ?? null;
    if (!rule.label && prose.field_name) rule.label = prose.field_name;
  }
}

function buildCache() {
  const runtime = loadJson('marc_runtime_rules.json');
  const profile = loadJson('rule_profile.json');
  const rulesByTag = new Map();
  const aliasToCanonical = new Map();

  for (const raw of runtime.rules ?? []) {
    const tag = normalizeTag(raw.tag);
    if (!tag) continue;
    if (!RULE_STATUSES.includes(raw.status)) {
      throw new Error(`Invalid rule status for tag ${tag}: ${raw.status}`);
    }
    if (!FIELD_TYPES.includes(raw.field_type)) {
      throw new Error(`Invalid field_type for tag ${tag}: ${raw.field_type}`);
    }
    const rule = {
      ...raw,
      tag,
      content_markdown: null,
    };
    rulesByTag.set(tag, rule);
    aliasToCanonical.set(tag, tag);
    for (const alias of raw.aliases ?? []) {
      aliasToCanonical.set(normalizeTag(alias), tag);
    }
  }

  attachCataloguingProse(rulesByTag);

  return {
    schema_version: runtime.schema_version,
    status_model: runtime.status_model ?? RULE_STATUSES,
    series_policy: runtime.series_policy ?? null,
    notes: runtime.notes ?? null,
    profile,
    rulesByTag,
    aliasToCanonical,
  };
}

/** Reset in-memory cache (tests). */
export function resetMarcRuleRegistryCache() {
  cache = null;
}

export function loadMarcRuleRegistry({ force = false } = {}) {
  if (!cache || force) cache = buildCache();
  return cache;
}

export function getMarcRule(tag) {
  const { rulesByTag, aliasToCanonical } = loadMarcRuleRegistry();
  const canonical = aliasToCanonical.get(normalizeTag(tag));
  if (!canonical) return null;
  return rulesByTag.get(canonical) ?? null;
}

export function getAllMarcRules() {
  return Array.from(loadMarcRuleRegistry().rulesByTag.values()).sort((a, b) =>
    a.tag.localeCompare(b.tag)
  );
}

export function getSupportedMarcRules() {
  return getAllMarcRules().filter((rule) => rule.status === 'SUPPORTED');
}

export function getRuleStatus(tag) {
  return getMarcRule(tag)?.status ?? null;
}

export function isFieldSupported(tag) {
  return getRuleStatus(tag) === 'SUPPORTED';
}

export function getKohaMapping(tag) {
  return getMarcRule(tag)?.koha_mapping ?? null;
}

export function getValidationRule(tag) {
  return getMarcRule(tag)?.validation ?? null;
}

export function getRuleProfile() {
  return loadMarcRuleRegistry().profile;
}

export function getSeriesPolicy() {
  return loadMarcRuleRegistry().series_policy;
}

export function getCataloguingSourceConfig() {
  return loadMarcRuleRegistry().profile?.cataloguing_source ?? null;
}

export function normalizeMarcTag(tag) {
  return normalizeTag(tag);
}

export function listRuleTags() {
  return getAllMarcRules().map((rule) => rule.tag);
}

export function hasMarcRule(tag) {
  return getMarcRule(tag) != null;
}
