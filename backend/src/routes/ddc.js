import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireSession } from '../middleware/requireSession.js';
import { recommendDdc } from '../services/ddcClassificationService.js';
import { classifyWithAi } from '../services/ddcAiClassifier.js';
import { searchDdc } from '../services/ddcKnowledgeBase.js';
import { approveDdcDecision, getDdcDecision, saveDdcDecision, toMarc082Contract } from '../services/ddcApprovalService.js';
import { resolveAuthorizedModel, toProviderId, ModelNotAuthorizedError, CONTACT_EMAIL } from '../services/modelAccess.js';
import { labelToProvider, providerToLabel } from '../services/modelLabels.js';
import { recordUsage } from '../services/usageService.js';
import { getOwnApiConfig } from '../services/ownApiService.js';
import { callOwnApi } from '../llm/router.js';
const router=Router(); router.use(requireSession);
router.get('/search', asyncHandler(async(req,res)=>res.json({results:await searchDdc(req.query.q, Number(req.query.limit)||20)})));

// "Your Own Model" branch -- entirely separate from the Model 1/Model 2
// path below (which is completely untouched): the client's model field is
// 'MODEL_OWN' instead of the usual MODEL_1/MODEL_2, so this is checked
// BEFORE resolveAuthorizedModel/toProviderId ever run, and neither of those
// (nor the FREE/PAID model_access grant they enforce) applies here at all
// -- an own-API connection is usable the moment the account has configured
// one, independent of subscription tier. Reuses the exact same
// recommendDdc()/classifyWithAi() pipeline Model 1/Model 2 use (same DDC 23
// prompt, same candidate grounding, same rule-based validation/fallback,
// same auto-accept-on-save) via classifyWithAi's existing `callModel`
// override -- never a separate/simplified AI workflow.
async function handleOwnModelRecommend(req, res) {
  const metadata = req.body?.metadata || req.body || {};
  const ownConfig = await getOwnApiConfig(req.user.userId);
  if (!ownConfig) {
    return res.status(403).json({
      error: 'Your Own Model is not connected yet. Add your API Base URL and API Key in AI Model settings.',
      error_class: 'own_api_not_configured',
    });
  }

  const startedAt = Date.now();
  const decision = await recommendDdc(metadata, {
    provider: 'own',
    classifyWithAiFn: (args) => classifyWithAi({ ...args, callModel: (prompt) => callOwnApi(prompt, ownConfig) }),
  });
  console.info(`ddc/recommend: classification for user ${req.user.userId} via own model took ${Date.now() - startedAt}ms (source=${decision.classification_source})`);

  if (decision.ai_attempted) {
    recordUsage({
      userId: req.user.userId,
      provider: 'own',
      model: decision.ai_model,
      requestType: 'DDC',
      status: decision.classification_source === 'AI_ANALYZED' ? 'success' : 'failure',
    });
  }

  const row = await saveDdcDecision({ userId: req.user.userId, metadata, decision });
  res.status(201).json({ id: row.id, decision: row.decision_json, model: 'MODEL_OWN' });
}

router.post('/recommend', asyncHandler(async(req,res)=>{
  if (String(req.body?.model || '').trim().toUpperCase() === 'MODEL_OWN') {
    return handleOwnModelRecommend(req, res);
  }
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
  const ddcStartedAt = Date.now();
  const decision=await recommendDdc(metadata, { provider });
  console.info(`ddc/recommend: classification for user ${req.user.userId} via ${provider} took ${Date.now() - ddcStartedAt}ms (source=${decision.classification_source})`);
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
  // saveDdcDecision auto-accepts the recommendation as the current working
  // classification (approval_status/approved_ddc set on the stored row) --
  // return that stored version, not the pre-save `decision`, so the client
  // never needs a separate approve call before it can generate MARC.
  const row=await saveDdcDecision({userId:req.user.userId,metadata,decision});
  res.status(201).json({id:row.id,decision:row.decision_json,model:providerToLabel(model)});
}));
router.get('/:id', asyncHandler(async(req,res)=>{ const row=await getDdcDecision(req.params.id,req.user.userId); if(!row) return res.status(404).json({error:'DDC decision not found'}); res.json({id:row.id,decision:row.decision_json,marc082:toMarc082Contract(row)}); }));
router.post('/:id/approve', asyncHandler(async(req,res)=>{ const row=await approveDdcDecision({id:req.params.id,userId:req.user.userId,action:req.body.action||'APPROVE',ddcNumber:req.body.ddc_number,approvedBy:req.body.approved_by||`user:${req.user.userId}`}); res.json({id:row.id,decision:row.decision_json,marc082:toMarc082Contract(row)}); }));
export default router;
