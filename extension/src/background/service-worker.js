// MV3 background service worker. Kept minimal: session and API base URL live
// in chrome.storage.local and are read directly by the popup / content scripts.
chrome.runtime.onInstalled.addListener(() => {
  console.log('AutoCat extension installed');
});
