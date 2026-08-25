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
// kohaFillEngine.js is a classic script (Manifest V3 content scripts can't
// use export/import -- see that file's header comment), so it's imported
// here for its side effect of populating globalThis.AutoCatKohaFillEngine,
// the same way koha-fill.js reads it in the browser.
import '../../extension/src/content-scripts/kohaFillEngine.js';
import { buildKohaEditorFixture } from './lib/kohaEditorFixture.js';

const engine = globalThis.AutoCatKohaFillEngine;

// Test-only DOM read-back helpers, matching the fixture's real Koha
// markup (see kohaEditorFixture.js): field containers are `.tag[id^=...]`
// with the tag in a `.tagnum` span, subfield rows are `.subfield_line`
// with a code input matching `[name*="_code_"]`, and value inputs carry
// class `input_marceditor`.
function readSubfieldValue(doc, tag, code) {
  const container = doc.querySelector(`.tag[id^="tag_${tag}_"]`);
  if (!container) return null;
  for (const row of container.querySelectorAll('.subfield_line')) {
    const codeInput = row.querySelector('input[name*="_code_"]');
    if (codeInput && codeInput.value === code) {
      const valueInput = row.querySelector('input.input_marceditor, textarea.input_marceditor');
      return valueInput ? valueInput.value : null;
    }
  }
  return null;
}

function readAllSubfieldValues(doc, tag, code) {
  const values = [];
  for (const container of doc.querySelectorAll(`.tag[id^="tag_${tag}_"]`)) {
    for (const row of container.querySelectorAll('.subfield_line')) {
      const codeInput = row.querySelector('input[name*="_code_"]');
      if (codeInput && codeInput.value === code) {
        const valueInput = row.querySelector('input.input_marceditor, textarea.input_marceditor');
        if (valueInput) values.push(valueInput.value);
      }
    }
  }
  return values;
}

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

  // Control fields must never be handed to the generic DOM writer -- Koha
  // renders 000/005/008 through fixed-field plugin widgets, not a plain
  // value input, so attempting a generic write always fails with
  // value_input_not_found. They must be cleanly skipped instead.
  assert.ok(!tags.includes('000'), '000 must not be sent to the Koha DOM writer');
  assert.ok(!tags.includes('005'), '005 must not be sent to the Koha DOM writer');
  assert.ok(!tags.includes('008'), '008 must not be sent to the Koha DOM writer');
  // 000/005/008 are never generated by AutoCat at all (see marcBuilder.js/
  // marcPipeline.js), so they must not appear anywhere in the fill plan --
  // not in `fields`, and not even in `skipped` (product spec: they must not
  // be shown as skipped fields in normal user-facing MARC results).
  for (const tag of ['000', '005', '008']) {
    assert.ok(!result.fields.find((f) => f.tag === tag), `${tag} must not be generated`);
    assert.ok(!result.koha_fill.skipped.some((s) => s.tag === tag), `${tag} must not appear in koha_fill.skipped`);
  }
  console.log('  000/005/008 never generated, never sent to the generic writer, never shown as skipped');
}
{
  // 942 is a Koha-local field and must never reach the fill plan even if a
  // hand-built marcResult includes it.
  const { buildKohaFillPlan } = await import('../src/services/kohaMapper.js');
  const fakeResult = {
    fields: [{ tag: '942', indicators: [' ', ' '], subfields: [{ code: 'c', value: 'BOOK' }] }],
    validation: { fields: { '942': { valid: true } } },
  };
  const plan = buildKohaFillPlan(fakeResult, { ddcApproval: {} });
  assert.strictEqual(plan.fields.find((f) => f.tag === '942'), undefined);
  assert.ok(plan.skipped.some((s) => s.tag === '942' && s.reason === 'koha_local_field_excluded'));
  console.log('  942 excluded from the fill plan as koha_local_field_excluded');
}
{
  // DDC not yet available (PENDING, no number reached) must NOT block
  // Fill MARC for the rest of an otherwise-good record -- there is no
  // separate "cataloguer approval" gate in this product. 082 is simply
  // absent from the fill plan; every other field still fills normally.
  const result = generateMarcRecord({ metadata: baseMetadata, ddc_approval: { ai_recommended_ddc: '020', approval_status: 'PENDING' } }, { now: new Date('2026-08-22T12:34:56Z') });
  assert.strictEqual(result.validation.valid, true, JSON.stringify(result.validation.errors));
  assert.ok(result.koha_fill, 'a record with every other field valid must still produce a fill plan without a DDC number yet');
  assert.strictEqual(result.koha_fill.fields.find((f) => f.tag === '082'), undefined);
  assert.ok(result.koha_fill.fields.find((f) => f.tag === '245'), '245 and other evidenced fields must still fill');
  console.log('  PENDING approval: fill plan still produced, just without 082');
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
  // 100$a (main author, surname-first) and 100$e (relator term "author")
  // must both be generated and both actually written to the Koha DOM --
  // product spec: "Do not omit 100$e when the framework requires it."
  assert.ok(result.filled.some((f) => f.tag === '100' && f.subfield === 'a'));
  assert.ok(result.filled.some((f) => f.tag === '100' && f.subfield === 'e'));
  assert.strictEqual(readSubfieldValue(doc, '100', 'a'), 'Cataloguer, Jane');
  assert.strictEqual(readSubfieldValue(doc, '100', 'e'), 'author');

  assert.strictEqual(readSubfieldValue(doc, '245', 'a'), 'Introduction to Library and Information Science /');

  // 260$a/$b/$c (publication place/publisher/year) and 300$c (dimensions)
  // must actually land in the Koha DOM, not just the generated MARC record
  // -- product spec item H/Q explicitly calls this out as something to
  // verify end-to-end against the real DOM, not just assert in isolation.
  assert.ok(result.filled.some((f) => f.tag === '260' && f.subfield === 'a'));
  assert.ok(result.filled.some((f) => f.tag === '260' && f.subfield === 'b'));
  assert.ok(result.filled.some((f) => f.tag === '260' && f.subfield === 'c'));
  assert.strictEqual(readSubfieldValue(doc, '260', 'b'), 'Example Press,');
  assert.strictEqual(readSubfieldValue(doc, '260', 'c'), '2024.');
  assert.ok(result.filled.some((f) => f.tag === '300' && f.subfield === 'c'));
  assert.strictEqual(readSubfieldValue(doc, '300', 'c'), '24 cm.');
  assert.strictEqual(saveClicked.value, false, 'fill must never trigger the Save button');
  console.log('  first fill: all mappable fields filled (including 260 place/publisher/year and 300 dimensions), DOM read-back matches, Save never clicked');

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
  const container245 = doc.querySelector('.tag[id^="tag_245_"]');
  const row245a = Array.from(container245.querySelectorAll('.subfield_line')).find(
    (row) => row.querySelector('input[name*="_code_"]')?.value === 'a'
  );
  const titleInput = row245a.querySelector('input.input_marceditor, textarea.input_marceditor');
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

  const values650 = readAllSubfieldValues(doc, '650', 'a');
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

console.log('\n== extension engine: 650 subject cap -- max 7, and every one of those 7 must actually land in the Koha DOM ==');
{
  // 650 is capped at 7 (product spec: "Generate MAXIMUM 7 subject
  // headings"). Feed more candidates than that and confirm exactly 7 are
  // generated, exactly 7 reach the fill plan, and all 7 (not fewer) are
  // actually verified present in the Koha DOM -- none silently dropped
  // between generation and the DOM write.
  const manySubjects = Array.from({ length: 14 }, (_, i) => `Subject heading ${i + 1}`);
  const expectedSubjects = manySubjects.slice(0, 7);
  const marcResult = generateMarcRecord(
    { metadata: { ...baseMetadata, subjects: manySubjects }, ddc_approval: approvedDdc() },
    { now: new Date('2026-08-22T12:34:56Z') }
  );
  const generated650 = marcResult.fields.filter((f) => f.tag === '650');
  assert.strictEqual(generated650.length, 7, 'no more than 7 subject headings may be generated');
  const planned650 = marcResult.koha_fill.fields.filter((f) => f.tag === '650');
  assert.strictEqual(planned650.length, 7, 'the fill plan must carry all 7 generated 650s, none dropped en route to Koha');

  const doc = buildKohaEditorFixture(); // starts with a single empty 650 row
  const result = engine.runKohaFill(doc, marcResult.koha_fill, { ddcApproved: true });
  const filledOrPresent650 = result.filled.filter((f) => f.tag === '650').length + result.already_present.filter((f) => f.tag === '650').length;
  assert.strictEqual(filledOrPresent650, 7, `AutoCat must report exactly 7 650 fields handled, got ${filledOrPresent650}: ${JSON.stringify(result.failed)}`);
  assert.strictEqual(result.failed.filter((f) => f.tag === '650').length, 0, 'no 650 write should fail');

  // The mandatory DOM re-verification step (spec: "the backend result is
  // not enough" -- inspect the actual DOM, not just AutoCat's own report).
  const actualDomValues = readAllSubfieldValues(doc, '650', 'a');
  assert.deepStrictEqual(new Set(actualDomValues), new Set(expectedSubjects), 'the 7 generated 650 values must actually be present in the Koha DOM, verified by reading it back');
  assert.strictEqual(actualDomValues.length, 7, `Koha DOM must contain exactly 7 650 rows, found ${actualDomValues.length}`);
  console.log(`  PASS: 14 candidate subjects -> 7 generated 650 fields -> 7 in the fill plan -> 7 actually verified present in the Koha DOM`);
}

console.log('\n== extension engine: large repeatable-field count (700) -- N generated must mean N inserted, none dropped ==');
{
  // 700 (additional personal-name entries) has no count cap -- unlike 650,
  // every genuinely distinct contributor must survive. This exercises the
  // same "N generated must mean N inserted" DOM-integrity guarantee 650 has
  // above, on a field that is never truncated.
  const manyEditors = Array.from({ length: 14 }, (_, i) => `Editor Surname${i + 1}, First${i + 1}`);
  const marcResult = generateMarcRecord(
    { metadata: { ...baseMetadata, editors: manyEditors }, ddc_approval: approvedDdc() },
    { now: new Date('2026-08-22T12:34:56Z') }
  );
  const generated700 = marcResult.fields.filter((f) => f.tag === '700');
  assert.strictEqual(generated700.length, manyEditors.length, 'every distinct contributor must produce its own 700 field, no cap');
  const planned700 = marcResult.koha_fill.fields.filter((f) => f.tag === '700');
  assert.strictEqual(planned700.length, manyEditors.length, 'the fill plan must carry every generated 700, none dropped en route to Koha');

  const doc = buildKohaEditorFixture();
  const result = engine.runKohaFill(doc, marcResult.koha_fill, { ddcApproved: true });
  const filledOrPresent700 = result.filled.filter((f) => f.tag === '700').length + result.already_present.filter((f) => f.tag === '700').length;
  assert.strictEqual(filledOrPresent700, manyEditors.length, `AutoCat must report exactly ${manyEditors.length} 700 fields handled, got ${filledOrPresent700}: ${JSON.stringify(result.failed)}`);
  assert.strictEqual(result.failed.filter((f) => f.tag === '700').length, 0, 'no 700 write should fail');

  const actualDomValues700 = readAllSubfieldValues(doc, '700', 'a');
  assert.strictEqual(actualDomValues700.length, manyEditors.length, `Koha DOM must contain exactly ${manyEditors.length} 700 rows, found ${actualDomValues700.length}`);
  console.log(`  PASS: ${manyEditors.length} generated 700 fields -> ${planned700.length} in the fill plan -> ${actualDomValues700.length} actually verified present in the Koha DOM`);
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
  assert.strictEqual(readSubfieldValue(doc, '082', 'a'), '', '082 must remain empty when DDC approval is not confirmed');
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
  const saveButton = doc.querySelector('#saverecord');
  assert.ok(engine.isSaveElement(saveButton), 'the fixture Save button must be recognized as a save element');
  const ordinaryInput = doc.querySelector('.tag[id^="tag_245_"] input.input_marceditor, .tag[id^="tag_245_"] textarea.input_marceditor');
  assert.strictEqual(engine.isSaveElement(ordinaryInput), false);
  console.log('  isSaveElement distinguishes the Save button from ordinary MARC value inputs');
}

console.log('\n== extension engine: detectFields ==');
{
  const doc = buildKohaEditorFixture({ existing650: ['Library science', 'Cataloging'] });
  const tags = engine.detectFields(doc);
  assert.deepStrictEqual(tags, [...new Set(tags)].sort(), 'detectFields must return sorted, deduplicated tags');
  for (const expected of ['000', '005', '008', '020', '040', '082', '100', '245', '250', '300', '650']) {
    assert.ok(tags.includes(expected), `expected detectFields to report ${expected}, got ${tags.join(',')}`);
  }
  assert.ok(!tags.includes('662'), 'detectFields must not report a tag with no DOM row on the page');
  console.log(`  detected ${tags.length} distinct tags from the fixture DOM: ${tags.join(', ')}`);
}

console.log('\nAll P4 Koha fill tests passed.');
