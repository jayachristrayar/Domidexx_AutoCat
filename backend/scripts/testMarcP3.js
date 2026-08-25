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

// DDC not yet available (PENDING, no number reached) must NOT block the
// rest of an otherwise-good MARC record -- there is no separate
// "cataloguer approval" gate in this product; 082 is simply omitted and
// reported as info, never a blocking validation error.
let result = generateMarcRecord({ metadata: base, ddc_approval: { ai_recommended_ddc: '020', approval_status: 'PENDING' } }, { now: new Date('2026-08-22T12:34:56Z') });
assert.strictEqual(result.validation.valid, true, JSON.stringify(result.validation.errors));
assert.strictEqual(result.status, 'READY_FOR_KOHA');
assert.ok(!result.fields.find((f) => f.tag === '082'));
assert.ok(!result.validation.errors.find((e) => e.code === 'DDC_NOT_APPROVED'));
assert.ok(result.validation.info.find((e) => e.code === 'DDC_NOT_AVAILABLE'));
assert.ok(result.koha_fill, 'a MARC record with every other field valid must still produce a Koha fill plan even without a DDC number yet');

result = generateMarcRecord({ metadata: base, ddc_approval: { ai_recommended_ddc: '020', approved_ddc: '020', approval_status: 'APPROVED' } }, { now: new Date('2026-08-22T12:34:56Z') });
assert.strictEqual(result.validation.valid, true, JSON.stringify(result.validation.errors));
const f020 = result.fields.find((f) => f.tag === '020');
const f082 = result.fields.find((f) => f.tag === '082');
assert.strictEqual(f020.subfields.find((sf) => sf.code === 'a').value, '9780141439518');
assert.strictEqual(f082.subfields.find((sf) => sf.code === 'a').value, '020');
assert.notStrictEqual(f020.subfields.find((sf) => sf.code === 'a').value, f082.subfields.find((sf) => sf.code === 'a').value);
assert.strictEqual(f082.provenance, 'CATALOGUER_APPROVED');
assert.ok(result.preview.find((row) => row.tag === '082' && row.value.includes('$a 020')));
// 000/005/008/942 are Koha/system-managed control fields -- AutoCat must
// never generate them, so they must never appear in fields/marc_record/preview.
assert.strictEqual(result.marc_record.controlFields.length, 0, JSON.stringify(result.marc_record.controlFields));
for (const tag of ['000', '005', '008', '942']) {
  assert.ok(!result.fields.find((f) => f.tag === tag), `${tag} must not be generated`);
  assert.ok(!result.preview.find((row) => row.tag === tag), `${tag} must not appear in the preview`);
}
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

// No publication_place evidence -- 260$a falls back to the AACR2 1.4C6
// bracketed placeholder (never a guessed place), and $c is year-only even
// though the source date is a bare "2024" (no month/day to strip here,
// but confirms the fallback path still produces a clean year).
result = generateMarcRecord({ metadata: base, ddc_approval: { approval_status: 'APPROVED', approved_ddc: '020' } });
let f260 = result.fields.find((f) => f.tag === '260');
assert.strictEqual(f260.subfields.find((sf) => sf.code === 'a').value, '[S.l.] :');
assert.strictEqual(f260.subfields.find((sf) => sf.code === 'c').value, '2024.');

// publication_place IS available (Open Library publish_places / a real LOC
// MARC 260$a / page evidence -- see isbnLookup.js) -- 260$a must use it,
// never the placeholder, and a full ISO publish_date ("2025-09-15", e.g.
// JSON-LD datePublished) must reduce to the year alone in $c, never the
// full date.
result = generateMarcRecord({
  metadata: { ...base, publication_place: 'London', publish_date: '2025-09-15' },
  ddc_approval: { approval_status: 'APPROVED', approved_ddc: '020' },
});
f260 = result.fields.find((f) => f.tag === '260');
assert.strictEqual(f260.subfields.find((sf) => sf.code === 'a').value, 'London :');
assert.strictEqual(f260.subfields.find((sf) => sf.code === 'c').value, '2025.');
assert.notStrictEqual(f260.subfields.find((sf) => sf.code === 'c').value, '2025-09-15.');

console.log('P3 MARC pipeline tests passed');
