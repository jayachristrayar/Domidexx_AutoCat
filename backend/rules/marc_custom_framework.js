// "My Library" custom MARC framework -- the exact field set and subfields
// from the provided Koha custom-framework screenshots' text description.
//
// IMPORTANT CAVEAT (documented, not hidden): this session received the
// framework spec as text only -- no image/screenshot bytes were actually
// transmitted, so this file cannot literally "read pixels" off a
// screenshot. Where the request's text gave an explicit subfield list for
// a tag, that exact list is reproduced verbatim below (`subfields: [...]`)
// and nothing is added to it. For tags the request named as configured but
// did not spell out subfields for in text (e.g. 020, 040, 600, 700, 856's
// sibling entry-fields, etc.), this file falls back to the General MARC21
// definition for that tag's subfields, exactly as the request's own
// instructions permit: "Use the General MARC21 definition as the
// underlying reference where necessary, but preserve the Custom Framework
// configuration separately." Each such entry is marked
// `subfieldsSource: 'general_fallback'` (vs. `'explicit'`) so this is
// visible in the admin UI and API, not silently blended in. If the actual
// screenshots show a narrower subfield set for any `general_fallback`
// tag, an administrator should narrow it via the admin UI -- that's a
// data-entry correction, not a code change.

export const CUSTOM_LIBRARY_FRAMEWORK = {
  code: 'MY_LIBRARY',
  name: 'My Library Custom Framework',
  description: 'The library\'s configured cataloguing framework: only these fields/subfields are shown in the cataloguing form and offered to the AI pipeline.',
};

// tag -> { section, fieldRequired?, subfields: [{code, required?, default?}], subfieldsSource }
export const CUSTOM_FIELD_CONFIG = {
  // ---- Section 0 ----
  '000': { section: '0', fieldRequired: true, subfieldsSource: 'general' },
  '005': { section: '0', subfieldsSource: 'general' },
  '006': { section: '0', subfieldsSource: 'general' },
  '007': { section: '0', subfieldsSource: 'general' },
  '008': { section: '0', fieldRequired: true, subfieldsSource: 'general' },
  '020': { section: '0', subfieldsSource: 'general_fallback' },
  '024': { section: '0', subfieldsSource: 'general_fallback' },
  '037': { section: '0', subfieldsSource: 'general_fallback' },
  '040': { section: '0', subfieldsSource: 'general_fallback' },
  '041': { section: '0', subfieldsSource: 'general_fallback' },
  '050': { section: '0', subfieldsSource: 'general_fallback' },
  '074': { section: '0', subfieldsSource: 'general_fallback' },
  '082': { section: '0', subfieldsSource: 'general_fallback' },
  '086': { section: '0', subfieldsSource: 'general_fallback' },

  // ---- Section 1 ----
  '100': {
    section: '1', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Personal name' },
      { code: 'd', label: 'Dates associated with a name' },
      { code: 'e', label: 'Relator term' },
      { code: 'q', label: 'Fuller form of name' },
      { code: '4', label: 'Relator code' },
      { code: '9', label: '9 (RLIN)' },
    ],
  },
  '110': {
    section: '1', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Corporate name or jurisdiction name as entry element' },
      { code: 'b', label: 'Subordinate unit' },
      { code: 'e', label: 'Relator term' },
      { code: '4', label: 'Relator code' },
    ],
  },
  '111': {
    section: '1', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Meeting name or jurisdiction name as entry element' },
      { code: 'c', label: 'Location of meeting' },
      { code: 'd', label: 'Date of meeting' },
      { code: 'e', label: 'Subordinate unit' },
      { code: 'j', label: 'Relator term' },
      { code: '4', label: 'Relator code' },
    ],
  },

  // ---- Section 2 ----
  '240': { section: '2', subfieldsSource: 'general_fallback' },
  '243': { section: '2', subfieldsSource: 'general_fallback' },
  '245': {
    section: '2', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Title', required: true },
      { code: 'b', label: 'Remainder of title' },
      { code: 'c', label: 'Statement of responsibility, etc.' },
      { code: 'h', label: 'Medium' },
    ],
  },
  '246': {
    section: '2', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Title proper/short title' },
      { code: 'b', label: 'Remainder of title' },
      { code: 'h', label: 'Medium' },
      { code: 'i', label: 'Display text' },
    ],
  },
  '250': {
    section: '2', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Edition statement' },
      { code: 'b', label: 'Remainder of edition statement' },
    ],
  },
  '260': {
    section: '2', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Place of publication, distribution, etc.' },
      { code: 'b', label: 'Name of publisher, distributor, etc.' },
      { code: 'c', label: 'Date of publication, distribution, etc.' },
    ],
  },

  // ---- Section 3 ----
  '300': {
    section: '3', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Extent', required: true },
      { code: 'b', label: 'Other physical details' },
      { code: 'c', label: 'Dimensions' },
      { code: 'e', label: 'Accompanying material' },
      { code: 'f', label: 'Type of unit' },
      { code: 'g', label: 'Size of unit' },
    ],
  },

  // ---- Section 4 ----
  '440': {
    section: '4', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Title' },
      { code: 'n', label: 'Number of part/section of a work' },
      { code: 'p', label: 'Name of part/section of a work' },
      { code: 'v', label: 'Volume number/sequential designation' },
      { code: 'x', label: 'International Standard Serial Number' },
    ],
  },

  // ---- Section 5 ----
  '500': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'General note' }] },
  '505': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'Formatted contents note' }] },
  '520': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'Summary, etc.' }] },
  '521': {
    section: '5', subfieldsSource: 'explicit',
    subfields: [
      { code: 'a', label: 'Target audience note' },
      { code: 'b', label: 'Source' },
    ],
  },
  '522': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'Geographic coverage note' }] },
  '526': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'Study program information note' }] },
  '538': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'System details note' }] },
  '546': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'Language/translation information note' }] },
  '586': { section: '5', subfieldsSource: 'explicit', subfields: [{ code: 'a', label: 'Awards' }] },

  // ---- Section 6 ----
  '600': { section: '6', subfieldsSource: 'general_fallback' },
  '610': { section: '6', subfieldsSource: 'general_fallback' },
  '611': { section: '6', subfieldsSource: 'general_fallback' },
  '630': { section: '6', subfieldsSource: 'general_fallback' },
  '650': {
    section: '6', subfieldsSource: 'explicit',
    subfields: [
      { code: '2', label: 'Source of heading or term' },
      { code: 'a', label: 'Topical term or geographic name as entry element' },
      { code: 'v', label: 'Form subdivision' },
      { code: 'x', label: 'General subdivision' },
      { code: 'y', label: 'Chronological subdivision' },
      { code: 'z', label: 'Geographic subdivision' },
    ],
  },
  '651': { section: '6', subfieldsSource: 'general_fallback' },
  '653': { section: '6', subfieldsSource: 'general_fallback' },
  '655': { section: '6', subfieldsSource: 'general_fallback' },
  '656': { section: '6', subfieldsSource: 'general_fallback' },
  '657': { section: '6', subfieldsSource: 'general_fallback' },
  '658': { section: '6', subfieldsSource: 'general_fallback' },
  '690': { section: '6', subfieldsSource: 'general_fallback' },

  // ---- Section 7 ----
  '700': { section: '7', subfieldsSource: 'general_fallback' },
  '710': { section: '7', subfieldsSource: 'general_fallback' },
  '711': { section: '7', subfieldsSource: 'general_fallback' },
  '720': { section: '7', subfieldsSource: 'general_fallback' },
  '740': { section: '7', subfieldsSource: 'general_fallback' },
  '760': { section: '7', subfieldsSource: 'general_fallback' },

  // ---- Section 8 ----
  '856': {
    section: '8', subfieldsSource: 'explicit',
    subfields: [
      { code: '3', label: 'Materials specified' },
      { code: 'u', label: 'Uniform Resource Identifier' },
      { code: 'y', label: 'Link text' },
      { code: 'z', label: 'Public note' },
    ],
  },

  // ---- Section 9 (local/Koha) ----
  '270': { section: '9', subfieldsSource: 'general_fallback' },
  '365': { section: '9', subfieldsSource: 'general_fallback' },
  '366': { section: '9', subfieldsSource: 'general_fallback' },
  '541': { section: '9', subfieldsSource: 'general_fallback' },
  '583': { section: '9', subfieldsSource: 'general_fallback' },
  '942': {
    section: '9', subfieldsSource: 'explicit',
    subfields: [
      { code: '2', label: 'Source of classification or shelving scheme', default: 'Dewey Decimal Classification' },
      { code: 'c', label: 'Koha/default item type', required: true },
      { code: 'e', label: 'Edition' },
      { code: 'h', label: 'Classification part' },
      { code: 'i', label: 'Item part' },
      { code: 'k', label: 'Call number prefix' },
      { code: 'm', label: 'Call number suffix' },
      { code: 'n', label: 'Suppress in OPAC' },
    ],
  },
};
