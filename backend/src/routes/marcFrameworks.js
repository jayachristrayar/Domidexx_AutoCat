// Extension/AI-facing MARC framework API. Read-only + validate; admin
// mutations (enable/disable, required, defaults, ordering) live under
// /admin (requireAdminSession), not here -- this router only needs a
// logged-in cataloguer session, matching records.js/ddc.js.
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import {
  listFrameworks,
  getFrameworkFieldTree,
  getFrameworkSections,
  getFrameworkConstraints,
  filterFieldsToFramework,
  exportFrameworkAsJson,
} from '../services/marcFrameworkService.js';
import { validateAgainstFramework, applyFrameworkDefaults } from '../services/marcFrameworkValidator.js';

const router = Router();

router.get(
  '/',
  requireSession,
  asyncHandler(async (_req, res) => {
    res.json({ frameworks: await listFrameworks() });
  })
);

router.get(
  '/:code',
  requireSession,
  asyncHandler(async (req, res) => {
    const tree = await getFrameworkFieldTree(req.params.code);
    if (!tree) return res.status(404).json({ error: `Unknown framework: ${req.params.code}` });
    res.json(tree);
  })
);

router.get(
  '/:code/sections',
  requireSession,
  asyncHandler(async (req, res) => {
    const result = await getFrameworkSections(req.params.code);
    if (!result) return res.status(404).json({ error: `Unknown framework: ${req.params.code}` });
    res.json(result);
  })
);

router.get(
  '/:code/constraints',
  requireSession,
  asyncHandler(async (req, res) => {
    try {
      res.json(await getFrameworkConstraints(req.params.code));
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  })
);

router.get(
  '/:code/export',
  requireSession,
  asyncHandler(async (req, res) => {
    const json = await exportFrameworkAsJson(req.params.code);
    if (!json) return res.status(404).json({ error: `Unknown framework: ${req.params.code}` });
    res.json(json);
  })
);

const fieldsSchema = z.object({
  fields: z.array(
    z.object({
      tag: z.string(),
      indicators: z.array(z.string().nullable()).nullable().optional(),
      subfields: z.array(z.object({ code: z.string().nullable(), value: z.string() })),
    })
  ),
});

router.post(
  '/:code/validate',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = fieldsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const result = await validateAgainstFramework(parsed.data.fields, req.params.code);
      res.status(result.valid ? 200 : 422).json(result);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  })
);

router.post(
  '/:code/apply-defaults',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = fieldsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const tree = await getFrameworkFieldTree(req.params.code);
    if (!tree) return res.status(404).json({ error: `Unknown framework: ${req.params.code}` });
    res.json({ fields: applyFrameworkDefaults(parsed.data.fields, tree.fields) });
  })
);

router.post(
  '/:code/filter',
  requireSession,
  asyncHandler(async (req, res) => {
    const parsed = fieldsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      res.json(await filterFieldsToFramework(parsed.data.fields, req.params.code));
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  })
);

export default router;
