import assert from 'assert';
import {
  getAllMarcRules,
  getMarcRule,
  getSupportedMarcRules,
  getRuleStatus,
  isFieldSupported,
  getKohaMapping,
  getValidationRule,
  getSeriesPolicy,
  getCataloguingSourceConfig,
  hasMarcRule,
  normalizeMarcTag,
  resetMarcRuleRegistryCache,
  RULE_STATUSES,
} from '../src/services/marcRuleRegistry.js';
import { buildSkeleton, getBuilderEmittedTags } from '../src/services/marcBuilder.js';
import { validateField, validateRecord, getValidatorCoveredTags } from '../src/services/marcValidator.js';
import { canMapTag, getMapperTags, mapFieldToKoha } from '../src/services/kohaMapper.js';
import {
  runMarcConsistencyCheck,
  assertNoBuilderWithoutRule,
} from '../src/services/marcConsistency.js';
import { getRuleProfile } from '../src/services/marcRuleRegistry.js';

resetMarcRuleRegistryCache();

function section(name) {
  console.log(`\n== ${name} ==`);
}

// --- Required tags exist ---
section('required rules exist');
for (const tag of ['000', '008', '040', '246', '440', '020', '082', '942']) {
  assert.ok(hasMarcRule(tag), `expected rule for ${tag}`);
  assert.ok(getMarcRule(tag), `getMarcRule(${tag})`);
  assert.ok(RULE_STATUSES.includes(getRuleStatus(tag)), `status for ${tag}`);
  console.log(`  ${tag}: ${getRuleStatus(tag)}`);
}

assert.strictEqual(normalizeMarcTag('LDR'), '000');
assert.strictEqual(getMarcRule('LDR').tag, '000');
assert.strictEqual(getMarcRule('000').field_type, 'CONTROL_FIELD');
assert.strictEqual(getMarcRule('008').field_type, 'CONTROL_FIELD');
assert.strictEqual(getMarcRule('020').field_type, 'VARIABLE_FIELD');

// --- Status model accuracy ---
section('status model');
assert.strictEqual(getRuleStatus('020'), 'SUPPORTED');
assert.strictEqual(getRuleStatus('245'), 'SUPPORTED');
assert.strictEqual(getRuleStatus('000'), 'PARTIAL');
assert.strictEqual(getRuleStatus('008'), 'PARTIAL');
assert.strictEqual(getRuleStatus('040'), 'PARTIAL');
assert.strictEqual(getRuleStatus('246'), 'PLANNED');
assert.strictEqual(getRuleStatus('440'), 'PLANNED');
assert.strictEqual(getRuleStatus('082'), 'SUPPORTED');
assert.strictEqual(getRuleStatus('942'), 'PROFILE_DEPENDENT');
assert.ok(getMarcRule('082').ai_assisted);
assert.ok(getMarcRule('082').evidence_required);
// No manual cataloguer-approval step exists anywhere in the pipeline --
// a DDC recommendation auto-accepts server-side the moment it's generated
// (ddcApprovalService.js) -- so 082 must NOT claim to need one.
assert.strictEqual(getMarcRule('082').cataloguer_review_required, false);
assert.strictEqual(isFieldSupported('020'), true);
assert.strictEqual(isFieldSupported('246'), false);

// --- 440 series policy ---
section('440 series policy');
const series = getSeriesPolicy();
assert.strictEqual(series.target_framework_field, '440');
assert.strictEqual(series.do_not_silently_replace_with, '490');
assert.strictEqual(series.status, 'PLANNED');
assert.ok(/440/.test(getMarcRule('440').notes));

// --- 040 config-driven ---
section('040 cataloguing_source config');
const src = getCataloguingSourceConfig();
assert.ok(src);
assert.strictEqual(src.original_agency, null);
assert.ok(src.language);
assert.ok(getValidationRule('040').subfields.a);
assert.ok(getKohaMapping('000').kind === 'CONTROL_FIELD');

// --- Loader API ---
section('loader API');
const all = getAllMarcRules();
assert.ok(all.length >= 20);
assert.ok(getSupportedMarcRules().every((r) => r.status === 'SUPPORTED'));
assert.ok(all.every((r) => RULE_STATUSES.includes(r.status)));

// --- Builder / rule consistency ---
section('builder registry consultation');
const profile = getRuleProfile();
const sample = {
  isbn: '9780141439518',
  title: 'Pride and Prejudice',
  subtitle: 'A Novel',
  authors: ['Jane Austen'],
  editors: [],
  illustrators: [],
  translators: [],
  publisher: 'Penguin Classics',
  publish_date: '2003',
  edition: 'Revised Edition',
  physical_description: { pages: 435, dimensions: '20 cm' },
  sources: { loc_marc: false, z3950: null },
};
const built = buildSkeleton(sample, profile);
assert.ok(built.skeleton.some((f) => f.tag === 'LDR' || f.tag === '000'));
assert.ok(built.skeleton.some((f) => f.tag === '008'));
assert.ok(built.skeleton.some((f) => f.tag === '020'));
assert.ok(built.skeleton.some((f) => f.tag === '245'));
// 040 emitted when language / description_conventions configured
assert.ok(built.skeleton.some((f) => f.tag === '040'), '040 should emit from config language/conventions');
assert.ok(Array.isArray(built.rule_consistency));
assert.strictEqual(built.rule_consistency.length, 0, JSON.stringify(built.rule_consistency));
const noOrphans = assertNoBuilderWithoutRule();
assert.ok(noOrphans.ok, `builder tags without rules: ${noOrphans.missing}`);
assert.ok(!built.skeleton.some((f) => f.tag === '246'), '246 must not auto-generate');
assert.ok(!built.skeleton.some((f) => f.tag === '440'), '440 not implemented in builder yet');

// --- Validator ---
section('validator architecture');
const ldr = built.skeleton.find((f) => f.tag === 'LDR' || f.tag === '000');
const ldrCheck = validateField({ ...ldr, tag: '000' });
assert.ok(ldrCheck.ok, JSON.stringify(ldrCheck.issues));
const eight = built.skeleton.find((f) => f.tag === '008');
assert.ok(validateField(eight).ok);
const isbnField = built.skeleton.find((f) => f.tag === '020');
assert.ok(validateField(isbnField).ok);
const bad = validateField({ tag: '020', indicators: [' ', ' '], subfields: [{ code: 'a', value: '1' }, { code: 'x', value: 'nope' }] });
assert.ok(bad.issues.some((i) => i.code === 'UNKNOWN_SUBFIELD'));
const record = validateRecord(
  built.skeleton.map((f) => (f.tag === 'LDR' ? { ...f, tag: '000' } : f))
);
assert.ok(record.incomplete, 'P1 must mark validation incomplete');
assert.ok(getValidatorCoveredTags().includes('000'));

// --- Koha mapper ---
section('koha / rule consistency');
assert.ok(canMapTag('020'));
assert.ok(canMapTag('000'));
assert.strictEqual(canMapTag('246'), false);
assert.strictEqual(canMapTag('440'), false);
assert.ok(getMapperTags().includes('020'));
const mapped = mapFieldToKoha(isbnField);
assert.strictEqual(mapped.tag, '020');
assert.strictEqual(mapped.kind, 'VARIABLE_FIELD');

// --- Consistency checker ---
section('consistency report');
const { machine, human, findings } = runMarcConsistencyCheck();
assert.ok(human.includes('MARC RULE CONSISTENCY REPORT'));
assert.ok(human.includes('000'));
assert.ok(human.includes('440'));
assert.ok(human.includes('SERIES POLICY'));
assert.strictEqual(machine.admin_rules_ui, 'USES_REGISTRY');
assert.ok(!findings.some((f) => f.code === 'BUILDER_WITHOUT_RULE'), JSON.stringify(findings));
const row082 = machine.rows.find((r) => r.tag === '082');
assert.strictEqual(row082.ddc_approval, 'P2');
const row440 = machine.rows.find((r) => r.tag === '440');
assert.strictEqual(row440.status, 'PLANNED');
const row246 = machine.rows.find((r) => r.tag === '246');
assert.strictEqual(row246.builder, 'NO');

// --- Admin rule rendering shape ---
section('admin rule rendering shape');
const adminRows = getAllMarcRules().map((rule) => ({
  tag: rule.tag,
  label: rule.label,
  status: rule.status,
  generation: rule.generation_method,
  validation: rule.validation ? (rule.validation.incomplete ? 'partial' : 'yes') : '—',
  ai: rule.ai_assisted,
  evidence: rule.evidence_required,
  koha: rule.koha_supported,
}));
assert.ok(adminRows.find((r) => r.tag === '082' && r.status === 'SUPPORTED' && r.ai === true));
assert.ok(adminRows.find((r) => r.tag === '000' && r.label === 'Leader'));
assert.ok(getBuilderEmittedTags().includes('000'));

console.log('\nAll P1 MARC rule registry tests passed.');
console.log('\n--- sample consistency excerpt ---\n');
console.log(human.split('\n').slice(0, 40).join('\n'));
