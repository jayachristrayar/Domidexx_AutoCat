import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildSkeleton } from '../src/services/marcBuilder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ruleProfile = JSON.parse(readFileSync(join(__dirname, '..', 'rules', 'rule_profile.json'), 'utf8'));

// --- Case 1: no LOC MARC data -- everything goes through mechanical
// construction. Modeled on a normalizedBiblioData result the way
// isbnLookup.js's mergeSources() would actually produce it (e.g. from
// Open Library + Google Books), with no Z39.50 hit.
const noLocResult = {
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
  description: 'One of the most popular novels in English literature.',
  subjects: ['Fiction', 'England -- Social life and customs'],
  series: null,
  sources: {
    z3950: null,
    libraryThing: null,
    openLibrary: { title: 'Pride and Prejudice' },
    googleBooks: { title: 'Pride and Prejudice' },
    loc_marc: false,
    method: 'structured',
  },
  conflicts: [],
};

// --- Case 2: LOC MARC data present for a couple of fields (020, 245) --
// mock Z39.50 result in z3950Lookup.js's internal { leader, fields }
// shape. 250/260/300/082/1xx/6xx/520/7xx are deliberately absent from the
// mock so those still get mechanically constructed / flagged for LLM
// drafting. The mocked 020/245 use formatting the mechanical builder would
// NOT have produced itself (different ISBN spacing convention, an
// abbreviation the mechanical 245 builder wouldn't add) specifically to
// prove passthrough is verbatim, not reconstructed/normalized.
const withLocResult = {
  isbn: '9780141439518',
  title: 'Pride and Prejudice',
  subtitle: null,
  authors: ['Jane Austen'],
  editors: ['Vivien Jones'],
  illustrators: [],
  translators: [],
  publisher: 'Penguin Classics',
  publish_date: '2003',
  edition: null,
  physical_description: { pages: 435, dimensions: null },
  description: null,
  subjects: [],
  series: null,
  sources: {
    z3950: {
      leader: '00000cam a2200000 a 4500',
      fields: [
        {
          tag: '020',
          indicators: '  ',
          subfields: [{ code: 'a', value: '9780141439518 (LOC-verbatim, not rebuilt)' }],
        },
        {
          tag: '100',
          indicators: '1 ',
          subfields: [{ code: 'a', value: 'Austen, Jane,' }, { code: 'd', value: '1775-1817.' }],
        },
        {
          tag: '245',
          indicators: '10',
          subfields: [
            { code: 'a', value: 'Pride and prejudice / [LOC-supplied field, verbatim]' },
            { code: 'c', value: 'Jane Austen.' },
          ],
        },
        {
          tag: '650',
          indicators: ' 0',
          subfields: [{ code: 'a', value: 'Man-woman relationships' }, { code: 'v', value: 'Fiction.' }],
        },
      ],
    },
    libraryThing: null,
    openLibrary: null,
    googleBooks: { publisher: 'Penguin Classics' },
    loc_marc: true,
    method: 'structured',
  },
  conflicts: [],
};

function printResult(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(`fields_from_loc: [${result.fields_from_loc.join(', ')}]`);
  console.log(`fields_needing_llm: [${result.fields_needing_llm.join(', ')}]`);
  console.log('skeleton:');
  console.log(JSON.stringify(result.skeleton, null, 2));
}

const case1 = buildSkeleton(noLocResult, ruleProfile);
const case2 = buildSkeleton(withLocResult, ruleProfile);

printResult('Case 1: no LOC MARC data (full mechanical path)', case1);
printResult('Case 2: LOC MARC data for 020/245/100/650 (passthrough)', case2);

console.log('\n--- assertions ---');
// Case 1: mechanically built, all five mechanical tags present via construction.
console.assert(
  case1.skeleton.find((f) => f.tag === '020').subfields[0].value === '9780141439518',
  'Case 1: 020 should be mechanically built from the ISBN'
);
console.assert(
  case1.fields_from_loc.length === 0,
  `Case 1: fields_from_loc should be empty, got [${case1.fields_from_loc}]`
);
console.assert(
  case1.fields_needing_llm.length === 5,
  `Case 1: all 5 LLM families should still be needed, got [${case1.fields_needing_llm}]`
);

// Case 2: LOC-supplied fields pass through verbatim (including the
// deliberately non-mechanical formatting), while 250/260/300 -- which LOC
// didn't supply -- are still mechanically constructed.
const case2_020 = case2.skeleton.find((f) => f.tag === '020');
const case2_245 = case2.skeleton.find((f) => f.tag === '245');
const case2_260 = case2.skeleton.find((f) => f.tag === '260');
console.assert(
  case2_020.subfields[0].value === '9780141439518 (LOC-verbatim, not rebuilt)',
  `Case 2: 020 should be the exact LOC value, got "${case2_020.subfields[0].value}"`
);
console.assert(
  case2_245.subfields[0].value.includes('[LOC-supplied field, verbatim]'),
  `Case 2: 245 should be the exact LOC value, got "${case2_245.subfields[0].value}"`
);
console.assert(
  case2_260 && case2_260.subfields.find((s) => s.code === 'a').value === '[S.l.] :',
  'Case 2: 260 should still be mechanically constructed (LOC did not supply it)'
);
console.assert(
  case2.fields_from_loc.includes('020') && case2.fields_from_loc.includes('245') &&
  case2.fields_from_loc.includes('100') && case2.fields_from_loc.includes('650'),
  `Case 2: fields_from_loc should list 020, 245, 100, 650, got [${case2.fields_from_loc}]`
);
console.assert(
  !case2.fields_needing_llm.includes('1xx') && !case2.fields_needing_llm.includes('6xx'),
  `Case 2: 1xx/6xx should be excluded from fields_needing_llm since LOC supplied them, got [${case2.fields_needing_llm}]`
);
console.assert(
  case2.fields_needing_llm.includes('082') && case2.fields_needing_llm.includes('520') && case2.fields_needing_llm.includes('7xx'),
  `Case 2: 082/520/7xx should still need LLM drafting, got [${case2.fields_needing_llm}]`
);
console.log('All assertions passed (no assertion failures printed above).');
