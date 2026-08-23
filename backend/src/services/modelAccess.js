// Single source of truth for "which AI provider is this account allowed to
// use right now" -- every AI-touching endpoint (currently just
// POST /api/ddc/recommend; add future ones here too) must call
// resolveAuthorizedModel before ever invoking a provider. The extension's
// own model dropdown is a UI convenience only; it is never trusted --
// a manually crafted request naming an unauthorized model is rejected here,
// on the server, not by the frontend choosing not to show the option.
const KNOWN_MODELS = ['NVIDIA', 'OPENAI'];
const DEFAULT_MODEL = 'NVIDIA';

// Never mentions tiers/plans/pricing -- this is the exact message contract
// item 6/19 of the spec require: safe, generic, and the same regardless of
// which model was requested (the extension composes the richer two-line
// "contact the administrator" copy client-side once it knows which model it
// asked for).
const CONTACT_EMAIL = 'team.domidexx@gmail.com';

export class ModelNotAuthorizedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelNotAuthorizedError';
    this.contactEmail = CONTACT_EMAIL;
  }
}

// resolveAuthorizedModel(modelAccess, requestedModel) -- normalizes the
// requested model name and verifies it against the account's server-side
// grant (req.user.modelAccess, sourced from users.model_access). Throws
// ModelNotAuthorizedError (never silently substitutes a different provider)
// when the model name is unrecognized or not in modelAccess. Returns the
// normalized model name ('NVIDIA' | 'OPENAI') on success.
export function resolveAuthorizedModel(modelAccess, requestedModel) {
  const requested = String(requestedModel || DEFAULT_MODEL).trim().toUpperCase();
  if (!KNOWN_MODELS.includes(requested)) {
    throw new ModelNotAuthorizedError('Access to this AI model is not enabled for your account.');
  }
  const access = Array.isArray(modelAccess) && modelAccess.length > 0 ? modelAccess : [DEFAULT_MODEL];
  if (!access.includes(requested)) {
    throw new ModelNotAuthorizedError('Access to this AI model is not enabled for your account.');
  }
  return requested;
}

// The llm/router.js provider-calling primitives (callOpenAi/callNvidia) key
// off lowercase 'openai'/'nvidia' -- this is the one place that mapping
// happens, so a model name never gets hand-translated ad hoc at each call
// site.
export function toProviderId(model) {
  return model === 'OPENAI' ? 'openai' : 'nvidia';
}

export { CONTACT_EMAIL, DEFAULT_MODEL, KNOWN_MODELS };
