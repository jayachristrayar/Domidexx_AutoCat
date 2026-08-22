// Koha cataloguing editor auto-fill. Detects common Koha MARC editor field
// name patterns and fills them when the popup/background asks. Safe no-op on
// non-Koha pages.
const KOHA_FIELD_HINTS = [
  { key: 'title', selectors: ['input[name="field_245a"]', 'input[id*="tag_245_subfield_a"]'] },
  { key: 'author', selectors: ['input[name="field_100a"]', 'input[id*="tag_100_subfield_a"]'] },
  { key: 'isbn', selectors: ['input[name="field_020a"]', 'input[id*="tag_020_subfield_a"]'] },
  { key: 'publisher', selectors: ['input[name="field_260b"]', 'input[id*="tag_260_subfield_b"]', 'input[id*="tag_264_subfield_b"]'] },
];

function fillKohaFields(record) {
  if (!record || typeof record !== 'object') return { filled: 0 };

  let filled = 0;
  for (const hint of KOHA_FIELD_HINTS) {
    const value = record[hint.key];
    if (!value) continue;
    for (const selector of hint.selectors) {
      const input = document.querySelector(selector);
      if (input && 'value' in input) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled += 1;
        break;
      }
    }
  }
  return { filled };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'AUTOCAT_FILL_KOHA') {
    sendResponse(fillKohaFields(message.record));
    return true;
  }
  return false;
});
