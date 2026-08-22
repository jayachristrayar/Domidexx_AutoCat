import assert from 'assert';
import { generateMarcRecord, isValidIsbn, normalizeIsbn, buildApproved082 } from '../src/services/marcPipeline.js';

const base = {
  isbn: '978-0-141-43951-8',
  title: 'Introduction to Library and Information Science',
  authors: ['Jane Cataloguer'],
  edition: 'Second edition',
  publisher: 'Example Press',
  publish_date: '2024',
  language: 'eng',
  description: 'A whole-book introduction to library and information science.',
  subjects: ['Library science'],
  bibliography_note: 'Includes bibliographical references.',
  notes: ['Includes index.'],
  awards: ['Library Award shortlist.'],
  urls: ['https://example.org/book'],
  physical_description: { pages: '240', dimensions: '24 cm' },
};

assert.ok(isValidIsbn('9780141439518')); 
assert.strictEqual(normalizeIsbn('0-141-43951-3'), '9780141439518');

let result = generateMarcRecord({ metadata: base, ddc_approval: { ai_recommended_ddc: '020', approval_status: 'PENDING' } }, { now: new Date('2026-08-22T12:34:56Z') });
assert.strictEqual(result.validation.valid, false);
assert.ok(!result.fields.find((f) => f.tag === '082'));
assert.ok(result.validation.errors.find((e) => e.code === 'DDC_NOT_APPROVED'));

result = generateMarcRecord({ metadata: base, ddc_approval: { ai_recommended_ddc: '020', approved_ddc: '020', approval_status: 'APPROVED' } }, { now: new Date('2026-08-22T12:34:56Z') });
assert.strictEqual(result.validation.valid, true, JSON.stringify(result.validation.errors));
const f020 = result.fields.find((f) => f.tag === '020');
const f082 = result.fields.find((f) => f.tag === '082');
assert.strictEqual(f020.subfields.find((sf) => sf.code === 'a').value, '9780141439518');
assert.strictEqual(f082.subfields.find((sf) => sf.code === 'a').value, '020');
assert.notStrictEqual(f020.subfields.find((sf) => sf.code === 'a').value, f082.subfields.find((sf) => sf.code === 'a').value);
assert.strictEqual(f082.provenance, 'CATALOGUER_APPROVED');
assert.ok(result.preview.find((row) => row.tag === '082' && row.value.includes('$a 020')));
assert.strictEqual(result.marc_record.controlFields.find((f) => f.tag === '005').value, '20260822123456.0');
for (const tag of ['100','245','250','260','300','041','500','504','520','586','650','856']) assert.ok(result.marc_record.dataFields.find((f) => f.tag === tag), tag);

result = generateMarcRecord({ metadata: base, ddc_approval: { ai_recommended_ddc: '020', approved_ddc: '025', approval_status: 'APPROVED' } });
assert.strictEqual(result.fields.find((f) => f.tag === '082').subfields.find((sf) => sf.code === 'a').value, '025');
assert.strictEqual(result.validation.valid, true);

assert.strictEqual(buildApproved082({ approval_status: 'APPROVED', approved_ddc: '999.999' }).ok, false);
assert.strictEqual(buildApproved082({ approval_status: 'APPROVED', approved_ddc: '024' }).ok, false);
result = generateMarcRecord({ metadata: { ...base, isbn: '123' }, ddc_approval: { approval_status: 'APPROVED', approved_ddc: '020' } });
assert.strictEqual(result.validation.valid, false);
assert.ok(result.validation.errors.find((e) => e.code === 'INVALID_ISBN' || e.code === 'INVALID_020_ISBN'));

result = generateMarcRecord({ metadata: { ...base, sources: { a: { publisher: 'ABC' }, b: { publisher: 'XYZ' } } }, sources: { a: { publisher: 'ABC' }, b: { publisher: 'XYZ' } }, ddc_approval: { approval_status: 'APPROVED', approved_ddc: '020' } });
assert.ok(result.conflicts.find((c) => c.field === 'publisher'));
console.log('P3 MARC pipeline tests passed');
