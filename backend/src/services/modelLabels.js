// The ONLY place the real provider names (NVIDIA/OpenAI) ever meet the
// generic labels the extension is allowed to see (MODEL_1/MODEL_2). The
// librarian-facing extension must never learn, display, or send an actual
// provider name -- product spec: "The librarian should think they are
// simply choosing between Model 1 / Model 2. They should NOT know which
// underlying AI provider is being used." The Admin Panel is the only place
// that still shows real provider names (it reads users.model_access
// straight from the database, never through this translation).
//
// This mapping is a fixed internal configuration, not a per-account or
// per-request choice -- exactly what the spec calls "backend
// configuration". Keeping it in one small module means every other file
// that talks to the extension (me.js, ddc.js, sidepanel.js's counterpart)
// goes through the same translation instead of hand-rolling it.
const LABEL_TO_PROVIDER = { MODEL_1: 'NVIDIA', MODEL_2: 'OPENAI' };
const PROVIDER_TO_LABEL = { NVIDIA: 'MODEL_1', OPENAI: 'MODEL_2' };

// labelToProvider(label) -- MODEL_1/MODEL_2 (case-insensitive) -> the real
// provider name, or null for anything else (including a real provider name
// sent directly, e.g. "OPENAI" -- the wire contract only recognizes
// labels, so naming a provider directly gains an attacker nothing; it just
// falls through to resolveAuthorizedModel's default).
export function labelToProvider(label) {
  const key = String(label ?? '').trim().toUpperCase();
  return LABEL_TO_PROVIDER[key] ?? null;
}

// providerToLabel(provider) -- 'NVIDIA'/'OPENAI' -> 'MODEL_1'/'MODEL_2',
// for translating anything provider-shaped back before it reaches the
// extension (a /me response, a DDC recommend response's echoed model).
export function providerToLabel(provider) {
  return PROVIDER_TO_LABEL[provider] ?? null;
}

// modelAccessToLabels(modelAccess) -- translates a users.model_access
// array (real provider names) into the generic labels /me sends the
// extension. Unrecognized entries are dropped rather than passed through,
// so a future provider added to the DB column never leaks its real name
// before this module is updated to name it.
export function modelAccessToLabels(modelAccess) {
  return (modelAccess ?? []).map(providerToLabel).filter(Boolean);
}
