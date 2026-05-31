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

const HIGHLIGHT_STYLE_ID = 'indelible-highlight-style';
const HIGHLIGHT_CLASS    = 'indelible-highlight';
const EXCLUDE_CLASS      = 'indelible-excluded';

// ── Messaging ────────────────────────────────────────────────────────────────

// Respond to requests from the popup.
browserAPI.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_INDELIBLE_DATA') {
    const data = extractPageData();
    sendResponse(data ? { ...data, fullPageLength: document.body.innerText.length } : null);
  } else if (msg.type === 'HIGHLIGHT_INDELIBLE') {
    // Inject highlight styles (idempotent).
    if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
      const styleEl = document.createElement('style');
      styleEl.id = HIGHLIGHT_STYLE_ID;
      styleEl.textContent =
        `.${HIGHLIGHT_CLASS}{outline:2px solid #3730a3!important;background:rgba(55,48,163,.07)!important;box-shadow:0 0 0 1px rgba(55,48,163,.15)!important;}` +
        `.${EXCLUDE_CLASS}{outline:2px solid #cc3333!important;background:rgba(204,51,51,.07)!important;box-shadow:0 0 0 1px rgba(204,51,51,.15)!important;}`;
      document.head.appendChild(styleEl);
    }

    const root = document.querySelector('[data-indelible]');
    const includeEls = root ? Array.from(root.querySelectorAll('[data-indelible-include]')) : [];
    let highlighted;

    if (includeEls.length > 0) {
      // Inclusive mode: only the explicitly included fragments are attested.
      includeEls.forEach(el => el.classList.add(HIGHLIGHT_CLASS));
      highlighted = includeEls;
    } else if (root) {
      // Exclusive mode: the root is attested except for excluded subtrees.
      root.classList.add(HIGHLIGHT_CLASS);
      root.querySelectorAll('[data-indelible-exclude]').forEach(el => {
        el.classList.add(EXCLUDE_CLASS);
      });
      highlighted = [root];
    } else {
      highlighted = [];
    }

    sendResponse({ count: highlighted.length });
  } else if (msg.type === 'UNHIGHLIGHT_INDELIBLE') {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS},.${EXCLUDE_CLASS}`).forEach(el => {
      el.classList.remove(HIGHLIGHT_CLASS, EXCLUDE_CLASS);
    });
    const styleEl = document.getElementById(HIGHLIGHT_STYLE_ID);
    if (styleEl) styleEl.remove();
    sendResponse({ ok: true });
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
