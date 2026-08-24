import assert from 'assert';
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/autocat_test_placeholder';

const { extractPageMetadata } = await import('../src/services/webSearchScrape.js');
const { validatePageEvidence, mergePageEvidence, isbnVariants } = await import('../src/services/isbnLookup.js');
const { assertFetchableUrl } = await import('../src/services/urlSafety.js');

// -- Regression test for the reported bug (product spec item 6): a
// librarian on the exact publisher page for ISBN 9781032769226 must not
// be told "no reliable metadata found", even if every search engine and
// AI provider is unavailable -- because this evidence path never depends
// on any of them. This is a TEST FIXTURE only (product spec item 24: the
// generic pipeline, never a hardcoded production check for this ISBN) --
// nothing in isbnLookup.js/webSearchScrape.js branches on this or any
// other specific ISBN value.
const ROUTLEDGE_ISBN = '9781032769226';
const routledgeLikeHtml = `<!doctype html><html><head>
<title>Practice Research through Creative Bodies: Perspectives on Embodied Inquiry</title>
<script type="application/ld+json">
{
  "@type": "Book",
  "name": "Practice Research through Creative Bodies",
  "alternativeHeadline": "Perspectives on Embodied Inquiry",
  "author": [{"@type": "Person", "name": "Caroline Frizell"}, {"@type": "Person", "name": "Marina Rova"}],
  "publisher": {"@type": "Organization", "name": "Routledge"},
  "datePublished": "2025",
  "numberOfPages": "208",
  "isbn": "9781032769226",
  "description": "An exploration of practice research through creative and embodied bodies of inquiry."
}
</script>
</head><body>
<p>ISBN: 978-1-032-76922-6</p>
<p>Table of contents available. Subjects: Performance Studies, Practice Research.</p>
</body></html>`;

const variants = isbnVariants(ROUTLEDGE_ISBN);
const extracted = extractPageMetadata(routledgeLikeHtml, 'https://www.routledge.com/example/9781032769226', { isbnCandidates: variants });
assert.strictEqual(extracted.isbn_found_in_page, true, 'ISBN should be found in the page body text');
assert.strictEqual(extracted.isbn_confirmed, '9781032769226');

const pageEvidence = validatePageEvidence(extracted, variants, 'https://www.routledge.com/example/9781032769226');
assert.ok(pageEvidence, 'validatePageEvidence should accept a page that mentions the requested ISBN');
assert.strictEqual(pageEvidence.title, 'Practice Research through Creative Bodies');
assert.strictEqual(pageEvidence.subtitle, 'Perspectives on Embodied Inquiry');
assert.deepStrictEqual(pageEvidence.authors, ['Caroline Frizell', 'Marina Rova']);
assert.strictEqual(pageEvidence.publisher, 'Routledge');
assert.strictEqual(pageEvidence.publish_date, '2025');
assert.strictEqual(pageEvidence.physical_description.pages, 208);
assert.strictEqual(pageEvidence.sources.method, 'browser_page');

// mergePageEvidence must fill an otherwise-empty structured result (the
// exact "structured sources found nothing" scenario from the bug report)
// completely enough that isbnLookup.js's needsWebResearch check would see
// both a title AND content evidence (description/subjects) -- i.e. this
// alone is enough to avoid ever reaching "not found", with no search
// engine or AI call required.
const emptyStructured = {
  isbn: ROUTLEDGE_ISBN,
  title: null,
  subtitle: null,
  authors: [],
  editors: [],
  illustrators: [],
  translators: [],
  publisher: null,
  publish_date: null,
  edition: null,
  physical_description: { pages: null, dimensions: null },
  description: null,
  subjects: [],
  existing_classifications: [],
  series: null,
  language: null,
  table_of_contents: null,
  conflicts: [],
  sources: {},
};
const merged = mergePageEvidence(emptyStructured, pageEvidence);
assert.strictEqual(merged.title, 'Practice Research through Creative Bodies');
assert.strictEqual(merged.description, pageEvidence.description);
assert.ok(merged.sources.current_page, 'merged.sources.current_page should record where this evidence came from');

const hasTitle = Boolean(merged.title);
const hasContentEvidence = Boolean(merged.description) || merged.subjects.length > 0;
assert.ok(hasTitle && hasContentEvidence, 'page evidence alone must satisfy both needsWebResearch conditions');

// -- Validation must reject a page that is clearly about a DIFFERENT book
// (product spec item 5: "do not accept an unrelated book").
const wrongBookHtml = `<!doctype html><html><head>
<title>Some Other Book</title>
<script type="application/ld+json">
{"@type":"Book","name":"Some Other Book","isbn":"9780000000002","description":"Unrelated."}
</script>
</head><body>ISBN: 9780000000002</body></html>`;
const wrongExtracted = extractPageMetadata(wrongBookHtml, 'https://example.com/other-book', { isbnCandidates: variants });
assert.strictEqual(wrongExtracted.isbn_found_in_page, false);
const rejected = validatePageEvidence(wrongExtracted, variants, 'https://example.com/other-book');
assert.strictEqual(rejected, null, 'a page confirmed to be a different ISBN must be discarded, not used as evidence');

// A page with no ISBN mention at all (e.g. a search results page, a
// homepage) must also be discarded, even if it happens to have a title.
const irrelevantHtml = `<!doctype html><html><head><title>Random blog post</title></head><body>Nothing about books here.</body></html>`;
const irrelevantExtracted = extractPageMetadata(irrelevantHtml, 'https://example.com/blog', { isbnCandidates: variants });
assert.strictEqual(validatePageEvidence(irrelevantExtracted, variants, 'https://example.com/blog'), null);

// -- SSRF guard (product spec item 22-adjacent: this is the one fetch
// target in the whole research pipeline that comes directly from client
// input) -- must reject private/internal targets before any fetch happens.
await assert.rejects(() => assertFetchableUrl('http://127.0.0.1:8080/'), /private|internal/i);
await assert.rejects(() => assertFetchableUrl('http://localhost/'), /local/i);
await assert.rejects(() => assertFetchableUrl('http://169.254.169.254/latest/meta-data/'), /private|internal/i);
await assert.rejects(() => assertFetchableUrl('http://10.0.0.5/internal-api'), /private|internal/i);
await assert.rejects(() => assertFetchableUrl('ftp://example.com/file'), /http/i);
await assert.rejects(() => assertFetchableUrl('not a url'), /valid URL/i);

console.log('Page-evidence (browser current-page) regression tests passed');
