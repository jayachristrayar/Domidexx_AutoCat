// P4: Koha MARC editor content script.
//
// Thin message-handling wrapper only. All DOM location/verification/write
// logic lives in kohaFillEngine.js (loaded dynamically below so the pure
// engine module stays independently unit-testable under Node — see
// backend/scripts/testKohaFillP4.js). This file itself never manipulates
// the Koha DOM directly and never submits/saves the record; the cataloguer
// always clicks Save by hand.
//
// Runs only on Koha's cataloguing/addbiblio.pl pages (see manifest.json's
// narrowed content_scripts match pattern) — never on every page.

let enginePromise = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = import(chrome.runtime.getURL('src/content-scripts/kohaFillEngine.js'));
  }
  return enginePromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'AUTOCAT_KOHA_FILL') return false;

  (async () => {
    try {
      const engine = await loadEngine();
      const plan = message.plan;
      if (!plan || !Array.isArray(plan.fields)) {
        sendResponse({ status: 'failed', error: 'missing_or_malformed_plan' });
        return;
      }
      const result = engine.runKohaFill(document, plan, { ddcApproved: Boolean(message.ddcApproved) });
      sendResponse(result);
    } catch (error) {
      sendResponse({ status: 'failed', error: String(error?.message ?? error) });
    }
  })();

  return true; // keep the message channel open for the async response
});
