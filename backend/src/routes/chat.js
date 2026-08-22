import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { handleChatMessage } from '../services/chatService.js';

const router = Router();

const chatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  context: z
    .object({
      isbn: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      ddc: z
        .object({
          id: z.union([z.string(), z.number()]).optional(),
          decision: z.record(z.string(), z.any()).optional(),
        })
        .optional(),
      marc_ready: z.boolean().optional(),
    })
    .optional(),
});

router.post(
  '/',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = chatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const result = handleChatMessage(parsed.data);
    res.json(result);
  })
);

export default router;
