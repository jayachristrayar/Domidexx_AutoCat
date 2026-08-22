// P4: Koha MARC editor content script.
//
// Thin message-handling wrapper only. All DOM location/verification/write
// logic lives in kohaFillEngine.js, listed immediately before this file in
// manifest.json's content_scripts[].js array -- both files share the same
// isolated-world global scope, so this file reads the engine's API off
// `globalThis.AutoCatKohaFillEngine` rather than importing it. This file
// itself never manipulates the Koha DOM directly and never submits/saves
// the record; the cataloguer always clicks Save by hand.
//
// Runs only on Koha's cataloguing/addbiblio.pl pages (see manifest.json's
// narrowed content_scripts match pattern) — never on every page.

console.log('[AutoCat] Extension initialized on', location.href);

const engine = globalThis.AutoCatKohaFillEngine;
if (!engine) {
  console.error('[AutoCat] kohaFillEngine.js did not load before koha-fill.js — check manifest.json content_scripts order.');
} else {
  console.log('[AutoCat] Koha cataloguing page detected.');
}

// Koha's advanced MARC editor can still be rendering (or re-rendering, if
// the cataloguer switches framework) when the side panel's "Fill MARC" click
// reaches this content script. Rather than assuming the DOM is already
// settled, wait briefly for at least one MARC field row to exist, using a
// MutationObserver rather than a fixed sleep so a fast-rendering page
// isn't delayed and a slow one gets a real chance to finish.
// Verified against Koha's actual addbiblio.tt template: the cataloguing
// form's id is "f" (`<form id="f" name="f" action=".../addbiblio.pl">`),
// and each field row is `<li class="tag clearfix" id="tag_245_...">` --
// an earlier version of this file checked "#addbiblioform" and
// ".field[id^=\"tag_\"]", neither of which exists on a real Koha page,
// which is why field detection/filling silently found nothing there.
function isEditorReady() {
  return Boolean(document.querySelector('form#f, .tag[id^="tag_"]'));
}

function waitForEditorReady(timeoutMs = 8000) {
  if (isEditorReady()) return Promise.resolve(true);
  console.log('[AutoCat] MARC editor not detected yet, waiting for it to render…');
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (isEditorReady()) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      console.warn('[AutoCat] Timed out waiting for the MARC editor to render; attempting the fill anyway.');
      resolve(isEditorReady());
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Cheap, non-waiting readiness probe for the Koha connection status pill --
  // unlike AUTOCAT_DETECT_FIELDS this never waits for the editor to render,
  // so the side panel's status check stays fast even on a page that isn't
  // the cataloguing editor at all.
  if (message?.type === 'AUTOCAT_PING') {
    sendResponse({ status: 'ok', ready: isEditorReady() });
    return false;
  }

  if (message?.type === 'AUTOCAT_DETECT_FIELDS') {
    if (!engine) {
      sendResponse({ status: 'failed', error: 'engine_not_loaded' });
      return false;
    }
    (async () => {
      const ready = await waitForEditorReady();
      if (!ready) {
        console.error('[AutoCat] Unsupported Koha page: MARC editor not found.');
        sendResponse({ status: 'failed', error: 'marc_editor_not_found' });
        return;
      }
      const tags = engine.detectFields(document);
      console.log(`[AutoCat] MARC fields detected: ${tags.join(', ') || '(none)'}`);
      sendResponse({ status: 'ok', tags });
    })();
    return true;
  }

  if (message?.type !== 'AUTOCAT_KOHA_FILL') return false;

  if (!engine) {
    console.error('[AutoCat] Unsupported Koha page: autofill engine not loaded.');
    sendResponse({ status: 'failed', error: 'engine_not_loaded' });
    return false;
  }

  const plan = message.plan;
  if (!plan || !Array.isArray(plan.fields)) {
    console.error('[AutoCat] Fill request rejected: missing or malformed plan.');
    sendResponse({ status: 'failed', error: 'missing_or_malformed_plan' });
    return false;
  }

  (async () => {
    try {
      const ready = await waitForEditorReady();
      if (!ready) {
        console.error('[AutoCat] Unsupported Koha page: MARC editor not found.');
        sendResponse({ status: 'failed', error: 'marc_editor_not_found' });
        return;
      }
      const result = engine.runKohaFill(document, plan, { ddcApproved: Boolean(message.ddcApproved) });
      for (const f of result.filled) console.log(`[AutoCat] MARC field populated: ${f.tag}${f.subfield ? `$${f.subfield}` : ''}`);
      for (const f of result.skipped) console.log(`[AutoCat] Field not found: ${f.tag}${f.subfield ? `$${f.subfield}` : ''} (${f.reason})`);
      for (const f of result.failed) console.error(`[AutoCat] Field write failed: ${f.tag}${f.subfield ? `$${f.subfield}` : ''} (${f.reason})`);
      sendResponse(result);
    } catch (error) {
      console.error('[AutoCat] Koha fill failed:', error);
      sendResponse({ status: 'failed', error: String(error?.message ?? error) });
    }
  })();

  return true; // keep the message channel open for the async response above
});
