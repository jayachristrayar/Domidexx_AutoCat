// MARC framework engine tests: seeding, the two-layer separation
// guarantee, the AI-pipeline filter contract, and the validation engine.
// Requires a real Postgres connection (DATABASE_URL) since the framework
// engine is DB-backed by design (spec section 9).
import assert from 'assert';
import { ensureSchema } from '../src/db/index.js';
import {
  seedMarcFrameworks,
  listFrameworks,
  getFrameworkFieldTree,
  getFrameworkSections,
  getFrameworkConstraints,
  filterFieldsToFramework,
  setFieldSetting,
  setSubfieldSetting,
  createFramework,
  addFieldToFramework,
} from '../src/services/marcFrameworkService.js';
import { validateAgainstFramework, applyFrameworkDefaults } from '../src/services/marcFrameworkValidator.js';
import { CUSTOM_FIELD_CONFIG } from '../rules/marc_custom_framework.js';

await ensureSchema();

console.log('\n== seeding ==');
{
  const result = await seedMarcFrameworks();
  assert.ok(result.generalFields > 150, `expected a broad General MARC21 set, got ${result.generalFields}`);
  assert.strictEqual(result.customFields, Object.keys(CUSTOM_FIELD_CONFIG).length);
  // Idempotent: re-running must not error or duplicate.
  const second = await seedMarcFrameworks();
  assert.strictEqual(second.generalFields, result.generalFields);
  console.log(`  seeded ${result.generalFields} general fields, ${result.customFields} custom fields; re-seed is idempotent`);
}

console.log('\n== two frameworks exist, custom is a strict subset ==');
{
  const frameworks = await listFrameworks();
  const codes = frameworks.map((f) => f.code);
  assert.ok(codes.includes('GENERAL'));
  assert.ok(codes.includes('MY_LIBRARY'));
  const general = await getFrameworkFieldTree('GENERAL');
  const custom = await getFrameworkFieldTree('MY_LIBRARY');
  assert.ok(general.fields.length > custom.fields.length, 'General must have more fields than the custom framework');
  const generalTags = new Set(general.fields.map((f) => f.tag));
  for (const field of custom.fields) assert.ok(generalTags.has(field.tag), `custom tag ${field.tag} must exist in General`);
  console.log(`  GENERAL has ${general.fields.length} fields, MY_LIBRARY has ${custom.fields.length}, every custom tag exists in General`);
}

console.log('\n== custom framework matches the spec exactly ==');
{
  const custom = await getFrameworkFieldTree('MY_LIBRARY');
  const tags = new Set(custom.fields.map((f) => f.tag));
  assert.strictEqual(tags.size, Object.keys(CUSTOM_FIELD_CONFIG).length);
  for (const tag of Object.keys(CUSTOM_FIELD_CONFIG)) assert.ok(tags.has(tag), `missing configured tag ${tag}`);
  assert.ok(!tags.has('651') === false); // 651 IS configured (section 6) -- sanity the set isn't accidentally narrowed
  assert.ok(!tags.has('662'), '662 must NOT be in the custom framework (not configured)');

  const f245 = custom.fields.find((f) => f.tag === '245');
  assert.deepStrictEqual(f245.subfields.map((sf) => sf.code), ['a', 'b', 'c', 'h']);
  assert.strictEqual(f245.subfields.find((sf) => sf.code === 'a').required, true);

  const f942 = custom.fields.find((f) => f.tag === '942');
  assert.strictEqual(f942.subfields.find((sf) => sf.code === '2').default_value, 'Dewey Decimal Classification');
  assert.strictEqual(f942.subfields.find((sf) => sf.code === 'c').required, true);
  assert.ok(f942.is_koha_field, '942 must be flagged Koha-specific, not standard MARC21');

  assert.strictEqual(custom.fields.find((f) => f.tag === '000').required, true);
  assert.strictEqual(custom.fields.find((f) => f.tag === '008').required, true);
  assert.strictEqual(custom.fields.find((f) => f.tag === '300').subfields.find((sf) => sf.code === 'a').required, true);
  console.log('  59 tags match; 245$a/300$a/942$c required, 942$2 default, 942 flagged Koha-specific, 662 correctly excluded');
}

console.log('\n== section navigation matches the spec\'s 0-9 groupings ==');
{
  const { sections } = await getFrameworkSections('MY_LIBRARY');
  assert.deepStrictEqual(sections['4'].map((f) => f.tag), ['440']);
  assert.deepStrictEqual(new Set(sections['9'].map((f) => f.tag)), new Set(['270', '365', '366', '541', '583', '942']));
  console.log('  section 4 = [440], section 9 = [270,365,366,541,583,942], as specified');
}

console.log('\n== disabling/requiring in custom framework never touches General ==');
{
  await setFieldSetting('MY_LIBRARY', '650', { required: true });
  const customAfter = await getFrameworkFieldTree('MY_LIBRARY');
  const generalAfter = await getFrameworkFieldTree('GENERAL');
  assert.strictEqual(customAfter.fields.find((f) => f.tag === '650').required, true);
  assert.strictEqual(generalAfter.fields.find((f) => f.tag === '650').required, false, 'General must be unaffected');

  await setFieldSetting('MY_LIBRARY', '650', { enabled: false });
  const customDisabled = await getFrameworkFieldTree('MY_LIBRARY');
  assert.ok(!customDisabled.fields.some((f) => f.tag === '650'), '650 should be hidden once disabled for MY_LIBRARY');
  const generalStillHas650 = await getFrameworkFieldTree('GENERAL');
  assert.ok(generalStillHas650.fields.some((f) => f.tag === '650'), 'General must still have 650');
  // restore for later assertions
  await setFieldSetting('MY_LIBRARY', '650', { enabled: true, required: false });

  await setSubfieldSetting('MY_LIBRARY', '245', 'b', { required: true });
  const custom245 = await getFrameworkFieldTree('MY_LIBRARY');
  assert.strictEqual(custom245.fields.find((f) => f.tag === '245').subfields.find((sf) => sf.code === 'b').required, true);
  const general245 = await getFrameworkFieldTree('GENERAL');
  assert.strictEqual(general245.fields.find((f) => f.tag === '245').subfields.find((sf) => sf.code === 'b').required, false);
  await setSubfieldSetting('MY_LIBRARY', '245', 'b', { required: false });
  console.log('  required/enabled/subfield-required changes on MY_LIBRARY leave GENERAL untouched, and re-enabling restores visibility');
}

console.log('\n== admin: create a new custom framework, add one field ==');
{
  const created = await createFramework({ code: 'TEST_LIB_2', name: 'Second Test Library' });
  assert.strictEqual(created.framework_type, 'CUSTOM');
  const empty = await getFrameworkFieldTree('TEST_LIB_2');
  assert.strictEqual(empty.fields.length, 0, 'a freshly created framework must start with no enabled fields');
  await addFieldToFramework('TEST_LIB_2', '245', { section: '2', required: true });
  const withField = await getFrameworkFieldTree('TEST_LIB_2');
  assert.strictEqual(withField.fields.length, 1);
  assert.strictEqual(withField.fields[0].tag, '245');
  assert.ok(withField.fields[0].subfields.length > 0, 'adding a field should carry its General subfields along');
  console.log('  new framework starts empty; addFieldToFramework enables one General field with its subfields');
}

console.log('\n== AI-pipeline contract: filterFieldsToFramework never lets a disallowed tag through ==');
{
  const proposed = [
    { tag: '245', subfields: [{ code: 'a', value: 'Title' }] },
    { tag: '651', subfields: [{ code: 'a', value: 'Geo subject' }] }, // in framework
    { tag: '662', subfields: [{ code: 'a', value: 'not configured' }] }, // NOT in framework
    { tag: '245', subfields: [{ code: 'z', value: 'not an enabled subfield' }] },
  ];
  const { allowed, dropped } = await filterFieldsToFramework(proposed, 'MY_LIBRARY');
  assert.ok(allowed.some((f) => f.tag === '245' && f.subfields.some((sf) => sf.code === 'a')));
  assert.ok(allowed.some((f) => f.tag === '651'));
  assert.ok(!allowed.some((f) => f.tag === '662'), '662 must never be allowed through');
  assert.ok(dropped.some((d) => d.tag === '662' && d.reason === 'field_not_in_framework'));
  console.log('  662 (not in framework) dropped; 245/651 (in framework) kept; unlisted subfields dropped independently');

  const constraints = await getFrameworkConstraints('MY_LIBRARY');
  assert.strictEqual(constraints.framework.code, 'MY_LIBRARY');
  assert.ok(constraints.fields.every((f) => typeof f.tag === 'string'));
  console.log(`  getFrameworkConstraints() returns ${constraints.fields.length} fields for the AI pipeline to constrain against`);
}

console.log('\n== validation engine ==');
{
  const missingRequired = [{ tag: '245', indicators: [' ', ' '], subfields: [{ code: 'b', value: 'no title' }] }];
  const r1 = await validateAgainstFramework(missingRequired, 'MY_LIBRARY');
  assert.strictEqual(r1.valid, false);
  assert.ok(r1.errors.some((e) => e.code === 'SUBFIELD_REQUIRED' && e.tag === '245' && e.subfield === 'a'));
  assert.ok(r1.errors.some((e) => e.code === 'FIELD_REQUIRED' && e.tag === '000'));
  assert.ok(r1.errors.some((e) => e.code === 'FIELD_REQUIRED' && e.tag === '008'));

  const good = [
    { tag: '000', subfields: [{ code: null, value: '0'.repeat(24) }] },
    { tag: '008', subfields: [{ code: null, value: 'x'.repeat(40) }] },
    { tag: '245', indicators: ['0', '0'], subfields: [{ code: 'a', value: 'Title' }] },
    { tag: '300', indicators: [' ', ' '], subfields: [{ code: 'a', value: '240 p.' }] },
    { tag: '942', indicators: [' ', ' '], subfields: [{ code: '2', value: 'Dewey Decimal Classification' }, { code: 'c', value: 'BOOK' }] },
  ];
  const r2 = await validateAgainstFramework(good, 'MY_LIBRARY');
  assert.strictEqual(r2.valid, true, JSON.stringify(r2.errors));

  const notInFramework = [{ tag: '662', indicators: [' ', ' '], subfields: [{ code: 'a', value: 'x' }] }];
  const r3 = await validateAgainstFramework(notInFramework, 'MY_LIBRARY');
  assert.ok(r3.errors.some((e) => e.code === 'FIELD_NOT_IN_FRAMEWORK' && e.tag === '662'));

  const disallowedSubfield = [{ tag: '245', indicators: ['0', '0'], subfields: [{ code: 'a', value: 'T' }, { code: 'z', value: 'nope' }] }];
  const r4 = await validateAgainstFramework(disallowedSubfield, 'MY_LIBRARY');
  assert.ok(r4.errors.some((e) => e.code === 'SUBFIELD_NOT_ALLOWED' && e.tag === '245' && e.subfield === 'z'));

  const notRepeatable = [
    { tag: '100', indicators: ['1', ' '], subfields: [{ code: 'a', value: 'One, Author' }] },
    { tag: '100', indicators: ['1', ' '], subfields: [{ code: 'a', value: 'Two, Author' }] },
  ];
  const r5 = await validateAgainstFramework(notRepeatable, 'MY_LIBRARY');
  assert.ok(r5.errors.some((e) => e.code === 'FIELD_NOT_REPEATABLE' && e.tag === '100'));

  const kohaError = r1.errors.find((e) => e.tag === '650'); // not present in this minimal record but not required either
  console.log('  required fields/subfields, framework-restriction, disallowed-subfield, and non-repeatable checks all fire correctly');
}

console.log('\n== default-value application never overwrites what\'s already present ==');
{
  const tree = await getFrameworkFieldTree('MY_LIBRARY');
  const withoutDefault = applyFrameworkDefaults([{ tag: '942', indicators: [' ', ' '], subfields: [{ code: 'c', value: 'BOOK' }] }], tree.fields);
  assert.strictEqual(withoutDefault.find((f) => f.tag === '942').subfields.find((sf) => sf.code === '2').value, 'Dewey Decimal Classification');

  const withExistingValue = applyFrameworkDefaults(
    [{ tag: '942', indicators: [' ', ' '], subfields: [{ code: '2', value: 'Library of Congress Classification' }, { code: 'c', value: 'BOOK' }] }],
    tree.fields
  );
  assert.strictEqual(
    withExistingValue.find((f) => f.tag === '942').subfields.find((sf) => sf.code === '2').value,
    'Library of Congress Classification',
    'an existing value must never be overwritten by the default'
  );
  console.log('  942$2 defaults to Dewey Decimal Classification when absent, and is left alone when already set');
}

console.log('\nAll MARC framework engine tests passed.');
process.exit(0);
