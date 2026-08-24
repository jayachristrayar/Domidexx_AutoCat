// "Your Own Model" settings endpoints -- additive, entirely separate from
// Model 1/Model 2 (see modelAccess.js/modelLabels.js, both untouched by
// this file). Every route here is scoped to req.user.userId via
// requireSession; there is no way for one account to read or affect
// another's own_api_configs row (see ownApiService.js).
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { testOwnApiConnection } from '../llm/router.js';
import { saveOwnApiConfig, getOwnApiStatus } from '../services/ownApiService.js';

const router = Router();
router.use(requireSession);

// Only what the product spec asks for -- base URL + key. No provider,
// model, tier, or any other field is ever accepted here.
const configSchema = z.object({
  base_url: z.string().trim().url('Enter a valid API Base URL (e.g. https://api.example.com/v1)'),
  api_key: z.string().trim().min(1, 'API Key is required'),
});

// GET / -- the extension's settings screen calls this on load to show
// either the empty form or the saved (masked) configuration.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getOwnApiStatus(req.user.userId));
  })
);

// POST /test -- "Test Connection". Never persists anything -- Save is a
// separate, explicit step. The response never echoes the submitted key
// back, and failures report only a safe, generic reason (the real
// upstream error is logged server-side, not returned to the client).
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, message: parsed.error.issues[0]?.message || 'API Base URL and API Key are required.' });
    }
    const result = await testOwnApiConnection({ baseUrl: parsed.data.base_url, apiKey: parsed.data.api_key });
    if (!result.ok) {
      console.error(`ownApi/test: connection test failed for user ${req.user.userId}: ${result.reason}`);
      return res.json({ ok: false, message: 'Connection failed. Please check your API Base URL or API Key.' });
    }
    res.json({ ok: true, message: 'Connection successful' });
  })
);

// POST / -- Save. Re-tests before persisting (the product spec's own flow
// is "test, then allow Save" -- this also means a stale/invalid key can
// never silently get saved via a direct API call that skips the UI's own
// Test Connection click).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'API Base URL and API Key are required.' });
    }
    const result = await testOwnApiConnection({ baseUrl: parsed.data.base_url, apiKey: parsed.data.api_key });
    if (!result.ok) {
      console.error(`ownApi/save: connection test failed for user ${req.user.userId}: ${result.reason}`);
      return res.status(400).json({ error: 'Connection failed. Please check your API Base URL or API Key.' });
    }
    await saveOwnApiConfig(req.user.userId, parsed.data.base_url, parsed.data.api_key, result.model);
    res.status(201).json(await getOwnApiStatus(req.user.userId));
  })
);

export default router;
