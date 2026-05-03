/**
 * content.js — Indelible Verifier content script
 *
 * Mirrors the extraction logic from indelible.js to parse the
 * Indelible HTMLData Standard attributes from the live DOM.
 *
 * Communicates with the popup and background service worker via
 * chrome.runtime messaging.
 */

// ── Text extraction helpers (mirrors indelible.js) ──────────────────────────

/**
 * Collect visible text from `el`, recursively skipping any descendant
 * that carries `data-indelible-exclude`.
 *
 * @param {Element} el
 * @returns {string}
 */
function collectExclusive(el) {
  let result = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.hasAttribute('data-indelible-exclude')) continue;
      result += collectExclusive(node);
    }
  }
  return result;
}

/**
 * Collapse runs of whitespace into a single space and trim.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalise(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

// ── Main extraction ──────────────────────────────────────────────────────────

/**
 * Scan the current document for Indelible markup and return all
 * extracted data, or null if this page carries no Indelible content.
 *
 * @returns {{attestation: object|null, text: string, mode: string, quotes: Array}|null}
 */
function extractPageData() {
  const root = document.querySelector('[data-indelible]');
  if (!root) return null;

  // Parse the attestation metadata JSON (may be an empty object {}).
  let attestation = null;
  try {
    const raw = root.getAttribute('data-indelible').trim();
    if (raw) attestation = JSON.parse(raw);
  } catch (_) {
    // Leave attestation null — page is still Indelible-marked.
  }

  // Determine inclusion mode and extract attested text.
  const includes = Array.from(root.querySelectorAll('[data-indelible-include]'));

  let text, mode;

  if (includes.length > 0) {
    // Inclusive mode: only explicitly marked elements contribute text.
    mode = 'inclusive';
    const seen = new Set();
    const parts = [];

    for (const el of includes) {
      // Skip elements whose ancestor is already collected (nested marks).
      let dominated = false;
      for (const ancestor of seen) {
        if (ancestor.contains(el)) { dominated = true; break; }
      }
      if (dominated) continue;
      seen.add(el);
      parts.push(el.textContent);
    }

    text = normalise(parts.join(' '));
  } else {
    // Exclusive mode: everything inside root is attested except excluded subtrees.
    mode = 'exclusive';
    text = normalise(collectExclusive(root));
  }

  // Collect embedded quote proofs (data-indelible-quote attributes).
  const quoteElements = Array.from(document.querySelectorAll('[data-indelible-quote]'));
  const quotes = [];

  for (const el of quoteElements) {
    try {
      const proofData = JSON.parse(el.getAttribute('data-indelible-quote'));
      quotes.push({
        text: normalise(el.textContent),
        proofData,
      });
    } catch (_) {
      // Skip elements with malformed proof JSON.
    }
  }

  return { attestation, text, mode, quotes };
}

// ── Messaging ────────────────────────────────────────────────────────────────

// Respond to requests from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    chrome.runtime.sendMessage({ type: 'INDELIBLE_DETECTED', data });
  }
})();
