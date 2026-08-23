import assert from 'assert';
import { classifyLiteraryWork, validateClassificationAgainstWorkType } from '../src/services/literaryDdc.js';
import { generateDdcCandidates, buildRecommendation } from '../src/services/ddcCandidateService.js';
import { recommendDdc } from '../src/services/ddcClassificationService.js';
import { findBundledClass } from '../src/services/ddcKnowledgeBase.js';

// ---------------------------------------------------------------------
// THE reported bug: Wuthering Heights must never be classified as 025
// "Library operations" (or 020, or any main class). Metadata deliberately
// includes the exact kind of boilerplate ("Includes bibliographical
// references and index") that triggered the original bug, plus a
// misleading reprint publish_date (2003) for a book first published in
// 1847 -- both must be handled correctly.
// ---------------------------------------------------------------------
const wutheringHeights = {
  title: 'Wuthering Heights',
  authors: ['Emily Brontë'],
  publisher: 'Penguin Classics',
  publish_date: '2003',
  edition: 'Penguin Classics reprint edition',
  language: 'eng',
  description:
    "Emily Brontë's only novel, first published in 1847 under the pseudonym Ellis Bell, is a wild, passionate story of the intense and almost demonic love between Catherine Earnshaw and Heathcliff. Includes bibliographical references and index.",
  subjects: ['Gothic fiction', 'Yorkshire (England) -- Fiction', 'Domestic fiction', 'Brontë family'],
};

let d = await recommendDdc(wutheringHeights);
assert.strictEqual(d.recommended_ddc.number, '823.8', `Wuthering Heights must classify as 823.8, got ${d.recommended_ddc.number}`);
assert.strictEqual(d.work_type, 'FICTION');
assert.notStrictEqual(d.recommended_ddc.number, '025');
assert.notStrictEqual(d.recommended_ddc.number, '020');
assert.ok(!/^\d00$/.test(d.recommended_ddc.number), 'must never be a bare main class');
assert.deepStrictEqual(d.classification_path, ['800', '820', '823', '823.8']);
assert.strictEqual(d.number_breakdown.length, 4);
assert.strictEqual(d.number_breakdown[3].number, '823.8');
assert.ok(/Victorian/i.test(d.number_breakdown[3].label));
assert.strictEqual(d.recommended_ddc.confidence, 'HIGH');
assert.ok(/fiction/i.test(d.justification) && /English/i.test(d.justification));
// The justification is allowed to name "library science" as a contrast
// (per the product spec's own example wording, "...rather than library and
// information science") -- what must never happen is the number itself
// being 020/025 (already asserted above).

// Directly exercises the exact adversarial case: library-science trigger
// words stuffed alongside the literary evidence must not hijack the result.
d = await recommendDdc({
  ...wutheringHeights,
  description: wutheringHeights.description + ' This edition includes a library reference catalog circulation guide appendix.',
});
assert.strictEqual(d.recommended_ddc.number, '823.8', 'adversarial library-science keywords must not override literary classification');

// ---------------------------------------------------------------------
// Generalization: the pipeline must not be Wuthering-Heights-specific.
// ---------------------------------------------------------------------

// Weak evidence: no explicit first-published year, no language field --
// must still land in Literature/fiction, never invent a period digit.
let weak = classifyLiteraryWork({ title: 'A Minor Novel', subjects: ['Fiction'] });
assert.ok(weak);
assert.strictEqual(weak.form, 'fiction');
assert.strictEqual(weak.number, weak.base_number, 'no period evidence -> must not invent a decimal');
assert.ok(!weak.number.includes('.'));
assert.notStrictEqual(weak.confidence, 'HIGH');

// American fiction, explicitly identified as such -- base number only
// (no invented period table for American literature).
let american = classifyLiteraryWork({
  title: 'A Great American Novel',
  language: 'eng',
  description: 'A landmark of American literature exploring the American Dream.',
  subjects: ['American fiction'],
});
assert.strictEqual(american.number, '813');
assert.strictEqual(american.language_block, 'american_english');

// Poetry and drama both resolve to Literature, not a subject-domain guess.
let poetry = classifyLiteraryWork({ title: 'Collected Poems', subjects: ['Poetry'], language: 'eng' });
assert.strictEqual(poetry.form, 'poetry');
assert.strictEqual(poetry.base_number, '821');

let drama = classifyLiteraryWork({ title: 'Three Plays', subjects: ['Drama'], language: 'eng' });
assert.strictEqual(drama.form, 'drama');
assert.strictEqual(drama.base_number, '822');

// A book that is not fiction/poetry/drama at all -- classifyLiteraryWork
// must return null so the non-fiction pipeline runs instead.
assert.strictEqual(classifyLiteraryWork({ title: 'Introduction to Library Science', description: 'Librarianship and cataloging.' }), null);

// ---------------------------------------------------------------------
// Validation guard: never display a number outside 800 for an identified
// literary work, and never a bare main class for anyone.
// ---------------------------------------------------------------------
assert.strictEqual(validateClassificationAgainstWorkType('025', { form: 'fiction', language_label: 'English' }).valid, false);
assert.strictEqual(validateClassificationAgainstWorkType('823.8', { form: 'fiction', language_label: 'English' }).valid, true);
assert.strictEqual(validateClassificationAgainstWorkType('300', null).valid, false, 'bare main class always invalid');
assert.strictEqual(validateClassificationAgainstWorkType('370', null).valid, true);

// ---------------------------------------------------------------------
// Chatbot-driven reclassification hooks: excluded_ddc and form_hint.
// ---------------------------------------------------------------------
let excluded = generateDdcCandidates(
  { title: 'Principles of Business Management', description: 'Corporate planning, leadership, organization, and general management practices.', excluded_ddc: ['658'] }
);
assert.ok(!excluded.candidates.find((c) => c.number === '658'), 'excluded_ddc must remove the rejected number from candidates');

let hinted = classifyLiteraryWork({ title: 'Ambiguous Title', description: 'A general description with no obvious genre words.', form_hint: 'fiction', language: 'eng' });
assert.ok(hinted, 'an explicit cataloguer form_hint must be authoritative even without textual genre evidence');
assert.strictEqual(hinted.form, 'fiction');

// ---------------------------------------------------------------------
// Regression: real library-operations content must still classify
// correctly -- the fix must not suppress genuine 025/020 results, only
// stop incidental keyword matches (like boilerplate "references") from
// producing them for unrelated books.
// ---------------------------------------------------------------------
d = await recommendDdc({
  title: 'Library Operations',
  description: 'Cataloging, acquisitions, circulation, reference service, serials control, and discovery workflows.',
  table_of_contents: ['Acquisitions', 'Cataloging', 'Circulation', 'Reference services'],
});
assert.strictEqual(d.recommended_ddc.number, '025');

console.log('P7 literary DDC classification tests passed');
