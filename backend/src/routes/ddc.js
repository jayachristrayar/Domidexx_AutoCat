import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { recommendDdc } from '../services/ddcClassificationService.js';
import { searchDdc } from '../services/ddcKnowledgeBase.js';
import { approveDdcDecision, getDdcDecision, saveDdcDecision, toMarc082Contract } from '../services/ddcApprovalService.js';
import { resolveAuthorizedModel, toProviderId, ModelNotAuthorizedError, CONTACT_EMAIL } from '../services/modelAccess.js';
import { labelToProvider, providerToLabel } from '../services/modelLabels.js';
import { recordUsage } from '../services/usageService.js';
const router=Router(); router.use(requireSession);
router.get('/search', asyncHandler(async(req,res)=>res.json({results:await searchDdc(req.query.q, Number(req.query.limit)||20)})));
router.post('/recommend', asyncHandler(async(req,res)=>{
  const metadata=req.body?.metadata||req.body||{};
  // Never trust the extension's own model selection -- verify it against
  // this account's server-side model_access grant before any provider is
  // ever called (product spec section 6/17/20: extension -> backend ->
  // authorized provider, never extension -> provider directly). The
  // extension only ever sends/receives the generic MODEL_1/MODEL_2 labels
  // (see modelLabels.js) -- labelToProvider returns null for anything else,
  // including a real provider name sent directly, which just falls through
  // to resolveAuthorizedModel's own default rather than granting anything.
  let model;
  try {
    model = resolveAuthorizedModel(req.user.modelAccess, labelToProvider(req.body?.model));
  } catch (error) {
    if (error instanceof ModelNotAuthorizedError) {
      return res.status(403).json({ error: error.message, error_class: 'model_access_error', contact_email: CONTACT_EMAIL });
    }
    throw error;
  }
  const provider = toProviderId(model);
  const decision=await recommendDdc(metadata, { provider });
  // Only log a usage row when the provider was actually called (ai_attempted)
  // -- when no AI provider is configured at all, recommendDdc silently falls
  // back to the rule-based engine with no request ever sent anywhere, and
  // logging a row for that would be fake usage data, not real activity.
  if (decision.ai_attempted) {
    recordUsage({
      userId: req.user.userId,
      provider,
      model: decision.ai_model,
      requestType: 'DDC',
      status: decision.classification_source === 'AI_ANALYZED' ? 'success' : 'failure',
    });
  }
  const row=await saveDdcDecision({userId:req.user.userId,metadata,decision});
  res.status(201).json({id:row.id,decision,model:providerToLabel(model)});
}));
router.get('/:id', asyncHandler(async(req,res)=>{ const row=await getDdcDecision(req.params.id,req.user.userId); if(!row) return res.status(404).json({error:'DDC decision not found'}); res.json({id:row.id,decision:row.decision_json,marc082:toMarc082Contract(row)}); }));
router.post('/:id/approve', asyncHandler(async(req,res)=>{ const row=await approveDdcDecision({id:req.params.id,userId:req.user.userId,action:req.body.action||'APPROVE',ddcNumber:req.body.ddc_number,approvedBy:req.body.approved_by||`user:${req.user.userId}`}); res.json({id:row.id,decision:row.decision_json,marc082:toMarc082Contract(row)}); }));
export default router;
