// Fixture representing the Koha "basic" advanced MARC editor
// (cataloguing/addbiblio.pl) DOM shape that
// extension/src/content-scripts/kohaFillEngine.js targets.
//
// Unlike the fixture this replaced, this one is built from Koha's ACTUAL
// template source (koha-tmpl/intranet-tmpl/prog/en/modules/cataloguing/
// addbiblio.tt, fetched from Koha-Community/Koha master while diagnosing
// why field detection/filling failed on a real Koha page):
//
//   - Each field row: `<li class="tag clearfix" id="tag_<tag>_<idx><rnd>">`
//     with the tag number in `<span class="tagnum">`, NOT a hidden
//     `input[name="tag"]` (that never existed in real Koha markup).
//   - Indicator inputs: `name="tag_<tag>_indicator1_<idx><rnd>"` /
//     `..._indicator2_..."`, class `indicator flat` -- NOT
//     `name="indicator"`.
//   - Subfield rows: `<li class="subfield_line" id="subfield<tag><code><rnd>">`
//     with a code input `name="tag_<tag>_code_<code>_<idx>_<idx2>"
//     value="<code>"` -- NOT `name="subfield_code"`, and no
//     `subfield_<code>` class token.
//   - Value inputs/textareas: `class="input_marceditor"` (confirmed
//     correct in the version this replaced).
//   - Control fields (000/001/.../008): a `textarea.input_marceditor`
//     directly inside the `.tag` li, no subfield wrapper.
//   - Clone ("+") controls: `<a class="buttonPlus" onclick="...">`
//     (confirmed correct in the version this replaced).
//   - Save controls: e.g. `<button class="btn btn-primary" id="saverecord">`
//     -- caught by the engine's `[id*="save" i]` guard regardless of
//     element type.

import { MiniDocument, el } from './miniDom.js';

function controlFieldRow(tag, value, idx = 0) {
  return el('li', { class: 'tag clearfix', id: `tag_${tag}_${idx}rnd` }, [
    el('div', { class: 'tag_title' }, [el('span', { class: 'tagnum', text: tag })]),
    // Real Koha renders a hidden indicator1 input even for control fields.
    el('input', { name: `tag_${tag}_indicator1_${idx}rnd`, class: 'indicator flat', value: ' ' }),
    el('textarea', { name: `${tag}_value`, id: `mv_${tag}_${idx}`, class: 'input_marceditor', value: value ?? '' }),
  ]);
}

function subfieldLine(tag, code, value, idx, idxSub) {
  return el('li', { class: 'subfield_line', id: `subfield${tag}${code}${idx}rnd` }, [
    el('input', { name: `tag_${tag}_code_${code}_${idx}_${idxSub}`, value: code }),
    el('input', { name: `${tag}_${code}_value`, id: `mv_${tag}_${code}_${idx}`, class: 'input_marceditor', value: value ?? '' }),
  ]);
}

function fieldRow({ tag, ind1 = ' ', ind2 = ' ', subfields = [] }, idx = 0) {
  return el('li', { class: 'tag clearfix', id: `tag_${tag}_${idx}rnd` }, [
    el('div', { class: 'tag_title' }, [el('span', { class: 'tagnum', text: tag })]),
    el('input', { name: `tag_${tag}_indicator1_${idx}rnd`, class: 'indicator flat', value: ind1 }),
    el('input', { name: `tag_${tag}_indicator2_${idx}rnd`, class: 'indicator flat', value: ind2 }),
    el(
      'ol',
      { class: 'subfields_container' },
      subfields.map((sf, sfIdx) => subfieldLine(tag, sf.code, sf.value, idx, sfIdx))
    ),
  ]);
}

/**
 * Build a fixture Koha editor DOM. `overrides` lets a test pre-populate
 * specific existing values (e.g. an existing 650 the cataloguer already
 * typed) to exercise already_present/conflict handling.
 */
export function buildKohaEditorFixture({ existing650 = [''], existing700 = [''], saveClicked = { value: false } } = {}) {
  const doc = new MiniDocument();

  const saveButton = el('button', { class: 'btn btn-primary', id: 'saverecord', text: 'Save' });
  saveButton.addEventListener('click', () => {
    saveClicked.value = true;
  });

  let idx = 0;
  const next = () => idx++;

  // A repeatable field (650, 700, ...) is seeded with however many
  // occurrences the test wants, each with its own clone ("+") control on
  // the last one -- same real-Koha behavior for every repeatable tag, not
  // just 650.
  function repeatableFieldRows(tag, values, buildField) {
    return values.map((value, i, arr) => {
      const rowIdx = next();
      const row = buildField(value, rowIdx);
      if (i === arr.length - 1) {
        const subfieldRow = row.querySelector('.subfield_line');
        const plus = el('a', { class: 'buttonPlus', text: '+' });
        plus.addEventListener('click', () => {
          const container = row.parentElement; // form
          const newRow = buildField('', next());
          container.append(newRow);
        });
        subfieldRow.append(plus);
      }
      return row;
    });
  }

  const form = el('form', { id: 'f', name: 'f' }, [
    controlFieldRow('000', '', next()),
    controlFieldRow('005', '', next()),
    controlFieldRow('008', '', next()),
    fieldRow({ tag: '020', subfields: [{ code: 'a', value: '' }] }, next()),
    fieldRow({ tag: '040', subfields: [{ code: 'b', value: '' }, { code: 'e', value: '' }] }, next()),
    fieldRow({ tag: '082', ind1: '0', ind2: '4', subfields: [{ code: 'a', value: '' }, { code: '2', value: '' }] }, next()),
    fieldRow({ tag: '100', ind1: '1', subfields: [{ code: 'a', value: '' }] }, next()),
    fieldRow({ tag: '245', ind1: '0', ind2: '0', subfields: [{ code: 'a', value: '' }, { code: 'c', value: '' }] }, next()),
    fieldRow({ tag: '250', subfields: [{ code: 'a', value: '' }] }, next()),
    fieldRow({ tag: '300', subfields: [{ code: 'a', value: '' }] }, next()),
    ...repeatableFieldRows('650', existing650, (value, rowIdx) => fieldRow({ tag: '650', ind2: '0', subfields: [{ code: 'a', value }] }, rowIdx)),
    ...repeatableFieldRows('700', existing700, (value, rowIdx) => fieldRow({ tag: '700', ind1: '1', subfields: [{ code: 'a', value }] }, rowIdx)),
    saveButton,
  ]);

  doc.append(form);
  return doc;
}
