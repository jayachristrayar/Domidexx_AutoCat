// P4 tests: backend Koha fill-plan builder (kohaMapper.buildKohaFillPlan,
// wired through generateMarcRecord) + the extension's pure DOM autofill
// engine (kohaFillEngine.js), run against a hand-rolled fixture DOM that
// models Koha's addbiblio.pl markup conventions (see
// backend/scripts/lib/kohaEditorFixture.js for the caveat on why this is
// not the same as testing against a live Koha 26.05 instance).
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { generateMarcRecord } from '../src/services/marcPipeline.js';
import * as engine from '../../extension/src/content-scripts/kohaFillEngine.js';
import { buildKohaEditorFixture } from './lib/kohaEditorFixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseMetadata = {
  isbn: '978-0-141-43951-8',
  title: 'Introduction to Library and Information Science',
  authors: ['Jane Cataloguer'],
  edition: 'Second edition',
  publisher: 'Example Press',
  publish_date: '2024',
  language: 'eng',
  description: 'A whole-book introduction to library and information science.',
  subjects: ['Library science'],
  physical_description: { pages: '240', dimensions: '24 cm' },
};

function approvedDdc(number = '020') {
  return { ai_recommended_ddc: number, approved_ddc: number, approval_status: 'APPROVED' };
}

// ---------------------------------------------------------------------
// == static safety guard ==
// The engine and content script must never contain a literal call that
// could submit/save the record. This is checked as source text, not just
// behavior, so a future edit that reintroduces one fails immediately.
// ---------------------------------------------------------------------
console.log('\n== static safety guard ==');
for (const rel of ['../../extension/src/content-scripts/kohaFillEngine.js', '../../extension/src/content-scripts/koha-fill.js']) {
  const source = readFileSync(join(__dirname, rel), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.ok(!/\.submit\(/.test(source), `${rel} must not call .submit( in code`);
  assert.ok(!/\.requestSubmit\(/.test(source), `${rel} must not call .requestSubmit( in code`);
  assert.ok(!/\.click\(/.test(source), `${rel} must not call .click( directly in code (dispatchEvent('click') on a verified non-save element is fine)`);
}
console.log('  no .submit(/.requestSubmit(/.click( in engine or content script source');

// ---------------------------------------------------------------------
// == backend: buildKohaFillPlan via generateMarcRecord ==
// ---------------------------------------------------------------------
console.log('\n== backend fill-plan builder ==');
{
  const result = generateMarcRecord({ metadata: baseMetadata, ddc_approval: approvedDdc() }, { now: new Date('2026-08-22T12:34:56Z') });
  assert.strictEqual(result.validation.valid, true, JSON.stringify(result.validation.errors));
  assert.ok(result.koha_fill, 'valid record must produce a koha_fill plan');
  const tags = result.koha_fill.fields.map((f) => f.tag);
  for (const expected of ['020', '245', '100', '250', '300', '082', '650']) {
    assert.ok(tags.includes(expected), `expected ${expected} in fill plan, got ${tags.join(',')}`);
  }
  const field020 = result.koha_fill.fields.find((f) => f.tag === '020');
  assert.strictEqual(field020.subfields.find((sf) => sf.code === 'a').value, '9780141439518');
  const field082 = result.koha_fill.fields.find((f) => f.tag === '082');
  assert.strictEqual(field082.subfields.find((sf) => sf.code === 'a').value, '020');
  assert.strictEqual(result.koha_fill.ddc_gate.approved, true);
  assert.ok(
    result.koha_fill.notes.some((n) => n.code === '040_not_configured'),
    '040 without a configured agency must be reported, not fabricated'
  );
  console.log('  APPROVED record: 020/082 distinct, core fields present, 040_not_configured surfaced');
}
{
  const result = generateMarcRecord({ metadata: baseMetadata, ddc_approval: { ai_recommended_ddc: '020', approval_status: 'PENDING' } }, { now: new Date('2026-08-22T12:34:56Z') });
  assert.strictEqual(result.validation.valid, false);
  assert.strictEqual(result.koha_fill, null, 'an invalid (unapproved 082) record must not produce a fill plan');
  console.log('  PENDING approval: no fill plan at all (validation fails)');
}
{
  // A hand-built marcResult with an 082 field present but an unapproved
  // decision must still be rejected by the plan builder itself (defense
  // in depth beyond marcPipeline's own gating).
  const { buildKohaFillPlan } = await import('../src/services/kohaMapper.js');
  const fakeResult = {
    fields: [{ tag: '082', indicators: [' ', ' '], subfields: [{ code: 'a', value: '020' }] }],
    validation: { fields: { '082': { valid: true } } },
  };
  const plan = buildKohaFillPlan(fakeResult, { ddcApproval: { approval_status: 'PENDING' } });
  assert.strictEqual(plan.fields.find((f) => f.tag === '082'), undefined);
  assert.ok(plan.skipped.some((s) => s.tag === '082' && s.reason === 'ddc_not_approved'));
  console.log('  hand-built unapproved 082 is rejected by buildKohaFillPlan directly');
}

// ---------------------------------------------------------------------
// == extension engine: fill against a fixture Koha editor DOM ==
// ---------------------------------------------------------------------
console.log('\n== extension engine: fill ==');
{
  const marcResult = generateMarcRecord({ metadata: baseMetadata, ddc_approval: approvedDdc() }, { now: new Date('2026-08-22T12:34:56Z') });
  const saveClicked = { value: false };
  const doc = buildKohaEditorFixture({ saveClicked });

  const result = engine.runKohaFill(doc, marcResult.koha_fill, { ddcApproved: true });
  assert.strictEqual(result.status, 'complete', JSON.stringify(result, null, 2));
  assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
  assert.strictEqual(result.conflicts.length, 0);
  assert.ok(result.filled.some((f) => f.tag === '245' && f.subfield === 'a'));
  assert.ok(result.filled.some((f) => f.tag === '020' && f.subfield === 'a'));
  assert.ok(result.filled.some((f) => f.tag === '082' && f.subfield === 'a'));
  assert.ok(result.filled.some((f) => f.tag === '650' && f.subfield === 'a'));

  const titleInput = doc.querySelector('.field[id^="tag_245_"]').querySelector('.subfield_line[class*="subfield_a"]').querySelector('input[name="field_value"]');
  assert.strictEqual(titleInput.value, 'Introduction to Library and Information Science /');
  assert.strictEqual(saveClicked.value, false, 'fill must never trigger the Save button');
  console.log('  first fill: all mappable fields filled, DOM read-back matches, Save never clicked');

  // Idempotency: filling again against the now-populated DOM must report
  // already_present, not duplicate writes or conflicts.
  const second = engine.runKohaFill(doc, marcResult.koha_fill, { ddcApproved: true });
  assert.strictEqual(second.status, 'complete');
  assert.strictEqual(second.filled.length, 0, 'nothing should be re-filled once already present');
  assert.ok(second.already_present.some((f) => f.tag === '245' && f.subfield === 'a'));
  assert.ok(second.already_present.some((f) => f.tag === '650' && f.subfield === 'a'));
  assert.strictEqual(saveClicked.value, false);
  console.log('  second fill on same DOM: everything reported already_present, still no Save click');
}

console.log('\n== extension engine: conflicts are never auto-overwritten ==');
{
  const marcResult = generateMarcRecord({ metadata: baseMetadata, ddc_approval: approvedDdc() }, { now: new Date('2026-08-22T12:34:56Z') });
  const doc = buildKohaEditorFixture();
  const titleInput = doc.querySelector('.field[id^="tag_245_"]').querySelector('.subfield_line[class*="subfield_a"]').querySelector('input[name="field_value"]');
  titleInput.value = 'A completely different, cataloguer-entered title';

  const result = engine.runKohaFill(doc, marcResult.koha_fill, { ddcApproved: true });
  assert.strictEqual(result.status, 'partial');
  const conflict = result.conflicts.find((c) => c.tag === '245' && c.subfield === 'a');
  assert.ok(conflict, 'differing existing value must be reported as a conflict');
  assert.strictEqual(conflict.existing, 'A completely different, cataloguer-entered title');
  assert.strictEqual(titleInput.value, 'A completely different, cataloguer-entered title', 'conflicting field must be left untouched');
  console.log('  existing different value -> conflict reported, DOM untouched');
}

console.log('\n== extension engine: repeatable fields ==');
{
  const marcResult = generateMarcRecord(
    { metadata: { ...baseMetadata, subjects: ['Information science'] }, ddc_approval: approvedDdc() },
    { now: new Date('2026-08-22T12:34:56Z') }
  );
  const doc = buildKohaEditorFixture({ existing650: ['Library science', 'Cataloging'] });

  const result = engine.runKohaFill(doc, marcResult.koha_fill, { ddcApproved: true });
  const filled650 = result.filled.find((f) => f.tag === '650' && f.subfield === 'a');
  assert.ok(filled650, `expected a new 650 occurrence to be filled: ${JSON.stringify(result, null, 2)}`);

  const values650 = doc
    .querySelectorAll('.subfield_line[class*="subfield_a"]')
    .filter((row) => row.closest('.field').querySelector('input[name="tag"]').value === '650')
    .map((row) => row.querySelector('input[name="field_value"]').value);
  assert.deepStrictEqual(new Set(values650), new Set(['Library science', 'Cataloging', 'Information science']));
  console.log('  new 650 occurrence added via clone control; existing occurrences untouched:', values650);

  // Re-running with a subject that already exists in any occurrence must
  // not add a duplicate row.
  const dup = engine.runKohaFill(
    doc,
    { fields: [{ tag: '650', field_type: 'VARIABLE_FIELD', indicators: { ind1: ' ', ind2: '0' }, subfields: [{ code: 'a', value: 'Cataloging' }], repeatable: true }], skipped: [], ddc_gate: { approved: true } },
    { ddcApproved: true }
  );
  assert.ok(dup.already_present.some((f) => f.tag === '650'));
  console.log('  re-filling an already-present subject value across occurrences -> already_present, no duplicate row');
}

console.log('\n== extension engine: verify-before-write refuses to guess ==');
{
  const doc = buildKohaEditorFixture();
  const plan = {
    fields: [{ tag: '999', field_type: 'VARIABLE_FIELD', indicators: { ind1: ' ', ind2: ' ' }, subfields: [{ code: 'a', value: 'no such field in this fixture' }], repeatable: false }],
    skipped: [],
    ddc_gate: { approved: true },
  };
  const result = engine.runKohaFill(doc, plan, { ddcApproved: true });
  assert.ok(result.skipped.some((s) => s.tag === '999' && s.reason === 'field_not_found'));
  console.log('  a field with no matching DOM container is skipped, never written');
}

console.log('\n== extension engine: 082 gate re-checked independently of the backend plan ==');
{
  const doc = buildKohaEditorFixture();
  const tamperedPlan = {
    fields: [{ tag: '082', field_type: 'VARIABLE_FIELD', indicators: { ind1: '0', ind2: '4' }, subfields: [{ code: 'a', value: '020' }], repeatable: true }],
    skipped: [],
    ddc_gate: { approved: false },
  };
  const result = engine.runKohaFill(doc, tamperedPlan, { ddcApproved: false });
  assert.ok(result.skipped.some((s) => s.tag === '082' && s.reason === 'ddc_not_approved'));
  const ddcInput = doc.querySelector('.field[id^="tag_082_"]').querySelector('.subfield_line[class*="subfield_a"]').querySelector('input[name="field_value"]');
  assert.strictEqual(ddcInput.value, '', '082 must remain empty when DDC approval is not confirmed');
  console.log('  082 write refused when ddcApproved is false, even if a tampered plan includes it');
}

console.log('\n== extension engine: 020/082 shape protection ==');
{
  const doc = buildKohaEditorFixture();
  const badPlan = {
    fields: [
      { tag: '020', field_type: 'VARIABLE_FIELD', indicators: { ind1: ' ', ind2: ' ' }, subfields: [{ code: 'a', value: '020' }], repeatable: true },
      { tag: '082', field_type: 'VARIABLE_FIELD', indicators: { ind1: '0', ind2: '4' }, subfields: [{ code: 'a', value: '9780141439518' }], repeatable: true },
    ],
    skipped: [],
    ddc_gate: { approved: true },
  };
  const result = engine.runKohaFill(doc, badPlan, { ddcApproved: true });
  assert.ok(result.failed.some((f) => f.tag === '020' && f.reason === 'shape_mismatch_expected_isbn'));
  assert.ok(result.failed.some((f) => f.tag === '082' && f.reason === 'shape_mismatch_expected_ddc'));
  console.log('  a DDC number offered for 020, or an ISBN offered for 082, is refused rather than written');
}

console.log('\n== extension engine: plan validation rejects malformed instructions ==');
{
  assert.strictEqual(engine.validateInstruction({ tag: '24X', field_type: 'VARIABLE_FIELD', subfields: [{ code: 'a', value: 'x' }] }), 'invalid_tag');
  assert.strictEqual(engine.validateInstruction({ tag: '245', field_type: 'VARIABLE_FIELD', indicators: { ind1: 'X', ind2: ' ' }, subfields: [{ code: 'a', value: 'x' }] }), 'invalid_indicator');
  assert.strictEqual(engine.validateInstruction({ tag: '245', field_type: 'VARIABLE_FIELD', subfields: [{ code: '!', value: 'x' }] }), 'unknown_subfield');
  assert.strictEqual(engine.validateInstruction({ tag: '245', field_type: 'VARIABLE_FIELD', subfields: [{ code: 'a', value: '' }] }), 'malformed_value');
  assert.strictEqual(engine.validateInstruction({ tag: '245', field_type: 'VARIABLE_FIELD', subfields: [{ code: 'a', value: 'ok' }] }), null);
  console.log('  malformed tag/indicator/subfield/value all rejected before touching the DOM');
}

console.log('\n== extension engine: save guard ==');
{
  const doc = buildKohaEditorFixture();
  const saveButton = doc.querySelector('button[type="submit"]');
  assert.ok(engine.isSaveElement(saveButton), 'the fixture Save button must be recognized as a save element');
  const ordinaryInput = doc.querySelector('.field[id^="tag_245_"] input[name="field_value"]');
  assert.strictEqual(engine.isSaveElement(ordinaryInput), false);
  console.log('  isSaveElement distinguishes the Save button from ordinary MARC value inputs');
}

console.log('\nAll P4 Koha fill tests passed.');
