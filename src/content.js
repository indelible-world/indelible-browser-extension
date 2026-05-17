/**
 * content.js — Indelible Verifier content script
 *
 * Mirrors the extraction logic from indelible.js to parse the
 * Indelible HTMLData Standard attributes from the live DOM.
 *
 * Communicates with the popup and background service worker via
 * the browser extension messaging API.
 */

import { extractPageData } from 'indelible';

const browserAPI = globalThis.browser ?? globalThis.chrome;

// ── Messaging ────────────────────────────────────────────────────────────────

// Respond to requests from the popup.
browserAPI.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_INDELIBLE_DATA') {
    sendResponse(extractPageData());
  }
  // Return true to keep the message channel open for async responses.
  return true;
});

// On initial load, notify the background service worker so it can set
// the extension badge for this tab.
(function notifyBackground() {
  const data = extractPageData();
  if (data) {
    browserAPI.runtime.sendMessage({ type: 'INDELIBLE_DETECTED', data });
  }
})();
