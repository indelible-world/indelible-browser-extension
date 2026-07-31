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

const BADGE_STYLE_ID = 'indelible-badge-style';
const BADGE_CLASS    = 'indelible-quote-badge';

/** @type {{ index: number, verified: boolean }[]} Last quote results from background. */
let lastQuoteResults = [];

/**
 * Inject the styles used for the inline quote verification badges (idempotent).
 */
function injectBadgeStyles() {
  if (document.getElementById(BADGE_STYLE_ID)) return;
  const styleEl = document.createElement('style');
  styleEl.id = BADGE_STYLE_ID;
  // The glyph is drawn with ::before so it never appears in textContent —
  // extractPageData() reads textContent to build the attested text and quote
  // text, and a real text node here would corrupt both.
  styleEl.textContent =
    `.${BADGE_CLASS}{display:inline-flex;align-items:center;justify-content:center;` +
    `width:1em;height:1em;margin-left:.25em;border-radius:50%;vertical-align:middle;` +
    `font-size:.85em;line-height:1;font-weight:700;font-family:system-ui,sans-serif;` +
    `color:#fff;cursor:pointer;user-select:none;-webkit-user-select:none;` +
    `box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .1s ease;}` +
    `.${BADGE_CLASS}:hover{transform:scale(1.15);}` +
    `.${BADGE_CLASS}--verified{background:#16a34a;}` +
    `.${BADGE_CLASS}--verified::before{content:'\\2713';}` +
    `.${BADGE_CLASS}--unverified{background:#dc2626;}` +
    `.${BADGE_CLASS}--unverified::before{content:'\\2715';}`;
  document.head.appendChild(styleEl);
}

/**
 * Find the deepest element inside `root` whose last non-empty text node lives,
 * so a badge appended there sits inline right after the quote's final word,
 * rather than on its own line after a block-level quote container.
 *
 * @param {Element} root
 * @returns {{ container: Node, refNode: Node | null }}
 *   `container` is the node to insert into and `refNode` is the node to insert
 *   before (its nextSibling), or null to append as the last child.
 */
function findInlineInsertionPoint(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue && node.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let lastText = null;
  while (walker.nextNode()) lastText = walker.currentNode;

  if (lastText && lastText.parentNode) {
    return { container: lastText.parentNode, refNode: lastText.nextSibling };
  }
  return { container: root, refNode: null };
}

/**
 * Render inline verification badges after each detected quote element.
 * The badge order matches the document order used by extractPageData(),
 * so `results[i]` corresponds to the i-th `[data-indelible-quote]` element.
 *
 * @param {{ index: number, verified: boolean }[]} results
 */
function renderQuoteBadges(results) {
  injectBadgeStyles();

  const quoteEls = Array.from(document.querySelectorAll('[data-indelible-quote]'));

  for (const { index, verified } of results) {
    const el = quoteEls[index];
    if (!el) continue;

    // Remove any previously rendered badge for this quote (idempotent).
    document
      .querySelectorAll(`.${BADGE_CLASS}[data-indelible-quote-index="${index}"]`)
      .forEach(node => node.remove());

    const badge = document.createElement('span');
    badge.className = `${BADGE_CLASS} ${verified ? `${BADGE_CLASS}--verified` : `${BADGE_CLASS}--unverified`}`;
    badge.dataset.indelibleQuoteIndex = String(index);
    badge.title = verified
      ? 'Indelible: quote verified — click for details'
      : 'Indelible: quote not verified — click for details';
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-label', badge.title);

    badge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      browserAPI.runtime.sendMessage({ type: 'OPEN_QUOTE_DETAILS', quoteIndex: index });
    });

    // Insert the badge inline, right after the quote's final piece of text, so
    // it sits next to the words rather than on its own line beneath a
    // block-level quote container.
    const { container, refNode } = findInlineInsertionPoint(el);
    container.insertBefore(badge, refNode);
  }
}

/**
 * Remove all inline quote badges from the page.
 */
function removeQuoteBadges() {
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach(node => node.remove());
}

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
  } else if (msg.type === 'QUOTE_RESULTS') {
    // Background finished auto-verifying quotes — render inline badges when
    // the feature is enabled (default on).
    lastQuoteResults = Array.isArray(msg.results) ? msg.results : [];
    browserAPI.storage.sync.get({ showQuoteBadges: true }).then(({ showQuoteBadges }) => {
      if (showQuoteBadges) renderQuoteBadges(lastQuoteResults);
      else removeQuoteBadges();
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'SET_QUOTE_BADGES') {
    // The user toggled the inline-badge setting in the popup.
    if (msg.enabled) renderQuoteBadges(lastQuoteResults);
    else removeQuoteBadges();
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
