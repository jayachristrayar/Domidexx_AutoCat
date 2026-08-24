import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { lookupIsbn, researchIsbnOnWeb } from '../services/isbnLookup.js';
import { generateMarcRecord } from '../services/marcPipeline.js';

const router = Router();

// A librarian-readable plain-text rendering of the generated fields, stored
// alongside marc_json purely for the admin Records detail page -- not a
// formal ISO2709 export.
function buildMarcText(preview) {
  return (preview || [])
    .map((row) => `${row.tag}  ${row.indicators || '  '}  ${(row.value || '').trim()}`.trimEnd())
    .join('\n');
}

// Persists exactly one thing: an actual MARC record generation (product
// spec section 7/8 -- an ISBN lookup on its own is an operational action,
// never a stored record; the Records page must only ever show what this
// saves). Never blocks/fails the actual generate-marc response over a save
// error -- the librarian's workflow must not break because of an admin
// reporting concern.
async function saveMarcRecord({ userId, result }) {
  try {
    await pool.query(
      `INSERT INTO marc_records (user_id, isbn, marc_json, marc_text, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        result.metadata?.isbn || null,
        JSON.stringify(result.fields),
        buildMarcText(result.preview),
        result.validation.valid ? 'COMPLETED' : 'NEEDS_REVIEW',
      ]
    );
  } catch (error) {
    console.error(`generate-marc: failed to save marc_records row: ${error.message}`);
  }
}

const isbnParamSchema = z.object({
  isbn: z
    .string()
    .transform((value) => value.replace(/[-\s]/g, ''))
    .refine((value) => /^(?:\d{9}[\dXx]|\d{13})$/.test(value), {
      message: 'ISBN must be 10 digits (may end in X) or 13 digits',
    }),
});

// Allowlists the fields sent to the extension. lookupIsbn's internal result
// can carry provider/model names and raw source payloads (for our own
// audit/debugging) -- none of that is provider-identifying info the client
// is allowed to see, so this only copies known-safe fields across and
// reduces "where did this come from" to the single provenance signal.
function toClientResponse(result) {
  const response = {
    isbn: result.isbn,
    title: result.title,
    subtitle: result.subtitle,
    authors: result.authors,
    editors: result.editors,
    illustrators: result.illustrators,
    translators: result.translators,
    publisher: result.publisher,
    publish_date: result.publish_date,
    edition: result.edition,
    physical_description: result.physical_description,
    description: result.description,
    subjects: result.subjects,
    series: result.series,
    language: result.language,
    table_of_contents: result.table_of_contents,
    // Existing classification evidence (e.g. a Dewey number already on a
    // library catalogue record) -- supporting evidence for the DDC
    // pipeline and for the Side Panel's "evidence used" section, never a
    // value the client is meant to trust/copy on its own.
    existing_classifications: result.existing_classifications,
  };

  if (result.not_found) {
    response.not_found = true;
  } else {
    response.provenance =
      result.sources?.method === 'web_search' || result.sources?.method === 'web_scrape' ? 'unverified' : 'catalog_match';
    response.partial = Boolean(result.partial);
  }

  return response;
}

router.get(
  '/lookup/:isbn',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = isbnParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await lookupIsbn(parsed.data.isbn, req.user.subscriptionTier, {
      userId: req.user.userId,
    });
    res.json(toClientResponse(result));
  })
);

// citationLabel(citation) -- a librarian-facing "source" label: the page
// title when the search returned one, otherwise the bare hostname. Never
// the provider/model name -- that stays server-side regardless.
function citationLabel(citation) {
  if (citation.title) return citation.title;
  try {
    return new URL(citation.url).hostname.replace(/^www\./, '');
  } catch {
    return citation.url;
  }
}

// evidenceStatus -- a plain High/Medium/Low signal for the chat "check the
// web" result (product spec: "EVIDENCE STATUS"), derived from how many
// substantive fields were actually found and how many sources back them,
// never fabricated.
function evidenceStatus(result, sourceCount) {
  const richFieldCount = ['title', 'authors', 'publisher', 'publish_date', 'description'].filter(
    (field) => !(result[field] == null || result[field] === '' || (Array.isArray(result[field]) && result[field].length === 0))
  ).length;
  if (richFieldCount >= 4 && sourceCount >= 2) return 'High';
  if (richFieldCount >= 2) return 'Medium';
  return 'Low';
}

// toResearchClientResponse -- like toClientResponse, but for the chat
// "check the web" / "check complete web" action specifically: this is the
// one place citation sources ARE deliberately shown to the librarian (as
// plain title/hostname labels, via citationLabel), per that feature's own
// requirement to display "Sources found". Provider/model names are still
// never included, here or anywhere else.
function toResearchClientResponse(result) {
  if (result.not_found) {
    return { isbn: result.isbn, not_found: true };
  }
  const citations = result.sources?.citations ?? [];
  return {
    ...toClientResponse(result),
    sources_found: citations.map(citationLabel),
    evidence_status: evidenceStatus(result, citations.length),
  };
}

router.post(
  '/research/:isbn',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = isbnParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const deep = Boolean(req.body?.deep);
    const result = await researchIsbnOnWeb(parsed.data.isbn, { userId: req.user.userId, deep });
    res.json(toResearchClientResponse(result));
  })
);

router.post(
  '/generate-marc',
  requireSession,
  asyncHandler(async (req, res) => {
    const result = generateMarcRecord(req.body ?? {});
    await saveMarcRecord({ userId: req.user.userId, result });
    res.status(result.validation.valid ? 201 : 422).json(result);
  })
);

export default router;
