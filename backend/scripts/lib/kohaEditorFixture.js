// Fixture representing the Koha "advanced" MARC editor (addbiblio.pl) DOM
// shape that extension/src/content-scripts/kohaFillEngine.js targets:
// each field is a `.field` div carrying a hidden `tag` input and two
// `indicator` inputs, with one `.subfield_line` per subfield carrying a
// `subfield_code` input and a `field_value` input/textarea. A `buttonPlus`
// clone control sits next to a repeatable subfield's last occurrence.
//
// NOTE: this fixture is built from Koha's long-standing, documented
// addbiblio.pl markup conventions (tag/subfield_code/field_value input
// names, .field/.subfield_line/.buttonPlus classes). It has not been
// diffed against a live Koha 26.05 instance -- see the P4 PR description
// for that caveat. kohaFillEngine.js's verify-before-write proof step is
// what makes it safe to run against a real instance even if some of this
// fixture's specific class names have drifted: it re-derives tag/subfield
// from the DOM before ever writing, and simply skips/fails a field it
// can't prove rather than guessing.

import { MiniDocument, el } from './miniDom.js';

function fieldRow({ tag, ind1 = ' ', ind2 = ' ', subfields = [] }) {
  const tagInput = el('input', { name: 'tag', value: tag });
  const indicators = [
    el('input', { name: 'indicator', value: ind1 }),
    el('input', { name: 'indicator', value: ind2 }),
  ];
  const subfieldRows = subfields.map((sf, idx) =>
    el(
      'div',
      { class: `subfield_line tag_${tag}_subfield_${sf.code}` },
      [
        el('input', { name: 'subfield_code', value: sf.code }),
        sf.tag === 'textarea'
          ? el('textarea', { name: 'field_value', value: sf.value ?? '', id: `tag_${tag}_subfield_${sf.code}_${idx}` })
          : el('input', { name: 'field_value', value: sf.value ?? '', id: `tag_${tag}_subfield_${sf.code}_${idx}` }),
      ]
    )
  );
  return el('div', { class: 'field', id: `tag_${tag}_000${subfields.length}` }, [
    tagInput,
    ...indicators,
    el('div', { class: 'subfields_container' }, subfieldRows),
  ]);
}

function controlFieldRow(tag, value) {
  return el('div', { class: 'field', id: `tag_${tag}_0000` }, [
    el('input', { name: 'tag', value: tag }),
    el('input', { name: 'field_value', value }),
  ]);
}

/**
 * Build a fixture Koha editor DOM. `overrides` lets a test pre-populate
 * specific existing values (e.g. an existing 650 the cataloguer already
 * typed) to exercise already_present/conflict handling.
 */
export function buildKohaEditorFixture({ existing650 = [''], saveClicked = { value: false } } = {}) {
  const doc = new MiniDocument();

  const saveButton = el('button', { type: 'submit', text: 'Save' });
  saveButton.addEventListener('click', () => {
    saveClicked.value = true;
  });

  const form = el('form', { id: 'addbiblioform' }, [
    controlFieldRow('000', ''),
    controlFieldRow('005', ''),
    controlFieldRow('008', ''),
    fieldRow({ tag: '020', subfields: [{ code: 'a', value: '' }] }),
    fieldRow({ tag: '040', subfields: [{ code: 'b', value: '' }, { code: 'e', value: '' }] }),
    fieldRow({ tag: '082', ind1: '0', ind2: '4', subfields: [{ code: 'a', value: '' }, { code: '2', value: '' }] }),
    fieldRow({ tag: '100', ind1: '1', subfields: [{ code: 'a', value: '' }] }),
    fieldRow({ tag: '245', ind1: '0', ind2: '0', subfields: [{ code: 'a', value: '' }, { code: 'c', value: '' }] }),
    fieldRow({ tag: '250', subfields: [{ code: 'a', value: '' }] }),
    fieldRow({ tag: '300', subfields: [{ code: 'a', value: '' }] }),
    // 650 is repeatable; seed however many occurrences the test wants, each
    // with its own clone ("+") control on the last one.
    ...existing650.map((value, idx, arr) => {
      const row = fieldRow({ tag: '650', ind2: '0', subfields: [{ code: 'a', value }] });
      if (idx === arr.length - 1) {
        const subfieldLine = row.querySelector('.subfield_line');
        const plus = el('a', { class: 'buttonPlus', text: '+' });
        plus.addEventListener('click', () => {
          const container = row.parentElement; // form
          const newRow = fieldRow({ tag: '650', ind2: '0', subfields: [{ code: 'a', value: '' }] });
          container.append(newRow);
        });
        subfieldLine.append(plus);
      }
      return row;
    }),
    saveButton,
  ]);

  doc.append(form);
  return doc;
}
