// One-off data-fix script (run manually, not part of the request path):
// corrects the placeholder form-subdivision labels for the American (810)
// and English (820) literature blocks in rules/ddc_classes.json, and adds
// the English-literature historical-period subdivisions (821.1-829.9)
// needed by literaryDdc.js. See that file's header comment for where this
// table structure comes from (DDC 23's own published class structure).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'rules', 'ddc_classes.json');
const classes = JSON.parse(fs.readFileSync(file, 'utf8'));
const byNumber = new Map(classes.map((c) => [c.number, c]));

const FORM_LABEL = {
  1: 'poetry',
  2: 'drama',
  3: 'fiction',
  4: 'essays',
  5: 'speeches',
  6: 'letters',
  7: 'satire & humor',
  8: 'miscellaneous writings',
};

const ENGLISH_LABEL_PREFIX = { 810: 'American', 820: 'English' };

for (const base of [810, 820]) {
  for (const digit of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const number = String(base + digit);
    const row = byNumber.get(number);
    if (row) row.label = `${ENGLISH_LABEL_PREFIX[base]} ${FORM_LABEL[digit]}`;
  }
}
// 819/829 are not standard form-subdivision slots (829 is reserved for Old
// English/Anglo-Saxon literature, 819 has no standard DDC 23 assignment) --
// leave their existing rows untouched rather than guess.
const oldEnglish = byNumber.get('829');
if (oldEnglish) oldEnglish.label = 'Old English (Anglo-Saxon) literature';

const ENGLISH_PERIODS = [
  { digit: '1', label: 'Old English (Anglo-Saxon) period' },
  { digit: '2', label: 'Middle English period' },
  { digit: '3', label: 'Elizabethan & early Stuart (Renaissance) period' },
  { digit: '4', label: 'Restoration period' },
  { digit: '5', label: 'Augustan / early 18th-century period' },
  { digit: '6', label: 'Later 18th-century period' },
  { digit: '7', label: 'Romantic period' },
  { digit: '8', label: 'Victorian period' },
  { digit: '9', label: '20th-century and later' },
];

let added = 0;
for (const formDigit of [1, 2, 3]) {
  // 821 poetry, 822 drama, 823 fiction -- the three forms AutoCat's
  // literaryDdc.js currently classifies into.
  const base = 820 + formDigit;
  const formLabel = FORM_LABEL[formDigit];
  for (const period of ENGLISH_PERIODS) {
    const number = `${base}.${period.digit}`;
    if (byNumber.has(number)) continue;
    const row = { number, label: `English ${formLabel} — ${period.label}`, status: 'ASSIGNED', source: 'project_supplied_ddc_reference' };
    classes.push(row);
    byNumber.set(number, row);
    added += 1;
  }
}

classes.sort((a, b) => Number(a.number) - Number(b.number) || a.number.localeCompare(b.number));
fs.writeFileSync(file, JSON.stringify(classes, null, 2) + '\n');
console.log(`Updated labels for 810-818/820-828 and 829; added ${added} English-literature period subdivisions.`);
