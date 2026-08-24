import assert from 'assert';
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/autocat_test_placeholder';

const { classifyLiteraryWork } = await import('../src/services/literaryDdc.js');
const { generateMarcRecord } = await import('../src/services/marcPipeline.js');

// Regression coverage for the "end-to-end MARC completeness" bug report:
// Fill MARC stuck disabled, 082/440 missing, 260$a falling back to
// [S.l.] even with real place evidence, and web evidence (description/
// subjects/series/editors) not reaching the generated MARC fields.

// -- Bug: a nonfiction book ABOUT theatre/performance (subject heading
// "Theatre") was being misclassified as literary DRAMA (DDC 822.9) because
// literaryDdc.js's DRAMA_RE matched the bare word "theatre" in a subject
// heading, even though "theatre" there names a discipline/subject area, not
// the book's own literary form. Fixed by dropping theatre/theater from
// DRAMA_RE (drama/play(s) remain, since those far more specifically name
// the literary form itself).
console.log('== literaryDdc: "Theatre" subject must not trigger drama misclassification ==');
const notLiterary = classifyLiteraryWork({
  title: 'Practice Research through Creative Bodies',
  subtitle: 'Perspectives on Embodied Inquiry',
  subjects: ['Performance Studies', 'Practice Research', 'Dance', 'Theatre', 'Embodied cognition'],
  description: 'A scholarly volume on embodied and practice-based research methods in dance, theatre, and performance.',
});
assert.strictEqual(notLiterary, null, 'a nonfiction book about theatre/performance must not be classified as literary drama');
console.log('  PASS: nonfiction work with a "Theatre" subject heading is not misclassified as drama');

// A genuine play/drama collection (evidence naming the FORM itself, not just
// the surrounding discipline) must still classify correctly.
const actualDrama = classifyLiteraryWork({
  title: 'Four Plays',
  subjects: ['English drama'],
  description: 'A collection of four plays by a contemporary British playwright.',
  language: 'eng',
});
assert.ok(actualDrama, 'an actual collection of plays must still classify as drama');
assert.strictEqual(actualDrama.form, 'drama');
console.log('  PASS: an actual play collection ("plays"/"drama" as the work\'s own form) still classifies correctly');

// -- Full end-to-end MARC generation for the reported ISBN's real evidence
// shape, DDC genuinely unavailable (matches this sandbox -- no AI provider
// configured). Fill MARC must still be enabled (validation.valid, a real
// koha_fill plan) -- there is no cataloguer-approval gate.
console.log('\n== Full MARC generation: DDC unavailable must not block the rest of the record ==');
const metadataNoDdc = {
  isbn: '9781032769226',
  title: 'Practice Research through Creative Bodies',
  subtitle: 'Perspectives on Embodied Inquiry',
  editors: ['Caroline Frizell', 'Marina Rova'],
  publisher: 'Routledge',
  publication_place: 'London',
  publish_date: '2025-09-15',
  description:
    'This book explores practice research through creative and embodied bodies of inquiry, bringing together international contributors to examine how artistic and somatic practices generate knowledge in dance, theatre, and performance.',
  subjects: ['Performance Studies', 'Practice Research', 'Dance', 'Theatre', 'Embodied cognition', 'Creative practice', 'Arts-based research'],
  physical_description: { pages: 208, dimensions: null },
};

const marcNoDdc = generateMarcRecord({ metadata: metadataNoDdc, ddc_approval: {} });
assert.strictEqual(marcNoDdc.validation.valid, true, 'a genuinely-missing DDC must not fail validation');
assert.strictEqual(marcNoDdc.status, 'READY_FOR_KOHA');
assert.ok(marcNoDdc.koha_fill, 'koha_fill plan must exist once validation passes');
assert.ok(marcNoDdc.koha_fill.fields.length > 0, 'Fill MARC must have a real plan to write -- this is what the UI checks to enable the button');
assert.ok(
  marcNoDdc.validation.info.some((i) => i.tag === '082' && i.code === 'DDC_NOT_AVAILABLE'),
  '082-unavailable must be reported as info, never an error'
);
assert.ok(!marcNoDdc.validation.errors.length, JSON.stringify(marcNoDdc.validation.errors));
console.log('  PASS: validation.valid=true, status=READY_FOR_KOHA, koha_fill has a real plan -- Fill MARC would be enabled');

function fieldValue(marc, tag, code = 'a') {
  const field = marc.fields.find((f) => f.tag === tag);
  return field?.subfields?.find((sf) => sf.code === code)?.value ?? null;
}

// Web evidence (description/subjects/place/publisher/editors) must actually
// reach the generated fields -- not just exist somewhere in the pipeline.
assert.strictEqual(fieldValue(marcNoDdc, '020'), '9781032769226');
assert.ok(fieldValue(marcNoDdc, '245').startsWith('Practice Research through Creative Bodies'));
assert.strictEqual(fieldValue(marcNoDdc, '245', 'c'), 'edited by Caroline Frizell and Marina Rova.');
assert.strictEqual(fieldValue(marcNoDdc, '260'), 'London :');
assert.strictEqual(fieldValue(marcNoDdc, '260', 'b'), 'Routledge,');
assert.strictEqual(fieldValue(marcNoDdc, '260', 'c'), '2025.');
assert.strictEqual(fieldValue(marcNoDdc, '300'), '208 p.');
assert.ok(fieldValue(marcNoDdc, '520').includes('practice research through creative and embodied bodies'));
const subjects650 = marcNoDdc.fields.filter((f) => f.tag === '650').map((f) => f.subfields[0].value);
assert.deepStrictEqual(subjects650, ['Performance Studies', 'Practice Research', 'Dance', 'Theatre', 'Embodied cognition', 'Creative practice', 'Arts-based research']);
const editors700 = marcNoDdc.fields.filter((f) => f.tag === '700').map((f) => f.subfields[0].value);
assert.deepStrictEqual(editors700, ['Frizell, Caroline', 'Rova, Marina']);
assert.ok(marcNoDdc.fields.every((f) => f.tag !== '700' || f.subfields.some((sf) => sf.code === 'e' && sf.value === 'editor')));
// No 100: per this project's own encoded AACR2 21.7B rule (rules/shared/
// isbd_and_entry_rules.json), an editor of a multi-contributor edited
// volume is never the 1xx main entry -- entry stays under title, editors
// as 700 added entries (exactly what's asserted above).
assert.ok(!marcNoDdc.fields.some((f) => f.tag === '100'), '100 must not be fabricated for an editor-only edited volume (AACR2 21.7B)');
console.log('  PASS: 020/245/260/300/520/650/700 all carry the real researched evidence, and 100 correctly stays absent per AACR2 21.7B');

// -- 260$a must never fall back to [S.l.] when place evidence exists.
assert.notStrictEqual(fieldValue(marcNoDdc, '260'), '[S.l.] :');
console.log('  PASS: 260$a uses the real researched place ("London :"), never [S.l.] when evidence exists');

// -- 440 (series) generated only when evidence exists, never fabricated.
console.log('\n== 440 series: generated when evidence exists, omitted (not fabricated) otherwise ==');
assert.ok(!marcNoDdc.fields.some((f) => f.tag === '440'), 'no series evidence for this book -- 440 must not be fabricated');
assert.ok(marcNoDdc.validation.info.some((i) => i.tag === '440' && i.code === 'NO_SERIES_EVIDENCE'));

const metadataWithSeries = { ...metadataNoDdc, series: 'Routledge Advances in Theatre & Performance Studies' };
const marcWithSeries = generateMarcRecord({ metadata: metadataWithSeries, ddc_approval: {} });
assert.strictEqual(fieldValue(marcWithSeries, '440'), 'Routledge Advances in Theatre & Performance Studies');
console.log('  PASS: 440$a is generated from real series evidence when a source supplies one');

// -- 082 generated (and Fill MARC still enabled with a bigger plan) once a
// DDC decision is actually approved -- the exact auto-accept shape
// ddcApprovalService.saveDdcDecision produces, never requiring a separate
// manual "cataloguer approval" action.
console.log('\n== Full MARC generation: 082 appears once DDC is available (auto-accepted, no manual approval) ==');
const approvedDdc = {
  approval_status: 'APPROVED',
  approved_ddc: '792',
  approved_by: 'system:auto_accepted',
};
const marcWithDdc = generateMarcRecord({ metadata: metadataNoDdc, ddc_approval: approvedDdc });
assert.strictEqual(marcWithDdc.validation.valid, true);
assert.strictEqual(marcWithDdc.status, 'READY_FOR_KOHA');
assert.strictEqual(fieldValue(marcWithDdc, '082'), '792');
assert.ok(marcWithDdc.koha_fill.fields.some((f) => f.tag === '082'));
assert.ok(
  marcWithDdc.koha_fill.fields.length > marcNoDdc.koha_fill.fields.length,
  'the fill plan must grow once 082 is available, never shrink or block'
);
console.log('  PASS: 082 present, status=READY_FOR_KOHA, koha_fill includes 082 -- no manual approval step anywhere');

console.log('\nAll P11 MARC-completeness regression tests passed.');
