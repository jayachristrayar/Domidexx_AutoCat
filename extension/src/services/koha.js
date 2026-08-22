// Side-panel-facing client for talking to the Koha content script
// (kohaFillEngine.js / koha-fill.js) on the active tab. This is a
// separate concern from src/services/api.js (which talks to the AutoCat
// backend through the background worker) -- Koha DOM operations go
// directly from the side panel to the content script via
// chrome.tabs.sendMessage, matching the existing, tested P4 architecture.
// Every failure here is translated to a friendly message; nothing raw
// (error stacks, chrome.runtime.lastError text) is ever returned as-is.

class KohaConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KohaConnectionError';
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new KohaConnectionError('No active browser tab found.');
  }
  return tab;
}

async function sendToKoha(message) {
  const tab = await activeTab();
  try {
    const result = await chrome.tabs.sendMessage(tab.id, message);
    if (!result) {
      throw new KohaConnectionError('Open the Koha "Add MARC record" page and try again.');
    }
    return result;
  } catch (error) {
    if (error instanceof KohaConnectionError) throw error;
    // chrome.tabs.sendMessage rejects with "Receiving end does not exist"
    // when the active tab isn't a Koha cataloguing page -- the expected,
    // common case, not a bug.
    throw new KohaConnectionError('This isn’t a Koha "Add MARC record" page. Open it and try again.');
  }
}

export { KohaConnectionError };

export async function detectFields() {
  const result = await sendToKoha({ type: 'AUTOCAT_DETECT_FIELDS' });
  if (result.status !== 'ok') {
    throw new KohaConnectionError('Could not read MARC fields from this Koha page.');
  }
  return result.tags;
}

export async function fillKoha(plan, ddcApproved) {
  const result = await sendToKoha({ type: 'AUTOCAT_KOHA_FILL', plan, ddcApproved });
  if (result.status === 'failed' && !Array.isArray(result.filled)) {
    throw new KohaConnectionError('Could not fill the Koha MARC form. Open the "Add MARC record" page and try again.');
  }
  return result;
}
