import pool from '../db/index.js';

// findCandidateDdcNumbers(keywords) -- full-text search against
// ddc_relative_index.search_vector for a set of subject/title keywords
// pulled off a book's bibliographic data, returning the top 10 candidate
// { term, ddc_number, qualifier } rows for the LLM router (Task 7) to pick
// an 082 classification from real index entries instead of guessing.
//
// Uses OR semantics across keywords (each keyword phrase becomes its own
// plainto_tsquery, combined with tsquery `||`), not a strict AND across
// every keyword: the extraction can't reliably attach a sub-entry's parent
// term (see marcBuilder... actually see the DDC extraction script -- the
// scanned index's indentation isn't a reliable main/sub-entry signal, so
// many rows are bare single-word terms like "literature" or "cooking" with
// no qualifying context baked in). Requiring every keyword to match a
// single short index term would return nothing for realistic keyword sets;
// ranking by how many/how well keywords match (ts_rank) surfaces the best
// candidates instead.
export async function findCandidateDdcNumbers(keywords) {
  const cleaned = (keywords ?? []).map((keyword) => (keyword ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const queryExpr = cleaned.map((_, index) => `plainto_tsquery('english', $${index + 1})`).join(' || ');

  const { rows } = await pool.query(
    `SELECT term, ddc_number, qualifier, ts_rank(search_vector, query) AS rank
     FROM ddc_relative_index, (SELECT ${queryExpr} AS query) q
     WHERE search_vector @@ query
     ORDER BY rank DESC
     LIMIT 10`,
    cleaned
  );

  return rows.map((row) => ({ term: row.term, ddc_number: row.ddc_number, qualifier: row.qualifier }));
}
