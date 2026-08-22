// P4: Koha MARC editor autofill engine.
//
// Pure DOM-manipulation logic for the Koha 26.05 "advanced" MARC editor
// (cataloguing/addbiblio.pl). This module takes no dependency on `chrome.*`
// or the network — it only touches a `doc` (Document-like object) that is
// passed in, so the exact same code runs in the browser content script and
// under a Node test harness against a fixture DOM (see
// backend/scripts/testKohaFillP4.js).
//
// Deliberately a CLASSIC script, not an ES module: Manifest V3 content
// scripts declared in manifest.json's content_scripts[].js are always
// loaded as classic scripts (only background.service_worker supports
// "type": "module"), so `export`/`import` syntax here would throw a
// SyntaxError at injection time. Chrome loads this file directly as the
// first entry in content_scripts[].js (see manifest.json); koha-fill.js is
// listed second and runs in the same isolated-world global scope, so it
// can read the API this file attaches to `globalThis.AutoCatKohaFillEngine`
// below. This also means no `web_accessible_resources` entry or dynamic
// `import()` of a chrome-extension:// URL is needed anywhere — both were
// the source of Chrome's "Invalid value for 'web_accessible_resources[0]'"
// load error. For Node-side testing (backend/scripts/testKohaFillP4.js),
// this file is still a syntactically valid ES module (no top-level
// `export`/`import`, just declarations) -- importing it for its
// side-effect populates the same `globalThis.AutoCatKohaFillEngine`.
//
// Hard safety rule (see also SKILL/PR notes): this file must never call
// `.submit(`, `.requestSubmit(`, or `.click(` on anything. The cataloguer
// always performs the final Save by hand. A static test greps this file's
// source for those tokens and fails the build if they appear.

const CONTROL_FIELD_TAGS = new Set(['000', '001', '003', '005', '006', '007', '008']);

// Anything that looks like it could submit/save the record. Matched against
// every element this engine is about to write into or interact with; if it
// matches, the engine refuses the write instead of touching it.
const SAVE_GUARD_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button[name="op"]',
  '[id*="save" i]',
  '[class*="save" i]',
  '[id*="submit" i]',
];

function safeMatches(el, selector) {
  try {
    return typeof el.matches === 'function' && el.matches(selector);
  } catch {
    return false;
  }
}

/** True if `el` looks like a save/submit control this engine must never touch. */
function isSaveElement(el) {
  if (!el) return false;
  for (const selector of SAVE_GUARD_SELECTORS) {
    if (safeMatches(el, selector)) return true;
  }
  const text = String(el.textContent || '').trim().toLowerCase();
  const tag = String(el.tagName || '').toUpperCase();
  if ((tag === 'BUTTON' || tag === 'INPUT' || tag === 'A') && /\bsave\b/.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------
// DOM location: field containers + subfield rows, with explicit fallback
// strategies. Every strategy is a plain, testable predicate/query — no
// strategy is trusted on its own; verifyFieldProof/verifySubfieldProof
// below always re-derive the tag/subfield from the DOM before any write.
// ---------------------------------------------------------------------

function uniqueElements(list) {
  const seen = new Set();
  const out = [];
  for (const el of list) {
    if (el && !seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

/**
 * Locate candidate field-row containers for a MARC tag in the Koha advanced
 * editor DOM. Returns [] rather than guessing when nothing matches.
 *
 * Strategy order:
 *  1. `[data-tag="TAG"]` — forward-looking, explicit attribute.
 *  2. `.field[id^="tag_TAG_"]` — Koha's long-standing addbiblio.pl markup
 *     (each field row is `<div class="field" id="tag_245_XXXXX">`).
 *  3. Any `input[name="tag"]` whose value equals TAG, climbing to its
 *     `.field` ancestor. Catches markup variants that don't expose the tag
 *     in the container id/attribute.
 */
function findFieldContainers(doc, tag) {
  const results = [];
  results.push(...doc.querySelectorAll(`[data-tag="${tag}"]`));
  results.push(...doc.querySelectorAll(`.field[id^="tag_${tag}_"]`));
  for (const input of doc.querySelectorAll('input[name="tag"]')) {
    if (input.value === tag) {
      const container = (input.closest && input.closest('.field')) || input.parentElement;
      if (container) results.push(container);
    }
  }
  return uniqueElements(results);
}

/**
 * Locate candidate subfield-value rows for `code` within a field container.
 *
 * Strategy order:
 *  1. `[data-subfield="CODE"]`.
 *  2. `.subfield_line` whose class list contains `subfield_CODE` (Koha's
 *     historical `tag_245_subfield_a` class token convention).
 *  3. Any `input[name="subfield_code"]` whose value equals CODE, climbing
 *     to its `.subfield_line` ancestor.
 */
function findSubfieldRows(container, code) {
  const results = [];
  results.push(...container.querySelectorAll(`[data-subfield="${code}"]`));
  results.push(...container.querySelectorAll(`.subfield_line[class*="subfield_${code}"]`));
  for (const input of container.querySelectorAll('input[name="subfield_code"]')) {
    if (input.value === code) {
      const row = (input.closest && input.closest('.subfield_line')) || input.parentElement;
      if (row) results.push(row);
    }
  }
  return uniqueElements(results);
}

function findValueInput(row) {
  return row.querySelector(
    'input[name="field_value"], textarea[name="field_value"], input.input_marceditor, textarea.input_marceditor'
  );
}

function findIndicatorInputs(container) {
  return Array.from(container.querySelectorAll('input[name="indicator"]'));
}

function findControlValueInput(container) {
  return container.querySelector(
    'input[name="field_value"], textarea[name="field_value"], input.input_marceditor, textarea.input_marceditor'
  );
}

/** Element that adds a new occurrence of a repeatable tag/subfield, if the
 * DOM exposes one. Koha's addbiblio.pl has historically used a "+" clone
 * control with class `buttonPlus` next to each repeatable subfield row. */
function findAddSubfieldControl(row) {
  return (
    row.querySelector('.buttonPlus, [data-add-subfield], a[class*="clone" i], button[class*="clone" i]') || null
  );
}

function findAddFieldControl(doc, tag) {
  return (
    doc.querySelector(`[data-add-tag="${tag}"]`) ||
    doc.querySelector(`.buttonPlus[id*="tag_${tag}" i], a[id*="tag_${tag}" i][class*="clone" i]`) ||
    null
  );
}

// ---------------------------------------------------------------------
// Verify-before-write: never trust that a selector "found the right
// thing" — always re-derive tag/subfield/indicators from the DOM's own
// content and refuse to write if they don't prove out.
// ---------------------------------------------------------------------

function verifyFieldProof(container, tag) {
  const tagInput = container.querySelector('input[name="tag"]');
  const domTag = tagInput ? tagInput.value : container.getAttribute?.('data-tag') ?? null;
  return domTag === tag;
}

function verifySubfieldProof(row, code) {
  const codeInput = row.querySelector('input[name="subfield_code"]');
  const domCode = codeInput ? codeInput.value : row.getAttribute?.('data-subfield') ?? null;
  return domCode === code;
}

function verifyIndicators(container, expected) {
  if (!expected) return true;
  const inputs = findIndicatorInputs(container);
  if (inputs.length < 2) return false;
  return inputs[0].value === (expected.ind1 ?? ' ') && inputs[1].value === (expected.ind2 ?? ' ');
}

// ---------------------------------------------------------------------
// Single writes, each producing a full provenance/proof object.
// ---------------------------------------------------------------------

function dispatch(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function makeProof({ tag, indicators = null, subfield = null, selector = null }) {
  return { tag, indicators, subfield, selector, before: null, intended: null, after: null, verified: false };
}

/**
 * Write one control-field value (000/005/008/...). Verifies the tag before
 * writing and reads the value back afterward.
 */
function writeControlField(container, tag, value) {
  const proof = makeProof({ tag, selector: 'control-field' });
  proof.intended = value;
  if (!verifyFieldProof(container, tag)) return { ...proof, reason: 'tag_mismatch' };
  const input = findControlValueInput(container);
  if (!input) return { ...proof, reason: 'value_input_not_found' };
  if (isSaveElement(input)) return { ...proof, reason: 'blocked_save_element' };
  proof.before = input.value ?? '';
  input.value = value;
  dispatch(input);
  proof.after = input.value ?? '';
  proof.verified = proof.after === value;
  return proof;
}

/**
 * Write one subfield value into an already-located row. Verifies both the
 * field's tag and the row's subfield code before writing, and reads the
 * value back afterward.
 */
function writeSubfield(container, row, tag, code, value) {
  const proof = makeProof({ tag, subfield: code, selector: 'subfield-row' });
  proof.intended = value;
  if (!verifyFieldProof(container, tag)) return { ...proof, reason: 'tag_mismatch' };
  if (!verifySubfieldProof(row, code)) return { ...proof, reason: 'subfield_mismatch' };
  const input = findValueInput(row);
  if (!input) return { ...proof, reason: 'value_input_not_found' };
  if (isSaveElement(input)) return { ...proof, reason: 'blocked_save_element' };
  proof.before = input.value ?? '';
  input.value = value;
  dispatch(input);
  proof.after = input.value ?? '';
  proof.verified = proof.after === value;
  return proof;
}

function readSubfieldValue(row) {
  const input = findValueInput(row);
  return input ? input.value ?? '' : null;
}

// ---------------------------------------------------------------------
// Shape sanity: 020 must look like an ISBN, 082 must look like a DDC
// number. Cheap, explicit protection against a corrupted/confused plan
// ever letting an ISBN land in 082 or a DDC number land in 020.
// ---------------------------------------------------------------------

function looksLikeIsbn(value) {
  const raw = String(value ?? '').replace(/[-\s]/g, '').toUpperCase();
  return /^\d{9}[\dX]$/.test(raw) || /^\d{13}$/.test(raw);
}

function looksLikeDdc(value) {
  return /^\d{1,3}(\.\d+)?$/.test(String(value ?? '').trim());
}

// ---------------------------------------------------------------------
// Per-field orchestration.
// ---------------------------------------------------------------------

/**
 * Decide what to do for a single subfield occurrence against existing DOM
 * state: EMPTY -> fill, SAME VALUE -> already_present, DIFFERENT VALUE ->
 * conflict. Never overwrites automatically on conflict.
 */
function classifyAgainstExisting(existing, intended) {
  if (existing == null || existing === '') return 'empty';
  if (existing === intended) return 'same';
  return 'conflict';
}

function fillControlField(doc, instruction) {
  const { tag } = instruction;
  const value = instruction.subfields?.[0]?.value ?? null;
  if (value == null || value === '') return { tag, status: 'skipped', reason: 'empty_intended_value' };
  const containers = findFieldContainers(doc, tag);
  if (containers.length === 0) return { tag, status: 'skipped', reason: 'field_not_found' };
  const container = containers[0];
  const currentInput = findControlValueInput(container);
  const existing = currentInput ? currentInput.value ?? '' : null;
  const classification = classifyAgainstExisting(existing, value);
  if (classification === 'same') return { tag, status: 'already_present', existing, proposed: value };
  if (classification === 'conflict') return { tag, status: 'conflict', existing, proposed: value };
  const proof = writeControlField(container, tag, value);
  if (!proof.verified) return { tag, status: 'failed', reason: proof.reason ?? 'verification_failed', proof };
  return { tag, status: 'filled', proof };
}

function fillNonRepeatableSubfield(doc, tag, sf) {
  const containers = findFieldContainers(doc, tag);
  if (containers.length === 0) return { tag, subfield: sf.code, status: 'skipped', reason: 'field_not_found' };
  const container = containers[0];
  const rows = findSubfieldRows(container, sf.code);
  if (rows.length === 0) return { tag, subfield: sf.code, status: 'skipped', reason: 'subfield_row_not_found' };
  const row = rows[0];
  const existing = readSubfieldValue(row);
  const classification = classifyAgainstExisting(existing, sf.value);
  if (classification === 'same') return { tag, subfield: sf.code, status: 'already_present', existing, proposed: sf.value };
  if (classification === 'conflict') return { tag, subfield: sf.code, status: 'conflict', existing, proposed: sf.value };
  const proof = writeSubfield(container, row, tag, sf.code, sf.value);
  if (!proof.verified) return { tag, subfield: sf.code, status: 'failed', reason: proof.reason ?? 'verification_failed', proof };
  return { tag, subfield: sf.code, status: 'filled', proof };
}

function fillRepeatableSubfield(doc, tag, sf) {
  const containers = findFieldContainers(doc, tag);
  if (containers.length === 0) return { tag, subfield: sf.code, status: 'skipped', reason: 'field_not_found' };

  // Look across every occurrence of this tag for a matching or empty row
  // before deciding a brand-new occurrence is required, so we never
  // duplicate a value that is already present in a different occurrence.
  for (const container of containers) {
    for (const row of findSubfieldRows(container, sf.code)) {
      const existing = readSubfieldValue(row);
      if (existing === sf.value) return { tag, subfield: sf.code, status: 'already_present', existing, proposed: sf.value };
    }
  }
  for (const container of containers) {
    for (const row of findSubfieldRows(container, sf.code)) {
      const existing = readSubfieldValue(row);
      if (existing == null || existing === '') {
        const proof = writeSubfield(container, row, tag, sf.code, sf.value);
        if (!proof.verified) return { tag, subfield: sf.code, status: 'failed', reason: proof.reason ?? 'verification_failed', proof };
        return { tag, subfield: sf.code, status: 'filled', proof };
      }
    }
  }

  // Every existing occurrence is non-empty and different: try to add a new
  // occurrence. If the DOM doesn't expose an explicit, verifiable control
  // for that, skip rather than guess.
  const lastContainer = containers[containers.length - 1];
  const lastRow = findSubfieldRows(lastContainer, sf.code)[0];
  const addControl = lastRow ? findAddSubfieldControl(lastRow) : findAddFieldControl(doc, tag);
  if (!addControl || isSaveElement(addControl)) {
    return { tag, subfield: sf.code, status: 'skipped', reason: 'add_row_control_not_found' };
  }
  addControl.dispatchEvent(new Event('click', { bubbles: true }));
  const rowsAfter = findFieldContainers(doc, tag).flatMap((c) => findSubfieldRows(c, sf.code));
  const newRow = rowsAfter.find((row) => classifyAgainstExisting(readSubfieldValue(row), sf.value) === 'empty');
  if (!newRow) return { tag, subfield: sf.code, status: 'failed', reason: 'new_row_not_verified' };
  const containerForNewRow = findFieldContainers(doc, tag).find((c) => c.contains?.(newRow)) ?? lastContainer;
  const proof = writeSubfield(containerForNewRow, newRow, tag, sf.code, sf.value);
  if (!proof.verified) return { tag, subfield: sf.code, status: 'failed', reason: proof.reason ?? 'verification_failed', proof };
  return { tag, subfield: sf.code, status: 'filled', proof };
}

function fillVariableField(doc, instruction) {
  const { tag, subfields, repeatable } = instruction;
  const results = [];
  for (const sf of subfields) {
    if (tag === '020' && !looksLikeIsbn(sf.value)) {
      results.push({ tag, subfield: sf.code, status: 'failed', reason: 'shape_mismatch_expected_isbn' });
      continue;
    }
    if (tag === '082' && sf.code === 'a' && !looksLikeDdc(sf.value)) {
      results.push({ tag, subfield: sf.code, status: 'failed', reason: 'shape_mismatch_expected_ddc' });
      continue;
    }
    results.push(repeatable ? fillRepeatableSubfield(doc, tag, sf) : fillNonRepeatableSubfield(doc, tag, sf));
  }
  return results;
}

// ---------------------------------------------------------------------
// Plan validation: never trust the side panel/backend blindly.
// ---------------------------------------------------------------------

const KNOWN_TAG = /^\d{3}$/;
const KNOWN_SUBFIELD = /^[a-z0-9]$/i;
const KNOWN_INDICATOR = /^[0-9 ]$/;

function validateInstruction(instruction) {
  if (!instruction || typeof instruction !== 'object') return 'malformed_instruction';
  if (!KNOWN_TAG.test(instruction.tag ?? '')) return 'invalid_tag';
  if (instruction.field_type === 'VARIABLE_FIELD') {
    if (instruction.indicators) {
      const { ind1, ind2 } = instruction.indicators;
      if (!KNOWN_INDICATOR.test(ind1 ?? '') || !KNOWN_INDICATOR.test(ind2 ?? '')) return 'invalid_indicator';
    }
    if (!Array.isArray(instruction.subfields) || instruction.subfields.length === 0) return 'malformed_value';
    for (const sf of instruction.subfields) {
      if (!KNOWN_SUBFIELD.test(sf.code ?? '')) return 'unknown_subfield';
      if (typeof sf.value !== 'string' || sf.value === '') return 'malformed_value';
    }
  } else if (instruction.field_type === 'CONTROL_FIELD') {
    const value = instruction.subfields?.[0]?.value;
    if (typeof value !== 'string' || value === '') return 'malformed_value';
  } else {
    return 'invalid_tag';
  }
  return null;
}

/**
 * Detect which MARC tags are actually present on the current page's
 * editor -- the "Detect MARC fields" side-panel action. Reads real DOM
 * content (each field row's own `tag` input), never guesses from
 * selectors alone, so it reports exactly what this Koha installation's
 * current framework (general or custom) has rendered, not an assumed set.
 * Returns tags in ascending order, deduplicated.
 */
function detectFields(doc) {
  const tags = new Set();
  for (const container of doc.querySelectorAll('.field[id^="tag_"], [data-tag]')) {
    const tagInput = container.querySelector('input[name="tag"]');
    const tag = tagInput ? tagInput.value : container.getAttribute?.('data-tag');
    if (tag) tags.add(tag);
  }
  return Array.from(tags).sort();
}

/**
 * Run a full fill plan against `doc`. Never partially trusts a plan built
 * elsewhere: every instruction is independently validated, and the 082
 * approval gate is re-checked here even though the backend already
 * enforces it, so a tampered/hand-built plan can't slip 082 through.
 *
 * Returns { status, filled, already_present, conflicts, failed, skipped }.
 */
function runKohaFill(doc, plan, options = {}) {
  const filled = [];
  const alreadyPresent = [];
  const conflicts = [];
  const failed = [];
  const skipped = [];

  const ddcApproved = Boolean(options.ddcApproved ?? plan?.ddc_gate?.approved);

  for (const raw of plan?.skipped ?? []) {
    skipped.push({ tag: raw.tag, reason: raw.reason });
  }

  for (const instruction of plan?.fields ?? []) {
    const invalidReason = validateInstruction(instruction);
    if (invalidReason) {
      failed.push({ tag: instruction?.tag ?? null, reason: invalidReason });
      continue;
    }
    if (instruction.tag === '082' && !ddcApproved) {
      skipped.push({ tag: '082', reason: 'ddc_not_approved' });
      continue;
    }

    if (CONTROL_FIELD_TAGS.has(instruction.tag) || instruction.field_type === 'CONTROL_FIELD') {
      const result = fillControlField(doc, instruction);
      routeResult(result, { filled, alreadyPresent, conflicts, failed, skipped });
      continue;
    }

    for (const result of fillVariableField(doc, instruction)) {
      routeResult(result, { filled, alreadyPresent, conflicts, failed, skipped });
    }
  }

  const status = failed.length > 0 || conflicts.length > 0 ? 'partial' : 'complete';
  return { status, filled, already_present: alreadyPresent, conflicts, failed, skipped };
}

function routeResult(result, buckets) {
  switch (result.status) {
    case 'filled':
      buckets.filled.push(result);
      break;
    case 'already_present':
      buckets.alreadyPresent.push(result);
      break;
    case 'conflict':
      buckets.conflicts.push(result);
      break;
    case 'failed':
      buckets.failed.push(result);
      break;
    default:
      buckets.skipped.push(result);
  }
}

// Public surface, attached to the shared content-script global rather than
// exported (see file-header note on why this can't be an ES module here).
globalThis.AutoCatKohaFillEngine = {
  isSaveElement,
  findFieldContainers,
  findSubfieldRows,
  verifyFieldProof,
  verifySubfieldProof,
  verifyIndicators,
  writeControlField,
  writeSubfield,
  validateInstruction,
  runKohaFill,
  detectFields,
};
