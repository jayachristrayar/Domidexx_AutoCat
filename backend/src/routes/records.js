import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { lookupIsbn } from '../services/isbnLookup.js';

const router = Router();

const isbnParamSchema = z.object({
  isbn: z
    .string()
    .transform((value) => value.replace(/[-\s]/g, ''))
    .refine((value) => /^(?:\d{9}[\dXx]|\d{13})$/.test(value), {
      message: 'ISBN must be 10 digits (may end in X) or 13 digits',
    }),
});

router.get(
  '/lookup/:isbn',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = isbnParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await lookupIsbn(parsed.data.isbn);
    res.json(result);
  })
);

export default router;
