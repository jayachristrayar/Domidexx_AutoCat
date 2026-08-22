// General MARC21 Bibliographic vocabulary -- the master field/subfield/
// indicator definitions the whole framework engine is built on. This layer
// answers "what does this tag/subfield mean?" and nothing else: it does
// not decide which fields any particular library uses (see
// marc_custom_framework.js for that).
//
// Scope: this is a curated, broad set (covers every section 0XX-9XX and
// every tag used by the "My Library" custom framework, plus a substantial
// set of the next-most-common MARC21 bibliographic fields), not a literal
// transcription of the full MARC21 standard (~250 fields, many of them
// rarely used outside specialist formats like maps/music/archives). Fields
// authored with full indicator/subfield detail have `minimal_definition:
// false`. A smaller number of less common fields are included as stubs
// (tag/label/section/repeatable + a $a placeholder subfield only) with
// `minimal_definition: true` so the admin UI can flag them for
// completion -- per the admin capability to "add custom/local MARC
// fields" / configure fields, extending this file (or the DB rows it
// seeds) is the intended way to fill those in, rather than this file
// guessing at subfields it isn't confident about.

function field(def) {
  return {
    repeatable: false,
    field_type: 'VARIABLE_FIELD',
    authority_control: false,
    is_koha_field: false,
    minimal_definition: false,
    indicators: [],
    subfields: [],
    ...def,
  };
}

function ind(position, code, label, description = null) {
  return { position, code, label, description };
}

function sf(code, label, { repeatable = false, required = false, authority_control = false, description = null } = {}) {
  return { code, label, description, repeatable, required, authority_control };
}

function stub(tag, label, section, { repeatable = false, field_type = 'VARIABLE_FIELD', description = null } = {}) {
  return field({
    tag,
    label,
    description: description ?? `${label} (minimal definition -- extend via admin before relying on its subfield list).`,
    section,
    repeatable,
    field_type,
    minimal_definition: true,
    subfields: field_type === 'CONTROL_FIELD' ? [] : [sf('a', 'Value', { description: 'Placeholder -- full subfield list not yet defined.' })],
  });
}

const NO_INDICATORS = [ind(1, ' ', 'Undefined', 'Indicator not defined for this field'), ind(2, ' ', 'Undefined', 'Indicator not defined for this field')];

export const GENERAL_MARC21_FIELDS = [
  // -------------------------------------------------------------------
  // 0XX -- Control fields, numbers, codes
  // -------------------------------------------------------------------
  field({
    tag: '000', label: 'Leader', section: '0XX', field_type: 'CONTROL_FIELD',
    description: 'Fixed-length data element containing record status, type, and structural information required by MARC21 processing.',
    subfields: [sf(null, 'Leader value', { description: '24-character fixed field, not subfielded.' })],
  }),
  field({
    tag: '001', label: 'Control Number', section: '0XX', field_type: 'CONTROL_FIELD',
    description: 'The control number assigned by the organization creating, using, or distributing the record.',
    subfields: [sf(null, 'Control number')],
  }),
  field({
    tag: '003', label: 'Control Number Identifier', section: '0XX', field_type: 'CONTROL_FIELD',
    description: 'MARC code for the organization whose control number is in field 001.',
    subfields: [sf(null, 'Control number identifier')],
  }),
  field({
    tag: '005', label: 'Date and Time of Latest Transaction', section: '0XX', field_type: 'CONTROL_FIELD',
    description: 'Date and time (YYYYMMDDHHMMSS.F) the record was last modified.',
    subfields: [sf(null, 'Date/time value')],
  }),
  field({
    tag: '006', label: 'Fixed-Length Data Elements — Additional Material Characteristics', section: '0XX', field_type: 'CONTROL_FIELD', repeatable: true,
    description: 'Codes additional characteristics for a record describing mixed-format or multipart material.',
    subfields: [sf(null, 'Fixed field value')],
  }),
  field({
    tag: '007', label: 'Physical Description Fixed Field', section: '0XX', field_type: 'CONTROL_FIELD', repeatable: true,
    description: 'Coded physical description of the item, e.g. category of material and specific physical characteristics.',
    subfields: [sf(null, 'Fixed field value')],
  }),
  field({
    tag: '008', label: 'Fixed-Length Data Elements', section: '0XX', field_type: 'CONTROL_FIELD',
    description: '40-character fixed field of coded information: date entered, date(s) of publication, place, language, and other bibliographic elements.',
    subfields: [sf(null, 'Fixed field value')],
  }),
  field({
    tag: '010', label: 'Library of Congress Control Number', section: '0XX',
    description: 'The control number assigned by the Library of Congress.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'LC control number'), sf('b', 'NUCMC control number', { repeatable: true }), sf('z', 'Canceled/invalid LC control number', { repeatable: true })],
  }),
  field({
    tag: '015', label: 'National Bibliography Number', section: '0XX', repeatable: true,
    description: 'Number assigned to the item by a national bibliographic agency.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'National bibliography number', { repeatable: true }), sf('2', 'Source', { repeatable: true })],
  }),
  field({
    tag: '020', label: 'International Standard Book Number', section: '0XX', repeatable: true,
    description: 'The ISBN and terms of availability assigned to the item.',
    indicators: NO_INDICATORS,
    subfields: [
      sf('a', 'International Standard Book Number', { required: true, description: '13-digit ISBN, no hyphens/spaces' }),
      sf('c', 'Terms of availability'),
      sf('q', 'Qualifying information', { repeatable: true }),
      sf('z', 'Canceled/invalid ISBN', { repeatable: true }),
    ],
  }),
  field({
    tag: '022', label: 'International Standard Serial Number', section: '0XX', repeatable: true,
    description: 'The ISSN and related information for a continuing resource.',
    indicators: [ind(1, '0', 'Level of international interest — Continuing resource of international interest'), ind(1, '1', 'Level of international interest — Continuing resource not of international interest'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'International Standard Serial Number'), sf('l', 'ISSN-L'), sf('y', 'Incorrect ISSN', { repeatable: true }), sf('z', 'Canceled ISSN', { repeatable: true })],
  }),
  field({
    tag: '024', label: 'Other Standard Identifier', section: '0XX', repeatable: true,
    description: 'Standard identifiers for the item other than ISBN/ISSN (e.g. UPC, EAN, DOI, ISMN).',
    indicators: [ind(1, '0', 'Type of standard number — International Article Number'), ind(1, '1', 'Type of standard number — Universal Product Code'), ind(1, '2', 'Type of standard number — International Standard Music Number'), ind(1, '3', 'Type of standard number — International Article Number'), ind(1, '4', 'Type of standard number — Serial Item and Contribution Identifier'), ind(1, '7', 'Type of standard number — Source specified in subfield $2'), ind(1, '8', 'Type of standard number — Unspecified type of standard number'), ind(2, ' ', 'Difference indicator — No information provided'), ind(2, '0', 'Difference indicator — No difference'), ind(2, '1', 'Difference indicator — Difference')],
    subfields: [sf('a', 'Standard number or code', { required: true }), sf('c', 'Terms of availability'), sf('d', 'Additional codes'), sf('q', 'Qualifying information', { repeatable: true }), sf('z', 'Canceled/invalid standard number or code', { repeatable: true }), sf('2', 'Source of number or code')],
  }),
  field({
    tag: '027', label: 'Standard Technical Report Number', section: '0XX', repeatable: true,
    description: 'The internationally-assigned standard number for technical reports and similar documents.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Standard technical report number', { required: true }), sf('q', 'Qualifying information', { repeatable: true }), sf('z', 'Canceled/invalid number', { repeatable: true })],
  }),
  field({
    tag: '028', label: 'Publisher, Distributor, etc. Number', section: '0XX', repeatable: true,
    description: 'A number assigned by a publisher/distributor other than an ISBN/ISSN, e.g. a music publisher plate number.',
    indicators: [ind(1, '0', 'Type of number — Issue number'), ind(1, '1', 'Type of number — Matrix number'), ind(1, '2', 'Type of number — Plate number'), ind(1, '3', 'Type of number — Other music number'), ind(1, '4', 'Type of number — Videorecording number'), ind(1, '5', 'Type of number — Other publisher number'), ind(1, '6', 'Type of number — Distributor number'), ind(2, '0', 'Note/added entry controller — No note, no added entry'), ind(2, '1', 'Note/added entry controller — Note, added entry'), ind(2, '2', 'Note/added entry controller — Note, no added entry'), ind(2, '3', 'Note/added entry controller — No note, added entry')],
    subfields: [sf('a', 'Publisher or distributor number', { required: true }), sf('b', 'Source')],
  }),
  field({
    tag: '035', label: 'System Control Number', section: '0XX', repeatable: true,
    description: 'Control number of a system other than field 001.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'System control number'), sf('z', 'Canceled/invalid control number', { repeatable: true })],
  }),
  field({
    tag: '037', label: 'Source of Acquisition', section: '0XX', repeatable: true,
    description: 'Information on where the item may be acquired and at what price.',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Stock number', { required: true }), sf('b', 'Source of stock number/acquisition'), sf('c', 'Terms of availability'), sf('n', 'Note', { repeatable: true })],
  }),
  field({
    tag: '040', label: 'Cataloging Source', section: '0XX',
    description: 'The MARC code(s) or name(s) of the organization(s) that created the original record and the encoding/description conventions applied.',
    indicators: NO_INDICATORS,
    subfields: [
      sf('a', 'Original cataloging agency'),
      sf('b', 'Language of cataloging'),
      sf('c', 'Transcribing agency'),
      sf('d', 'Modifying agency', { repeatable: true }),
      sf('e', 'Description conventions', { repeatable: true }),
    ],
  }),
  field({
    tag: '041', label: 'Language Code', section: '0XX', repeatable: true,
    description: 'Codes for languages associated with the item when the coding in 008 is insufficient (e.g. translations, multiple languages).',
    indicators: [ind(1, '0', 'Translation indication — Item not a translation/does not include a translation'), ind(1, '1', 'Translation indication — Item is or includes a translation'), ind(2, ' ', 'Source of code — MARC language code'), ind(2, '7', 'Source of code — Source specified in $2')],
    subfields: [sf('a', 'Language code of text/sound track or separate title', { repeatable: true, required: true }), sf('b', 'Language code of summary or abstract', { repeatable: true }), sf('h', 'Language code of original', { repeatable: true }), sf('2', 'Source of code')],
  }),
  field({
    tag: '042', label: 'Authentication Code', section: '0XX',
    description: 'Code indicating the source/nature of the authentication of the record.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Authentication code', { repeatable: true })],
  }),
  field({
    tag: '043', label: 'Geographic Area Code', section: '0XX',
    description: 'Codes identifying geographic area(s) to which the item pertains.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Geographic area code', { repeatable: true }), sf('2', 'Source of local code')],
  }),
  field({
    tag: '050', label: 'Library of Congress Call Number', section: '0XX', repeatable: true,
    description: 'The call number assigned by the Library of Congress or by another agency using LC classification.',
    indicators: [ind(1, '0', 'Existence in LC collection — Item is in LC'), ind(1, '1', 'Existence in LC collection — Item is not in LC'), ind(2, '0', 'Source of call number — Assigned by LC'), ind(2, '4', 'Source of call number — Assigned by agency other than LC')],
    subfields: [sf('a', 'Classification number', { required: true }), sf('b', 'Item number')],
  }),
  field({
    tag: '060', label: 'National Library of Medicine Call Number', section: '0XX', repeatable: true,
    description: 'The call number assigned by the National Library of Medicine.',
    indicators: [ind(1, '0', 'Existence in NLM collection — Item is in NLM'), ind(1, '1', 'Existence in NLM collection — Item is not in NLM'), ind(2, '0', 'Source of call number — Assigned by NLM'), ind(2, '4', 'Source of call number — Assigned by agency other than NLM')],
    subfields: [sf('a', 'Classification number', { repeatable: true, required: true }), sf('b', 'Item number')],
  }),
  field({
    tag: '074', label: 'GPO Item Number', section: '0XX', repeatable: true,
    description: 'The item number assigned by the U.S. Government Publishing Office.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'GPO item number', { required: true }), sf('z', 'Canceled/invalid GPO item number', { repeatable: true })],
  }),
  field({
    tag: '080', label: 'Universal Decimal Classification Number', section: '0XX', repeatable: true,
    description: 'A UDC classification number.',
    indicators: [ind(1, ' ', 'Type of edition — No information provided'), ind(1, '0', 'Type of edition — Full'), ind(1, '1', 'Type of edition — Abridged'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Universal Decimal Classification number', { required: true }), sf('x', 'Common auxiliary subdivision', { repeatable: true })],
  }),
  field({
    tag: '082', label: 'Dewey Decimal Classification Number', section: '0XX', repeatable: true,
    description: 'The Dewey Decimal call number assigned to the work.',
    indicators: [ind(1, '0', 'Type of edition — Full edition'), ind(1, '1', 'Type of edition — Abridged edition'), ind(1, '7', 'Type of edition — Other edition specified in $2'), ind(2, '0', 'Source of classification number — Assigned by LC'), ind(2, '4', 'Source of classification number — Assigned by agency other than LC')],
    subfields: [sf('a', 'Classification number', { required: true, description: 'Classification number' }), sf('b', 'Item number'), sf('2', 'Edition number', { required: true, description: 'DDC edition number' })],
  }),
  field({
    tag: '084', label: 'Other Classification Number', section: '0XX', repeatable: true,
    description: 'A classification number from a scheme other than LC/DDC/UDC/NLM.',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '0', 'Source of number — Assigned by LC'), ind(2, '4', 'Source of number — Assigned by agency other than LC')],
    subfields: [sf('a', 'Classification number', { repeatable: true, required: true }), sf('b', 'Item number'), sf('2', 'Number source')],
  }),
  field({
    tag: '086', label: 'Government Document Classification Number', section: '0XX', repeatable: true,
    description: 'A classification number assigned to a government document by an issuing agency.',
    indicators: [ind(1, ' ', 'Number source — Source specified in $2'), ind(1, '0', 'Number source — Superintendent of Documents Classification System'), ind(1, '1', 'Number source — Government of Canada Publications: Outline of Classification'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Classification number', { required: true }), sf('z', 'Canceled/invalid classification number', { repeatable: true }), sf('2', 'Number source')],
  }),

  // -------------------------------------------------------------------
  // 1XX -- Main entries
  // -------------------------------------------------------------------
  field({
    tag: '100', label: 'Main Entry — Personal Name', section: '1XX', authority_control: true,
    description: 'Main entry for a personal name responsible for the intellectual/artistic content of the work.',
    indicators: [ind(1, '0', 'Type of personal name entry — Forename'), ind(1, '1', 'Type of personal name entry — Surname'), ind(1, '3', 'Type of personal name entry — Family name'), ind(2, ' ', 'Undefined')],
    subfields: [
      sf('a', 'Personal name', { required: true }),
      sf('d', 'Dates associated with a name'),
      sf('e', 'Relator term', { repeatable: true }),
      sf('q', 'Fuller form of name'),
      sf('4', 'Relator code', { repeatable: true }),
      sf('9', '9 (RLIN)'),
    ],
  }),
  field({
    tag: '110', label: 'Main Entry — Corporate Name', section: '1XX', authority_control: true,
    description: 'Main entry for a corporate body/jurisdiction responsible for the intellectual/artistic content of the work.',
    indicators: [ind(1, '0', 'Type of corporate name entry — Inverted name'), ind(1, '1', 'Type of corporate name entry — Jurisdiction name'), ind(1, '2', 'Type of corporate name entry — Name in direct order'), ind(2, ' ', 'Undefined')],
    subfields: [
      sf('a', 'Corporate name or jurisdiction name as entry element', { required: true }),
      sf('b', 'Subordinate unit', { repeatable: true }),
      sf('e', 'Relator term', { repeatable: true }),
      sf('4', 'Relator code', { repeatable: true }),
    ],
  }),
  field({
    tag: '111', label: 'Main Entry — Meeting Name', section: '1XX', authority_control: true,
    description: 'Main entry for a meeting/conference responsible for the intellectual/artistic content of the work.',
    indicators: [ind(1, '0', 'Type of meeting name entry — Inverted name'), ind(1, '1', 'Type of meeting name entry — Jurisdiction name'), ind(1, '2', 'Type of meeting name entry — Name in direct order'), ind(2, ' ', 'Undefined')],
    subfields: [
      sf('a', 'Meeting name or jurisdiction name as entry element', { required: true }),
      sf('c', 'Location of meeting', { repeatable: true }),
      sf('d', 'Date of meeting'),
      sf('e', 'Subordinate unit', { repeatable: true }),
      sf('j', 'Relator term', { repeatable: true }),
      sf('4', 'Relator code', { repeatable: true }),
    ],
  }),
  field({
    tag: '130', label: 'Main Entry — Uniform Title', section: '1XX', authority_control: true,
    description: 'Main entry when a uniform title (not a personal/corporate/meeting name) is the main entry heading.',
    indicators: [ind(1, '0-9', 'Nonfiling characters', 'Number of nonfiling characters present'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Uniform title', { required: true }), sf('n', 'Number of part/section of a work', { repeatable: true }), sf('p', 'Name of part/section of a work', { repeatable: true })],
  }),

  // -------------------------------------------------------------------
  // 2XX -- Titles and title-related fields
  // -------------------------------------------------------------------
  field({
    tag: '240', label: 'Uniform Title', section: '2XX', authority_control: true,
    description: 'Uniform title used to collocate editions/translations/expressions of a work when it differs from the title proper.',
    indicators: [ind(1, '0', 'Uniform title printed or displayed — Not printed or displayed'), ind(1, '1', 'Uniform title printed or displayed — Printed or displayed'), ind(2, '0-9', 'Nonfiling characters')],
    subfields: [sf('a', 'Uniform title', { required: true }), sf('l', 'Language of a work', { repeatable: true })],
  }),
  field({
    tag: '243', label: 'Collective Uniform Title', section: '2XX',
    description: 'Collective uniform title used as the main entry heading for compilations of a person\'s/corporate body\'s works.',
    indicators: [ind(1, '0', 'Uniform title printed or displayed — Not printed or displayed'), ind(1, '1', 'Uniform title printed or displayed — Printed or displayed'), ind(2, '0-9', 'Nonfiling characters')],
    subfields: [sf('a', 'Uniform title', { required: true })],
  }),
  field({
    tag: '245', label: 'Title Statement', section: '2XX', required_note: 'always mandatory in MARC21',
    description: 'The title proper, general material designation, remainder of title, and statement(s) of responsibility.',
    indicators: [ind(1, '0', 'Title added entry — No added entry'), ind(1, '1', 'Title added entry — Added entry'), ind(2, '0-9', 'Nonfiling characters', 'Number of nonfiling characters present (e.g. for "The", "A", "An")')],
    subfields: [
      sf('a', 'Title', { required: true }),
      sf('b', 'Remainder of title'),
      sf('c', 'Statement of responsibility, etc.'),
      sf('h', 'Medium'),
    ],
  }),
  field({
    tag: '246', label: 'Varying Form of Title', section: '2XX', repeatable: true,
    description: 'A title associated with the item other than the title proper, that is important for access or identification.',
    indicators: [ind(1, '0', 'Note/added entry controller — Note, no added entry'), ind(1, '1', 'Note/added entry controller — Note, added entry'), ind(1, '2', 'Note/added entry controller — No note, no added entry'), ind(1, '3', 'Note/added entry controller — No note, added entry'), ind(2, ' ', 'Type of title — No type specified'), ind(2, '0', 'Type of title — Portion of title'), ind(2, '1', 'Type of title — Parallel title'), ind(2, '2', 'Type of title — Distinctive title'), ind(2, '3', 'Type of title — Other title'), ind(2, '4', 'Type of title — Cover title'), ind(2, '5', 'Type of title — Added title page title'), ind(2, '6', 'Type of title — Caption title'), ind(2, '7', 'Type of title — Running title'), ind(2, '8', 'Type of title — Spine title')],
    subfields: [
      sf('a', 'Title proper/short title', { required: true }),
      sf('b', 'Remainder of title'),
      sf('h', 'Medium'),
      sf('i', 'Display text'),
    ],
  }),
  field({
    tag: '247', label: 'Former Title', section: '2XX', repeatable: true,
    description: 'An earlier title of a continuing resource that has undergone a title change.',
    indicators: [ind(1, '0', 'Note/added entry controller — Note, no added entry'), ind(1, '1', 'Note/added entry controller — Note, added entry'), ind(2, '0', 'Note controller — Display note'), ind(2, '1', 'Note controller — Do not display note')],
    subfields: [sf('a', 'Title', { required: true }), sf('b', 'Remainder of title')],
  }),
  field({
    tag: '250', label: 'Edition Statement', section: '2XX',
    description: 'Edition statement relating to an edition of a work that shows differences from other editions.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Edition statement', { required: true }), sf('b', 'Remainder of edition statement')],
  }),
  field({
    tag: '254', label: 'Musical Presentation Statement', section: '2XX',
    description: 'A statement relating to the musical presentation format of the item.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Musical presentation statement', { required: true })],
  }),
  field({
    tag: '255', label: 'Cartographic Mathematical Data', section: '2XX', repeatable: true,
    description: 'Statement of scale, projection, and coordinates for cartographic material.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Statement of scale'), sf('b', 'Statement of projection'), sf('c', 'Statement of coordinates')],
  }),
  field({
    tag: '256', label: 'Computer File Characteristics', section: '2XX',
    description: 'Statement of the characteristics of a computer file/electronic resource.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'File characteristics', { required: true })],
  }),
  field({
    tag: '257', label: 'Country of Producing Entity for Archival Films', section: '2XX', repeatable: true,
    description: 'The country of the entity that produced an archival moving image work.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Country of producing entity', { repeatable: true, required: true })],
  }),
  field({
    tag: '258', label: 'Philatelic Issue Data', section: '2XX', repeatable: true,
    description: 'Information relating to the issuance of philatelic material.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Issuing jurisdiction'), sf('b', 'Denomination')],
  }),
  field({
    tag: '260', label: 'Publication, Distribution, etc.', section: '2XX', repeatable: true,
    description: 'The place, name, and date of publication, distribution, etc. of the item (pre-RDA/AACR2 imprint field; 264 is its RDA equivalent).',
    indicators: [ind(1, ' ', 'Sequence of publishing statements — Not applicable/earliest/only'), ind(1, '2', 'Sequence of publishing statements — Intervening'), ind(1, '3', 'Sequence of publishing statements — Current/latest'), ind(2, ' ', 'Undefined')],
    subfields: [
      sf('a', 'Place of publication, distribution, etc.', { repeatable: true, required: true }),
      sf('b', 'Name of publisher, distributor, etc.', { repeatable: true, required: true }),
      sf('c', 'Date of publication, distribution, etc.', { repeatable: true }),
    ],
  }),
  field({
    tag: '263', label: 'Projected Publication Date', section: '2XX', field_type: 'CONTROL_FIELD',
    description: 'The projected date of publication for a forthcoming item.',
    subfields: [sf(null, 'Projected publication date')],
  }),
  field({
    tag: '264', label: 'Production, Publication, Distribution, Manufacture, and Copyright Notice', section: '2XX', repeatable: true,
    description: 'RDA equivalent of 260; place/name/date of production, publication, distribution, manufacture, or copyright, distinguished by the second indicator.',
    indicators: [ind(1, ' ', 'Sequence of statements — Not applicable/earliest/only'), ind(1, '2', 'Sequence of statements — Intervening'), ind(1, '3', 'Sequence of statements — Current/latest'), ind(2, '0', 'Function of entity — Production'), ind(2, '1', 'Function of entity — Publication'), ind(2, '2', 'Function of entity — Distribution'), ind(2, '3', 'Function of entity — Manufacture'), ind(2, '4', 'Function of entity — Copyright notice date')],
    subfields: [sf('a', 'Place of production, publication, distribution, manufacture', { repeatable: true }), sf('b', 'Name of producer, publisher, distributor, manufacturer', { repeatable: true }), sf('c', 'Date of production, publication, distribution, manufacture, or copyright notice', { repeatable: true })],
  }),
  field({
    tag: '270', label: 'Address', section: '2XX', repeatable: true,
    description: 'Address information (e.g. for contacting an organization associated with the resource).',
    indicators: [ind(1, ' ', 'Level — No level specified'), ind(1, '0', 'Level — Primary'), ind(1, '1', 'Level — Secondary'), ind(2, ' ', 'Type of address — No type specified'), ind(2, '7', 'Type of address — Source specified in $i')],
    subfields: [sf('a', 'Address', { repeatable: true, required: true }), sf('b', 'City'), sf('c', 'State or province'), sf('d', 'Country'), sf('e', 'Postal code'), sf('m', 'Electronic mail address', { repeatable: true }), sf('p', 'Contact person', { repeatable: true })],
  }),

  // -------------------------------------------------------------------
  // 3XX -- Physical description
  // -------------------------------------------------------------------
  field({
    tag: '300', label: 'Physical Description', section: '3XX', repeatable: true,
    description: 'Physical description of the item: extent, other physical details, dimensions, and accompanying material.',
    indicators: NO_INDICATORS,
    subfields: [
      sf('a', 'Extent', { required: true }),
      sf('b', 'Other physical details'),
      sf('c', 'Dimensions'),
      sf('e', 'Accompanying material'),
      sf('f', 'Type of unit', { repeatable: true }),
      sf('g', 'Size of unit', { repeatable: true }),
    ],
  }),
  field({
    tag: '336', label: 'Content Type', section: '3XX', repeatable: true,
    description: 'RDA content type (e.g. text, still image, performed music) categorizing the fundamental form of communication.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Content type term', { repeatable: true }), sf('b', 'Content type code', { repeatable: true }), sf('2', 'Source')],
  }),
  field({
    tag: '337', label: 'Media Type', section: '3XX', repeatable: true,
    description: 'RDA media type describing the general type of intermediation device required to view/play/run/operate the content.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Media type term', { repeatable: true }), sf('b', 'Media type code', { repeatable: true }), sf('2', 'Source')],
  }),
  field({
    tag: '338', label: 'Carrier Type', section: '3XX', repeatable: true,
    description: 'RDA carrier type describing the format of the storage medium and housing of a carrier.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Carrier type term', { repeatable: true }), sf('b', 'Carrier type code', { repeatable: true }), sf('2', 'Source')],
  }),
  field({
    tag: '340', label: 'Physical Medium', section: '3XX', repeatable: true,
    description: 'Physical characteristics of the medium (material base, dimensions, layout, etc.).',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Material base and configuration', { repeatable: true })],
  }),
  field({
    tag: '362', label: 'Dates of Publication and/or Sequential Designation', section: '3XX', repeatable: true,
    description: 'Dates and/or sequential designation of the first/last issue or part of a serial or multipart resource.',
    indicators: [ind(1, '0', 'Format of date — Formatted style'), ind(1, '1', 'Format of date — Unformatted note'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Dates of publication and/or sequential designation', { required: true })],
  }),

  // -------------------------------------------------------------------
  // 4XX -- Series statements
  // -------------------------------------------------------------------
  field({
    tag: '440', label: 'Series Statement / Added Entry — Title', section: '4XX', repeatable: true, authority_control: true,
    description: 'Series statement in which the title is traced the same as it appears in the statement (deprecated by LC in favor of 490/8XX, but the target series field for this project — see rule_profile.json series_policy).',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '0-9', 'Nonfiling characters')],
    subfields: [
      sf('a', 'Title', { required: true }),
      sf('n', 'Number of part/section of a work', { repeatable: true }),
      sf('p', 'Name of part/section of a work', { repeatable: true }),
      sf('v', 'Volume number/sequential designation', { repeatable: true }),
      sf('x', 'International Standard Serial Number'),
    ],
  }),
  field({
    tag: '490', label: 'Series Statement', section: '4XX', repeatable: true,
    description: 'A series statement as it appears on the item, not necessarily traced; used with 8XX for traced series in RDA practice.',
    indicators: [ind(1, '0', 'Series tracing policy — Series not traced'), ind(1, '1', 'Series tracing policy — Series traced'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Series statement', { repeatable: true, required: true }), sf('v', 'Volume/sequential designation', { repeatable: true }), sf('x', 'International Standard Serial Number')],
  }),

  // -------------------------------------------------------------------
  // 5XX -- Notes
  // -------------------------------------------------------------------
  field({
    tag: '500', label: 'General Note', section: '5XX', repeatable: true,
    description: 'General note providing information that does not fit into any of the other specialized note fields.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'General note', { required: true })],
  }),
  field({
    tag: '501', label: 'With Note', section: '5XX', repeatable: true,
    description: 'Note indicating that the item is bound/issued with other items and cataloged under a separate record.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'With note', { required: true })],
  }),
  field({
    tag: '502', label: 'Dissertation Note', section: '5XX', repeatable: true,
    description: 'Information about the academic degree for which the item was presented in partial fulfillment of the requirements.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Dissertation note'), sf('b', 'Degree type'), sf('c', 'Name of granting institution'), sf('d', 'Year degree granted')],
  }),
  field({
    tag: '504', label: 'Bibliography, etc. Note', section: '5XX', repeatable: true,
    description: 'Note about the presence of bibliographic references and/or a discography, filmography, etc. in the item.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Bibliography, etc. note', { required: true }), sf('b', 'Number of references')],
  }),
  field({
    tag: '505', label: 'Formatted Contents Note', section: '5XX', repeatable: true,
    description: 'Contents note listing titles/statements of responsibility within a single item, in a structured or unstructured format.',
    indicators: [ind(1, '0', 'Display constant controller — Contents'), ind(1, '1', 'Display constant controller — Incomplete contents'), ind(1, '2', 'Display constant controller — Partial contents'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Level of content designation — Basic'), ind(2, '0', 'Level of content designation — Enhanced')],
    subfields: [sf('a', 'Formatted contents note', { required: true }), sf('g', 'Miscellaneous information', { repeatable: true }), sf('t', 'Title', { repeatable: true }), sf('r', 'Statement of responsibility', { repeatable: true })],
  }),
  field({
    tag: '506', label: 'Restrictions on Access Note', section: '5XX', repeatable: true,
    description: 'Information about restrictions imposed on access to the item.',
    indicators: [ind(1, ' ', 'Restriction — No information provided'), ind(1, '0', 'Restriction — No restrictions'), ind(1, '1', 'Restriction — Restrictions apply'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Terms governing access', { required: true })],
  }),
  field({
    tag: '508', label: 'Creation/Production Credits Note', section: '5XX', repeatable: true,
    description: 'Note on the persons/bodies (other than principal creators) contributing to a work in a technical/artistic capacity.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Creation/production credits note', { required: true })],
  }),
  field({
    tag: '510', label: 'Citation/References Note', section: '5XX', repeatable: true,
    description: 'Citations to and references to published bibliographic descriptions/reviews/abstracts of the content of the described item.',
    indicators: [ind(1, '0', 'Coverage/location in source — Coverage complete'), ind(1, '1', 'Coverage/location in source — Coverage unknown'), ind(1, '2', 'Coverage/location in source — Coverage complete, location given'), ind(1, '3', 'Coverage/location in source — Coverage unknown, location given'), ind(1, '4', 'Coverage/location in source — Location given'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Name of source', { required: true }), sf('c', 'Location within source'), sf('x', 'International Standard Serial Number')],
  }),
  field({
    tag: '511', label: 'Participant or Performer Note', section: '5XX', repeatable: true,
    description: 'Note about the credits for performers/narrators/presenters, etc.',
    indicators: [ind(1, '0', 'Display constant controller — No display constant generated'), ind(1, '1', 'Display constant controller — Cast'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Participant or performer note', { required: true })],
  }),
  field({
    tag: '520', label: 'Summary, etc.', section: '5XX', repeatable: true,
    description: 'An unformatted summary, abstract, annotation, or review of the item.',
    indicators: [ind(1, ' ', 'Display constant controller — Summary'), ind(1, '0', 'Display constant controller — Subject'), ind(1, '1', 'Display constant controller — Review'), ind(1, '2', 'Display constant controller — Scope and content'), ind(1, '3', 'Display constant controller — Abstract'), ind(1, '4', 'Display constant controller — Content advice'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Summary, etc.', { required: true }), sf('b', 'Expansion of summary note')],
  }),
  field({
    tag: '521', label: 'Target Audience Note', section: '5XX', repeatable: true,
    description: 'The target audience/grade/interest/motivation level for the item.',
    indicators: [ind(1, ' ', 'Display constant controller — Audience'), ind(1, '0', 'Display constant controller — Reading grade level'), ind(1, '1', 'Display constant controller — Interest age level'), ind(1, '2', 'Display constant controller — Interest grade level'), ind(1, '3', 'Display constant controller — Special audience characteristics'), ind(1, '4', 'Display constant controller — Motivation/interest level'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Target audience note', { repeatable: true, required: true }), sf('b', 'Source')],
  }),
  field({
    tag: '522', label: 'Geographic Coverage Note', section: '5XX', repeatable: true,
    description: 'Geographic area(s) covered by the content of the item.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Geographic coverage note', { required: true })],
  }),
  field({
    tag: '524', label: 'Preferred Citation of Described Materials Note', section: '5XX', repeatable: true,
    description: 'The form of citation the repository/archive prefers for the described materials.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Preferred citation of described materials note', { required: true })],
  }),
  field({
    tag: '525', label: 'Supplement Note', section: '5XX', repeatable: true,
    description: 'Note describing separately-issued supplements/special issues/indexes to the item.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Supplement note', { required: true })],
  }),
  field({
    tag: '526', label: 'Study Program Information Note', section: '5XX', repeatable: true,
    description: 'Information about the item\'s reading/study program (e.g. Accelerated Reader), and points/level assigned.',
    indicators: [ind(1, '0', 'Display constant controller — Reading program'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Program name', { required: true }), sf('b', 'Reading level'), sf('c', 'Interest level'), sf('d', 'Title point value')],
  }),
  field({
    tag: '530', label: 'Additional Physical Form Available Note', section: '5XX', repeatable: true,
    description: 'Note describing other physical forms in which the content is available.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Additional physical form available note', { required: true })],
  }),
  field({
    tag: '533', label: 'Reproduction Note', section: '5XX', repeatable: true,
    description: 'Information about a reproduction of the described material.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Type of reproduction', { required: true }), sf('b', 'Place of reproduction', { repeatable: true }), sf('c', 'Agency responsible for reproduction', { repeatable: true }), sf('d', 'Date of reproduction')],
  }),
  field({
    tag: '534', label: 'Original Version Note', section: '5XX', repeatable: true,
    description: 'Information relating to the original version of a reproduced item.',
    indicators: NO_INDICATORS,
    subfields: [sf('p', 'Introductory phrase', { required: true }), sf('t', 'Title of original')],
  }),
  field({
    tag: '538', label: 'System Details Note', section: '5XX', repeatable: true,
    description: 'Technical/system requirements/details of the item (e.g. computer file specifications).',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'System details note', { required: true })],
  }),
  field({
    tag: '540', label: 'Terms Governing Use and Reproduction Note', section: '5XX', repeatable: true,
    description: 'Terms/conditions governing the use/reproduction of the described materials after access has been provided.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Terms governing use and reproduction', { required: true })],
  }),
  field({
    tag: '541', label: 'Immediate Source of Acquisition Note', section: '5XX', repeatable: true,
    description: 'Information about the immediate source of acquisition of archival/manuscript material (donor, purchase, price, date).',
    indicators: [ind(1, ' ', 'Privacy — No information provided'), ind(1, '0', 'Privacy — Private'), ind(1, '1', 'Privacy — Not private'), ind(2, ' ', 'Undefined')],
    subfields: [
      sf('a', 'Source of acquisition', { required: true }),
      sf('c', 'Method of acquisition'),
      sf('d', 'Date of acquisition'),
      sf('h', 'Purchase price'),
    ],
  }),
  field({
    tag: '542', label: 'Information Relating to Copyright Status', section: '5XX', repeatable: true,
    description: 'Information relating to the copyright status of a resource.',
    indicators: [ind(1, ' ', 'Privacy — No information provided'), ind(1, '0', 'Privacy — Private'), ind(1, '1', 'Privacy — Not private'), ind(2, ' ', 'Undefined')],
    subfields: [sf('f', 'Copyright status'), sf('g', 'Copyright date')],
  }),
  field({
    tag: '544', label: 'Location of Other Archival Materials Note', section: '5XX', repeatable: true,
    description: 'Locations of other archival materials related to the described materials.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Custodian', { repeatable: true }), sf('n', 'Note', { repeatable: true })],
  }),
  field({
    tag: '545', label: 'Biographical or Historical Data', section: '5XX', repeatable: true,
    description: 'Biographical or historical information about the creator(s) or organizational history of the archival materials.',
    indicators: [ind(1, ' ', 'Type of data — No information provided'), ind(1, '0', 'Type of data — Biographical sketch'), ind(1, '1', 'Type of data — Administrative history'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Biographical or historical note', { required: true })],
  }),
  field({
    tag: '546', label: 'Language Note', section: '5XX', repeatable: true,
    description: 'Note about the language(s) of the item and/or translation/adaptation.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Language note', { required: true }), sf('b', 'Information code or alphabet', { repeatable: true })],
  }),
  field({
    tag: '547', label: 'Former Title Complexity Note', section: '5XX', repeatable: true,
    description: 'Free-text note describing complex/non-standard title changes of a serial.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Former title complexity note', { required: true })],
  }),
  field({
    tag: '550', label: 'Issuing Body Note', section: '5XX', repeatable: true,
    description: 'Notes on changes in/information about the issuing body of a serial.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Issuing body note', { required: true })],
  }),
  field({
    tag: '555', label: 'Cumulative Index/Finding Aids Note', section: '5XX', repeatable: true,
    description: 'Information about the existence/availability of indexes/finding aids to the item.',
    indicators: [ind(1, ' ', 'Display constant controller — No information provided'), ind(1, '0', 'Display constant controller — Finding aids'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Cumulative index/finding aids note', { required: true })],
  }),
  field({
    tag: '561', label: 'Ownership and Custodial History', section: '5XX', repeatable: true,
    description: 'Information on the ownership and custodial history of the archival materials described.',
    indicators: [ind(1, ' ', 'Privacy — No information provided'), ind(1, '0', 'Privacy — Private'), ind(1, '1', 'Privacy — Not private'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'History', { required: true })],
  }),
  field({
    tag: '562', label: 'Copy and Version Identification Note', section: '5XX', repeatable: true,
    description: 'Information identifying a specific copy/version of the item being described.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Identifying markings', { repeatable: true })],
  }),
  field({
    tag: '563', label: 'Binding Information', section: '5XX', repeatable: true,
    description: 'Information about the binding of the item, including special characteristics.',
    indicators: [ind(1, ' ', 'Privacy — No information provided'), ind(1, '0', 'Privacy — Private'), ind(1, '1', 'Privacy — Not private'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Binding note', { required: true })],
  }),
  field({
    tag: '565', label: 'Case File Characteristics Note', section: '5XX', repeatable: true,
    description: 'Information about the type/number/subjects of records in a case-file dataset.',
    indicators: [ind(1, ' ', 'Display constant controller — No information provided'), ind(1, '0', 'Display constant controller — Case file characteristics'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Number of cases/variables', { required: true })],
  }),
  field({
    tag: '567', label: 'Methodology Note', section: '5XX', repeatable: true,
    description: 'Information about the research methodology/technique used in a data file.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Methodology note', { required: true })],
  }),
  field({
    tag: '580', label: 'Linking Entry Complexity Note', section: '5XX', repeatable: true,
    description: 'Free-text note describing complex relationships between the item and related items not expressible in the standard linking entry fields.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Linking entry complexity note', { required: true })],
  }),
  field({
    tag: '581', label: 'Publications About Described Materials Note', section: '5XX', repeatable: true,
    description: 'Citation to a publication based on the use/study/analysis of the item.',
    indicators: [ind(1, ' ', 'Display constant controller — No information provided'), ind(1, '0', 'Display constant controller — Publications'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Publications about described materials note', { required: true })],
  }),
  field({
    tag: '583', label: 'Action Note', section: '5XX', repeatable: true,
    description: 'Information about an action taken (or planned) with respect to preserving/retaining/disposing of the item, e.g. for archival/preservation workflows.',
    indicators: [ind(1, ' ', 'Privacy — No information provided'), ind(1, '0', 'Privacy — Private'), ind(1, '1', 'Privacy — Not private'), ind(2, ' ', 'Undefined')],
    subfields: [
      sf('a', 'Action', { required: true }),
      sf('c', 'Time/date of action', { repeatable: true }),
      sf('z', 'Public note', { repeatable: true }),
    ],
  }),
  field({
    tag: '584', label: 'Accumulation and Frequency of Use Note', section: '5XX', repeatable: true,
    description: 'Information about the accumulation and frequency of use of records described as a unit.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Accumulation', { repeatable: true }), sf('b', 'Frequency of use', { repeatable: true })],
  }),
  field({
    tag: '585', label: 'Exhibitions Note', section: '5XX', repeatable: true,
    description: 'Information about exhibitions in which the item has been displayed.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Exhibitions note', { required: true })],
  }),
  field({
    tag: '586', label: 'Awards Note', section: '5XX', repeatable: true,
    description: 'Note listing awards/honors associated with the item.',
    indicators: [ind(1, ' ', 'Display constant controller — Awards'), ind(1, '8', 'Display constant controller — No display constant generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Awards note', { required: true })],
  }),
  field({
    tag: '588', label: 'Source of Description Note', section: '5XX', repeatable: true,
    description: 'Free-text note about the source of the description or latest issue consulted when creating the bibliographic record.',
    indicators: [ind(1, ' ', 'Display constant controller — No information provided'), ind(1, '0', 'Display constant controller — Source of description note'), ind(1, '1', 'Display constant controller — Latest issue consulted'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Source of description note', { required: true })],
  }),

  // -------------------------------------------------------------------
  // 6XX -- Subject added entries
  // -------------------------------------------------------------------
  field({
    tag: '600', label: 'Subject Added Entry — Personal Name', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a personal name.',
    indicators: [ind(1, '0', 'Type of personal name entry — Forename'), ind(1, '1', 'Type of personal name entry — Surname'), ind(1, '3', 'Type of personal name entry — Family name'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '2', 'Thesaurus — MeSH'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('a', 'Personal name', { required: true }),
      sf('d', 'Dates associated with a name'),
      sf('t', 'Title of a work', { repeatable: true }),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
      sf('2', 'Source of heading or term'),
    ],
  }),
  field({
    tag: '610', label: 'Subject Added Entry — Corporate Name', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a corporate name/jurisdiction.',
    indicators: [ind(1, '0', 'Type of corporate name entry — Inverted name'), ind(1, '1', 'Type of corporate name entry — Jurisdiction name'), ind(1, '2', 'Type of corporate name entry — Name in direct order'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '2', 'Thesaurus — MeSH'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('a', 'Corporate name or jurisdiction name as entry element', { required: true }),
      sf('b', 'Subordinate unit', { repeatable: true }),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
      sf('2', 'Source of heading or term'),
    ],
  }),
  field({
    tag: '611', label: 'Subject Added Entry — Meeting Name', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a meeting/conference name.',
    indicators: [ind(1, '0', 'Type of meeting name entry — Inverted name'), ind(1, '1', 'Type of meeting name entry — Jurisdiction name'), ind(1, '2', 'Type of meeting name entry — Name in direct order'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '2', 'Thesaurus — MeSH'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('a', 'Meeting name or jurisdiction name as entry element', { required: true }),
      sf('c', 'Location of meeting', { repeatable: true }),
      sf('d', 'Date of meeting'),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
      sf('2', 'Source of heading or term'),
    ],
  }),
  field({
    tag: '630', label: 'Subject Added Entry — Uniform Title', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a uniform title.',
    indicators: [ind(1, '0-9', 'Nonfiling characters'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '2', 'Thesaurus — MeSH'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('a', 'Uniform title', { required: true }),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
      sf('2', 'Source of heading or term'),
    ],
  }),
  field({
    tag: '647', label: 'Subject Added Entry — Named Event', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is the name of an event (e.g. a war, exhibition).',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [sf('a', 'Named event', { required: true }), sf('v', 'Form subdivision', { repeatable: true }), sf('x', 'General subdivision', { repeatable: true }), sf('2', 'Source of heading or term')],
  }),
  field({
    tag: '648', label: 'Subject Added Entry — Chronological Term', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a chronological term (a time period).',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [sf('a', 'Chronological term', { required: true }), sf('v', 'Form subdivision', { repeatable: true }), sf('x', 'General subdivision', { repeatable: true }), sf('2', 'Source of heading or term')],
  }),
  field({
    tag: '650', label: 'Subject Added Entry — Topical Term', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a topical term.',
    indicators: [ind(1, ' ', 'Level of subject — No information provided'), ind(1, '0', 'Level of subject — No level specified'), ind(1, '1', 'Level of subject — Primary'), ind(1, '2', 'Level of subject — Secondary'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '1', 'Thesaurus — LC subject headings for children\'s literature'), ind(2, '2', 'Thesaurus — MeSH'), ind(2, '3', 'Thesaurus — NAL subject authority file'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '5', 'Thesaurus — Canadian Subject Headings'), ind(2, '6', 'Thesaurus — Répertoire de vedettes-matière'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('2', 'Source of heading or term'),
      sf('a', 'Topical term or geographic name as entry element', { required: true }),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
    ],
  }),
  field({
    tag: '651', label: 'Subject Added Entry — Geographic Name', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the entry element is a geographic name.',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '2', 'Thesaurus — MeSH'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('a', 'Geographic name', { required: true }),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
      sf('2', 'Source of heading or term'),
    ],
  }),
  field({
    tag: '653', label: 'Index Term — Uncontrolled', section: '6XX', repeatable: true,
    description: 'An uncontrolled index term (keyword) not drawn from a controlled subject heading system.',
    indicators: [ind(1, ' ', 'Level of index term — No information provided'), ind(1, '0', 'Level of index term — No level specified'), ind(1, '1', 'Level of index term — Primary'), ind(1, '2', 'Level of index term — Secondary'), ind(2, ' ', 'Type of term or name — No information provided'), ind(2, '0', 'Type of term or name — Topical term'), ind(2, '1', 'Type of term or name — Personal name'), ind(2, '2', 'Type of term or name — Corporate name'), ind(2, '3', 'Type of term or name — Meeting name'), ind(2, '4', 'Type of term or name — Chronological term'), ind(2, '5', 'Type of term or name — Geographic name'), ind(2, '6', 'Type of term or name — Genre/form term')],
    subfields: [sf('a', 'Uncontrolled term', { repeatable: true, required: true })],
  }),
  field({
    tag: '654', label: 'Subject Added Entry — Faceted Topical Term', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry constructed from faceted vocabulary elements (focus term + facets).',
    indicators: [ind(1, ' ', 'Level of subject — No information provided'), ind(1, '0', 'Level of subject — No level specified'), ind(1, '1', 'Level of subject — Primary'), ind(1, '2', 'Level of subject — Secondary'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Focus term', { repeatable: true, required: true }), sf('b', 'Facet/hierarchy designation', { repeatable: true }), sf('2', 'Source of term')],
  }),
  field({
    tag: '655', label: 'Index Term — Genre/Form', section: '6XX', repeatable: true, authority_control: true,
    description: 'A term indicating the genre/form/physical characteristics of the item, rather than its subject.',
    indicators: [ind(1, ' ', 'Type of heading — Basic'), ind(1, '0', 'Type of heading — Faceted'), ind(2, '0', 'Thesaurus — LCSH'), ind(2, '4', 'Thesaurus — Source not specified'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [
      sf('a', 'Genre/form data or focus term', { required: true }),
      sf('v', 'Form subdivision', { repeatable: true }),
      sf('x', 'General subdivision', { repeatable: true }),
      sf('y', 'Chronological subdivision', { repeatable: true }),
      sf('z', 'Geographic subdivision', { repeatable: true }),
      sf('2', 'Source of term'),
    ],
  }),
  field({
    tag: '656', label: 'Index Term — Occupation', section: '6XX', repeatable: true,
    description: 'A controlled term identifying an occupation associated with the content of the item.',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [sf('a', 'Occupation term', { required: true }), sf('2', 'Source of term')],
  }),
  field({
    tag: '657', label: 'Index Term — Function', section: '6XX', repeatable: true,
    description: 'A controlled term identifying a function associated with the content of the item.',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '7', 'Thesaurus — Source specified in $2')],
    subfields: [sf('a', 'Function term', { required: true }), sf('2', 'Source of term')],
  }),
  field({
    tag: '658', label: 'Index Term — Curriculum Objective', section: '6XX', repeatable: true,
    description: 'Terms/codes indicating a curriculum objective/subject matter associated with the content of the item.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Main curriculum objective', { required: true }), sf('b', 'Subordinate curriculum objective', { repeatable: true }), sf('2', 'Source of term or code')],
  }),
  field({
    tag: '662', label: 'Subject Added Entry — Hierarchical Place Name', section: '6XX', repeatable: true, authority_control: true,
    description: 'Subject added entry in which the elements are parts of a hierarchical geographic place name.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Country or larger entity', { repeatable: true, required: true }), sf('b', 'First-order political jurisdiction')],
  }),
  field({
    tag: '690', label: 'Local Subject Added Entry — Topical Term', section: '6XX', repeatable: true, is_koha_field: true,
    description: 'A locally-defined, uncontrolled subject added entry (Koha/local practice extension of the 6XX block, outside standard LC 6XX semantics).',
    indicators: [ind(1, ' ', 'Level of subject — No information provided'), ind(2, ' ', 'Thesaurus — Source not specified')],
    subfields: [sf('a', 'Local topical term', { required: true }), sf('x', 'General subdivision', { repeatable: true })],
  }),

  // -------------------------------------------------------------------
  // 7XX -- Added entries (other than subject/series) and linking fields
  // -------------------------------------------------------------------
  field({
    tag: '700', label: 'Added Entry — Personal Name', section: '7XX', repeatable: true, authority_control: true,
    description: 'Added entry in which the entry element is a personal name (a contributor other than the main entry).',
    indicators: [ind(1, '0', 'Type of personal name entry — Forename'), ind(1, '1', 'Type of personal name entry — Surname'), ind(1, '3', 'Type of personal name entry — Family name'), ind(2, ' ', 'Type of added entry — No information provided'), ind(2, '2', 'Type of added entry — Analytical entry')],
    subfields: [
      sf('a', 'Personal name', { required: true }),
      sf('d', 'Dates associated with a name'),
      sf('e', 'Relator term', { repeatable: true }),
      sf('t', 'Title of a work', { repeatable: true }),
      sf('4', 'Relator code', { repeatable: true }),
    ],
  }),
  field({
    tag: '710', label: 'Added Entry — Corporate Name', section: '7XX', repeatable: true, authority_control: true,
    description: 'Added entry in which the entry element is a corporate name/jurisdiction (a contributor other than the main entry).',
    indicators: [ind(1, '0', 'Type of corporate name entry — Inverted name'), ind(1, '1', 'Type of corporate name entry — Jurisdiction name'), ind(1, '2', 'Type of corporate name entry — Name in direct order'), ind(2, ' ', 'Type of added entry — No information provided'), ind(2, '2', 'Type of added entry — Analytical entry')],
    subfields: [
      sf('a', 'Corporate name or jurisdiction name as entry element', { required: true }),
      sf('b', 'Subordinate unit', { repeatable: true }),
      sf('e', 'Relator term', { repeatable: true }),
      sf('t', 'Title of a work', { repeatable: true }),
      sf('4', 'Relator code', { repeatable: true }),
    ],
  }),
  field({
    tag: '711', label: 'Added Entry — Meeting Name', section: '7XX', repeatable: true, authority_control: true,
    description: 'Added entry in which the entry element is a meeting/conference name (a contributor other than the main entry).',
    indicators: [ind(1, '0', 'Type of meeting name entry — Inverted name'), ind(1, '1', 'Type of meeting name entry — Jurisdiction name'), ind(1, '2', 'Type of meeting name entry — Name in direct order'), ind(2, ' ', 'Type of added entry — No information provided'), ind(2, '2', 'Type of added entry — Analytical entry')],
    subfields: [
      sf('a', 'Meeting name or jurisdiction name as entry element', { required: true }),
      sf('c', 'Location of meeting', { repeatable: true }),
      sf('d', 'Date of meeting'),
      sf('e', 'Subordinate unit', { repeatable: true }),
      sf('j', 'Relator term', { repeatable: true }),
      sf('4', 'Relator code', { repeatable: true }),
    ],
  }),
  field({
    tag: '720', label: 'Added Entry — Uncontrolled Name', section: '7XX', repeatable: true,
    description: 'Added entry for a name not controlled by an authority file, used when a controlled form (100/110/111/700/710/711) is not available.',
    indicators: [ind(1, ' ', 'Type of name — No information provided'), ind(1, '1', 'Type of name — Personal'), ind(1, '2', 'Type of name — Other'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Name', { required: true }), sf('e', 'Relator term', { repeatable: true })],
  }),
  field({
    tag: '730', label: 'Added Entry — Uniform Title', section: '7XX', repeatable: true, authority_control: true,
    description: 'Added entry in which the entry element is a uniform title.',
    indicators: [ind(1, '0-9', 'Nonfiling characters'), ind(2, ' ', 'Type of added entry — No information provided'), ind(2, '2', 'Type of added entry — Analytical entry')],
    subfields: [sf('a', 'Uniform title', { required: true }), sf('n', 'Number of part/section of a work', { repeatable: true }), sf('p', 'Name of part/section of a work', { repeatable: true })],
  }),
  field({
    tag: '740', label: 'Added Entry — Uncontrolled Related/Analytical Title', section: '7XX', repeatable: true,
    description: 'Added entry for a title, not controlled by an authority record, that is related to or an analytic of the item.',
    indicators: [ind(1, '0-9', 'Nonfiling characters'), ind(2, ' ', 'Type of added entry — No information provided'), ind(2, '2', 'Type of added entry — Analytical entry')],
    subfields: [sf('a', 'Title', { required: true }), sf('n', 'Number of part/section of a work', { repeatable: true }), sf('p', 'Name of part/section of a work', { repeatable: true })],
  }),
  field({
    tag: '751', label: 'Added Entry — Geographic Name', section: '7XX', repeatable: true, authority_control: true,
    description: 'Added entry in which the entry element is a geographic name, used as a secondary access point.',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Geographic name', { required: true })],
  }),
  field({
    tag: '752', label: 'Added Entry — Hierarchical Place Name', section: '7XX', repeatable: true, authority_control: true,
    description: 'Added entry for a hierarchical geographic place name used as a secondary access point.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Country or larger entity', { repeatable: true, required: true }), sf('b', 'First-order political jurisdiction')],
  }),
  field({
    tag: '753', label: 'System Details Access to Computer File', section: '7XX', repeatable: true,
    description: 'System requirements for a computer file used for access-point purposes (not a display note; see 538 for that).',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Make and model of machine', { repeatable: true }), sf('c', 'Operating system')],
  }),
  field({
    tag: '754', label: 'Added Entry — Taxonomic Identification', section: '7XX', repeatable: true,
    description: 'Added entry for a taxonomic name used to provide access by scientific/biological classification.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Taxonomic name', { repeatable: true, required: true }), sf('2', 'Source of taxonomic identification')],
  }),
  field({
    tag: '758', label: 'Resource Identifier', section: '7XX', repeatable: true,
    description: 'An external identifier for the work/expression represented by the bibliographic resource (e.g. a work ID URI).',
    indicators: NO_INDICATORS,
    subfields: [sf('i', 'Display text'), sf('0', 'Authority record control number or standard number', { repeatable: true })],
  }),
  field({
    tag: '760', label: 'Main Series Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying the main series to which the item belongs.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(1, '0', 'Note controller — No note'), ind(1, '1', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Main series')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true }), sf('x', 'International Standard Serial Number')],
  }),
  field({
    tag: '762', label: 'Subseries Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying a subseries related to the item.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Has subseries')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '765', label: 'Original Language Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying the original-language edition from which the described item was translated.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Translation of')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true }), sf('z', 'International Standard Book Number', { repeatable: true })],
  }),
  field({
    tag: '767', label: 'Translation Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying a translation of the described item.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Translated as')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '770', label: 'Supplement/Special Issue Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying a work that supplements the item described.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Has supplement')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '772', label: 'Supplement Parent Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying the parent work of a supplement being described.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Parent'), ind(2, '0', 'Display constant controller — Supplement to')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '773', label: 'Host Item Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying the host item within which the item being described is contained (e.g. journal article -> journal).',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — In')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true }), sf('g', 'Related parts', { repeatable: true })],
  }),
  field({
    tag: '774', label: 'Constituent Unit Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying an item that is part of the item being described.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Constituent unit')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '775', label: 'Other Edition Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying another edition of the item being described.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Other edition available')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '776', label: 'Additional Physical Form Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying an additional physical form in which the content of the item is available.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Available in another form'), ind(2, '8', 'Display constant controller — No display constant generated')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true }), sf('z', 'International Standard Book Number', { repeatable: true })],
  }),
  field({
    tag: '777', label: 'Issued With Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying an item issued together with the item being described.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Issued with')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '780', label: 'Preceding Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying the immediately preceding entry in a title-change sequence.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, '0', 'Type of relationship — Continues'), ind(2, '1', 'Type of relationship — Continues in part'), ind(2, '2', 'Type of relationship — Supersedes'), ind(2, '3', 'Type of relationship — Supersedes in part'), ind(2, '4', 'Type of relationship — Formed by union of ... and ...'), ind(2, '5', 'Type of relationship — Absorbed'), ind(2, '6', 'Type of relationship — Absorbed in part'), ind(2, '7', 'Type of relationship — Separated from')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true }), sf('x', 'International Standard Serial Number')],
  }),
  field({
    tag: '785', label: 'Succeeding Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying the immediately succeeding entry in a title-change sequence.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, '0', 'Type of relationship — Continued by'), ind(2, '1', 'Type of relationship — Continued in part by'), ind(2, '2', 'Type of relationship — Superseded by'), ind(2, '3', 'Type of relationship — Superseded in part by'), ind(2, '4', 'Type of relationship — Absorbed by'), ind(2, '5', 'Type of relationship — Absorbed in part by'), ind(2, '6', 'Type of relationship — Split into ... and ...'), ind(2, '7', 'Type of relationship — Merged with ... to form ...'), ind(2, '8', 'Type of relationship — Changed back to')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true }), sf('x', 'International Standard Serial Number')],
  }),
  field({
    tag: '786', label: 'Data Source Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying a data source from which the described item was derived.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Data source'), ind(2, '8', 'Display constant controller — No display constant generated')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),
  field({
    tag: '787', label: 'Other Relationship Entry', section: '7XX', repeatable: true,
    description: 'A linking entry identifying an item with a relationship to the described item not covered by other linking fields.',
    indicators: [ind(1, ' ', 'Note controller — Note'), ind(2, ' ', 'Display constant controller — Related item')],
    subfields: [sf('a', 'Main entry heading'), sf('t', 'Title', { required: true })],
  }),

  // -------------------------------------------------------------------
  // 8XX -- Series added entries, holdings, and electronic location
  // -------------------------------------------------------------------
  field({
    tag: '800', label: 'Series Added Entry — Personal Name', section: '8XX', repeatable: true, authority_control: true,
    description: 'Traced series added entry in which the entry element is a personal name.',
    indicators: [ind(1, '0', 'Type of personal name entry — Forename'), ind(1, '1', 'Type of personal name entry — Surname'), ind(1, '3', 'Type of personal name entry — Family name'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Personal name', { required: true }), sf('t', 'Title of a work', { repeatable: true }), sf('v', 'Volume/sequential designation', { repeatable: true })],
  }),
  field({
    tag: '810', label: 'Series Added Entry — Corporate Name', section: '8XX', repeatable: true, authority_control: true,
    description: 'Traced series added entry in which the entry element is a corporate name.',
    indicators: [ind(1, '0', 'Type of corporate name entry — Inverted name'), ind(1, '1', 'Type of corporate name entry — Jurisdiction name'), ind(1, '2', 'Type of corporate name entry — Name in direct order'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Corporate name or jurisdiction name as entry element', { required: true }), sf('t', 'Title of a work', { repeatable: true }), sf('v', 'Volume/sequential designation', { repeatable: true })],
  }),
  field({
    tag: '811', label: 'Series Added Entry — Meeting Name', section: '8XX', repeatable: true, authority_control: true,
    description: 'Traced series added entry in which the entry element is a meeting name.',
    indicators: [ind(1, '0', 'Type of meeting name entry — Inverted name'), ind(1, '1', 'Type of meeting name entry — Jurisdiction name'), ind(1, '2', 'Type of meeting name entry — Name in direct order'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Meeting name or jurisdiction name as entry element', { required: true }), sf('t', 'Title of a work', { repeatable: true }), sf('v', 'Volume/sequential designation', { repeatable: true })],
  }),
  field({
    tag: '830', label: 'Series Added Entry — Uniform Title', section: '8XX', repeatable: true, authority_control: true,
    description: 'Traced series added entry in which the entry element is a uniform title (most common form of traced series added entry).',
    indicators: [ind(1, ' ', 'Undefined'), ind(2, '0-9', 'Nonfiling characters')],
    subfields: [sf('a', 'Uniform title', { required: true }), sf('v', 'Volume/sequential designation', { repeatable: true }), sf('x', 'International Standard Serial Number')],
  }),
  field({
    tag: '850', label: 'Holding Institution', section: '8XX', repeatable: true,
    description: 'MARC code(s) or name(s) of the institution(s) holding the item.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Holding institution', { repeatable: true, required: true })],
  }),
  field({
    tag: '852', label: 'Location', section: '8XX', repeatable: true,
    description: 'Information about the location of the item (holdings-level field; in Koha, item-level location typically lives in 952/952@).',
    indicators: [ind(1, ' ', 'Shelving scheme — No information provided'), ind(1, '0', 'Shelving scheme — Library of Congress classification'), ind(1, '1', 'Shelving scheme — Dewey Decimal classification'), ind(2, ' ', 'Shelving order — No information provided'), ind(2, '0', 'Shelving order — Not enumeration')],
    subfields: [sf('a', 'Location', { required: true }), sf('b', 'Sublocation or collection', { repeatable: true }), sf('h', 'Classification part'), sf('i', 'Item part', { repeatable: true })],
  }),
  field({
    tag: '856', label: 'Electronic Location and Access', section: '8XX', repeatable: true,
    description: 'Information needed to locate and access an electronic resource, or an electronic version/supplement to a print resource.',
    indicators: [ind(1, ' ', 'Access method — No information provided'), ind(1, '0', 'Access method — Email'), ind(1, '1', 'Access method — FTP'), ind(1, '2', 'Access method — Remote login (Telnet)'), ind(1, '3', 'Access method — Dial-up'), ind(1, '4', 'Access method — HTTP'), ind(1, '7', 'Access method — Method specified in $2'), ind(2, ' ', 'Relationship — No information provided'), ind(2, '0', 'Relationship — Resource'), ind(2, '1', 'Relationship — Version of resource'), ind(2, '2', 'Relationship — Related resource'), ind(2, '8', 'Relationship — No display constant generated')],
    subfields: [
      sf('3', 'Materials specified'),
      sf('u', 'Uniform Resource Identifier', { repeatable: true, required: true }),
      sf('y', 'Link text', { repeatable: true }),
      sf('z', 'Public note', { repeatable: true }),
    ],
  }),
  field({
    tag: '880', label: 'Alternate Graphic Representation', section: '8XX', repeatable: true,
    description: 'Contains a non-Roman/alternate script representation of a field elsewhere in the record, linked via subfield $6.',
    indicators: NO_INDICATORS,
    subfields: [sf('6', 'Linkage', { required: true }), sf('a', 'Same subfields as the linked field', { repeatable: true })],
  }),
  field({
    tag: '883', label: 'Machine-Generated Metadata Provenance', section: '8XX', repeatable: true,
    description: 'Information about the machine process used to generate metadata elsewhere in the record and its confidence level.',
    indicators: [ind(1, ' ', 'Method of assignment — No information provided'), ind(1, '0', 'Method of assignment — Fully machine-generated'), ind(1, '1', 'Method of assignment — Partially machine-generated'), ind(2, ' ', 'Undefined')],
    subfields: [sf('a', 'Generation process'), sf('c', 'Confidence value'), sf('u', 'Uniform Resource Identifier', { repeatable: true })],
  }),
  field({
    tag: '884', label: 'Description Conversion Information', section: '8XX', repeatable: true,
    description: 'Information about the conversion of the description from another metadata format into MARC21.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Conversion process'), sf('g', 'Conversion date')],
  }),

  // -------------------------------------------------------------------
  // 9XX -- Local/Koha-specific data
  // -------------------------------------------------------------------
  field({
    tag: '365', label: 'Trade Price', section: '9XX', repeatable: true, is_koha_field: true,
    description: 'Local/vendor field carrying trade price information for acquisitions (not a standard bibliographic-description field, used operationally by ILS acquisitions modules).',
    indicators: NO_INDICATORS,
    subfields: [sf('b', 'Price amount'), sf('c', 'Currency of price'), sf('d', 'Unit of pricing')],
  }),
  field({
    tag: '366', label: 'Trade Availability Information', section: '9XX', repeatable: true, is_koha_field: true,
    description: 'Local/vendor field carrying availability information for acquisitions.',
    indicators: NO_INDICATORS,
    subfields: [sf('b', 'Availability status code'), sf('c', 'Expected acquisition status')],
  }),
  field({
    tag: '942', label: 'Added Entry Elements (Koha)', section: '9XX', is_koha_field: true,
    description: 'Koha-specific local configuration field: item type, classification scheme, call number pieces, and OPAC suppression. Not a standard MARC21 bibliographic field — treated as local/ILS configuration, distinct from the MARC21 vocabulary.',
    indicators: NO_INDICATORS,
    subfields: [
      sf('2', 'Source of classification or shelving scheme', { required: true }),
      sf('c', 'Koha/default item type', { required: true }),
      sf('e', 'Edition'),
      sf('h', 'Classification part'),
      sf('i', 'Item part'),
      sf('k', 'Call number prefix'),
      sf('m', 'Call number suffix'),
      sf('n', 'Suppress in OPAC'),
    ],
  }),
  field({
    tag: '952', label: 'Item Information (Koha)', section: '9XX', repeatable: true, is_koha_field: true,
    description: 'Koha-specific item-level holdings data (barcode, home/holding library, cost, etc.). Local/ILS configuration, not standard MARC21 bibliographic description.',
    indicators: NO_INDICATORS,
    subfields: [sf('a', 'Home library'), sf('b', 'Holding library'), sf('p', 'Barcode'), sf('y', 'Item type')],
  }),

  // -------------------------------------------------------------------
  // Minimal-definition stubs -- broaden section coverage without
  // fabricating subfield detail this file isn't confident about. Extend
  // these via the admin UI/DB before relying on their subfields.
  // -------------------------------------------------------------------
  stub('016', 'National Bibliographic Agency Control Number', '0XX', { repeatable: true }),
  stub('045', 'Time Period of Content', '0XX'),
  stub('046', 'Special Coded Dates', '0XX', { repeatable: true }),
  stub('047', 'Form of Musical Composition Code', '0XX', { repeatable: true }),
  stub('048', 'Number of Musical Instruments or Voices Code', '0XX', { repeatable: true }),
  stub('052', 'Geographic Classification', '0XX', { repeatable: true }),
  stub('055', 'Classification Numbers Assigned in Canada', '0XX', { repeatable: true }),
  stub('066', 'Character Sets Present', '0XX'),
  stub('070', 'National Agricultural Library Call Number', '0XX', { repeatable: true }),
  stub('072', 'Subject Category Code', '0XX', { repeatable: true }),
  stub('088', 'Report Number', '0XX', { repeatable: true }),
  stub('210', 'Abbreviated Title', '2XX', { repeatable: true }),
  stub('222', 'Key Title', '2XX', { repeatable: true }),
  stub('242', 'Translation of Title by Cataloging Agency', '2XX', { repeatable: true }),
  stub('306', 'Playing Time', '3XX'),
  stub('307', 'Hours, etc.', '3XX', { repeatable: true }),
  stub('310', 'Current Publication Frequency', '3XX'),
  stub('321', 'Former Publication Frequency', '3XX', { repeatable: true }),
  stub('342', 'Geospatial Reference Data', '3XX', { repeatable: true }),
  stub('343', 'Planar Coordinate Data', '3XX', { repeatable: true }),
  stub('344', 'Sound Characteristics', '3XX', { repeatable: true }),
  stub('345', 'Projection Characteristics of Moving Image', '3XX', { repeatable: true }),
  stub('346', 'Video Characteristics', '3XX', { repeatable: true }),
  stub('347', 'Digital File Characteristics', '3XX', { repeatable: true }),
  stub('348', 'Format of Notated Music', '3XX', { repeatable: true }),
  stub('351', 'Organization and Arrangement of Materials', '3XX', { repeatable: true }),
  stub('352', 'Digital Graphic Representation', '3XX', { repeatable: true }),
  stub('355', 'Security Classification Control', '3XX', { repeatable: true }),
  stub('357', 'Originator Dissemination Control', '3XX'),
  stub('363', 'Normalized Date and Sequential Designation', '3XX', { repeatable: true }),
  stub('370', 'Associated Place', '3XX'),
  stub('377', 'Associated Language', '3XX', { repeatable: true }),
  stub('380', 'Form of Work', '3XX', { repeatable: true }),
  stub('381', 'Other Distinguishing Characteristics of Work or Expression', '3XX', { repeatable: true }),
  stub('382', 'Medium of Performance', '3XX', { repeatable: true }),
  stub('383', 'Numeric Designation of Musical Work', '3XX', { repeatable: true }),
  stub('384', 'Key', '3XX'),
  stub('385', 'Audience Characteristics', '3XX', { repeatable: true }),
  stub('386', 'Creator/Contributor Characteristics', '3XX', { repeatable: true }),
  stub('388', 'Time Period of Creation', '3XX', { repeatable: true }),
  stub('507', 'Scale Note for Graphic Material', '5XX', { repeatable: true }),
  stub('513', 'Type of Report and Period Covered Note', '5XX', { repeatable: true }),
  stub('514', 'Data Quality Note', '5XX'),
  stub('515', 'Numbering Peculiarities Note', '5XX', { repeatable: true }),
  stub('516', 'Type of Computer File or Data Note', '5XX', { repeatable: true }),
  stub('518', 'Date/Time and Place of an Event Note', '5XX', { repeatable: true }),
  stub('532', 'Accessibility Note', '5XX', { repeatable: true }),
  stub('552', 'Entity and Attribute Information Note', '5XX', { repeatable: true }),
  stub('556', 'Information About Documentation Note', '5XX', { repeatable: true }),
];
