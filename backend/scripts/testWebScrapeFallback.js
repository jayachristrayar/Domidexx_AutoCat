import assert from 'assert';
import { extractPageMetadata } from '../src/services/webSearchScrape.js';

// JSON-LD Book schema, as a library catalogue / bookseller page commonly
// embeds it -- should be preferred over the looser meta-tag/regex fallback.
const jsonLdHtml = `<!doctype html><html><head>
<title>How to Prepare for Logical Reasoning for CAT - McGraw Hill</title>
<meta name="description" content="A fallback description">
<script type="application/ld+json">
{"@type":"Book","name":"How to Prepare for Logical Reasoning for CAT","author":[{"@type":"Person","name":"Arun Sharma"}],"publisher":{"@type":"Organization","name":"McGraw Hill Education"},"datePublished":"2021","bookEdition":"6th","isbn":"9789354600555","numberOfPages":"400","description":"A comprehensive guide to logical reasoning for the CAT exam.","genre":["Study Aids","Logical reasoning"]}
</script>
</head><body>DDC 160 Logic. Dewey 160.</body></html>`;

let meta = extractPageMetadata(jsonLdHtml, 'https://example.com/book');
assert.strictEqual(meta.title, 'How to Prepare for Logical Reasoning for CAT');
assert.deepStrictEqual(meta.authors, ['Arun Sharma']);
assert.strictEqual(meta.publisher, 'McGraw Hill Education');
assert.strictEqual(meta.publish_date, '2021');
assert.strictEqual(meta.edition, '6th');
assert.strictEqual(meta.pages, 400);
assert.strictEqual(meta.isbn_confirmed, '9789354600555');
assert.ok(meta.description.includes('logical reasoning'));
assert.ok(meta.subjects.includes('Study Aids'));
assert.ok(meta.existing_classifications.some((c) => c.number === '160'));

// No JSON-LD -- falls back to <title>/meta description/plain-text regexes.
const plainHtml = `<!doctype html><html><head>
<title>Introduction to Algorithms - Publisher Listing</title>
<meta property="og:description" content="A classic textbook on algorithms.">
</head><body>Publisher: MIT Press. 3rd edition. 1312 pages. Published 2009.</body></html>`;

meta = extractPageMetadata(plainHtml, 'https://example.com/algo');
assert.strictEqual(meta.title, 'Introduction to Algorithms - Publisher Listing');
assert.strictEqual(meta.publisher, 'MIT Press');
assert.strictEqual(meta.edition, '3rd edition');
assert.strictEqual(meta.pages, 1312);
assert.strictEqual(meta.publish_date, '2009');
assert.ok(meta.description.includes('classic textbook'));

// A page with nothing bibliographic at all -- extractPageMetadata still
// returns a shape (isbnLookup's caller decides to reject it based on
// missing title/description, not this function).
meta = extractPageMetadata('<html><head></head><body>unrelated content</body></html>', 'https://example.com/blank');
assert.strictEqual(meta.title, null);
assert.strictEqual(meta.description, null);

console.log('Web scrape fallback tests passed');
