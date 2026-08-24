import { Router } from 'express';
import pool from '../db/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { modelAccessToLabels } from '../services/modelLabels.js';
import { getOwnApiStatus } from '../services/ownApiService.js';

const router = Router();

router.get(
  '/',
  requireSession,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT u.email, u.autocat_user_id, u.status, u.model_access, i.name AS institution_name
       FROM users u
       LEFT JOIN institutions i ON i.id = u.institution_id
       WHERE u.id = $1`,
      [req.user.userId]
    );

    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }

    // own_api is the same safe/masked shape ownApi.js's own GET / returns
    // (never a plaintext key) -- included here too so the side panel knows
    // on load whether "Your Own Model" is already connected, without a
    // second round trip on every page open.
    const ownApi = await getOwnApiStatus(req.user.userId);

    // Only safe, extension-facing fields -- never API keys, provider
    // credentials, internal subscription tier, or anything else a librarian
    // isn't meant to see (product spec section 10/20). model_access is
    // translated to the generic MODEL_1/MODEL_2 labels here -- the real
    // provider names (NVIDIA/OpenAI) never reach the extension at all.
    res.json({
      email: row.email,
      autocat_user_id: row.autocat_user_id,
      status: row.status,
      model_access: modelAccessToLabels(row.model_access),
      own_api: ownApi,
      institution_name: row.institution_name,
    });
  })
);

export default router;
