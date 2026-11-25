/**
 * content.js — Indelible Verifier content script
 *
 * Mirrors the extraction logic from indelible.js to parse the
 * Indelible HTMLData Standard attributes from the live DOM.
 *
 * Communicates with the popup and background service worker via
 * the browser extension messaging API.
 */

import { extractPageData, normalise } from 'indelible/utils';

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

/**
 * Extract Indelible data from the page. Falls back to a quote-only result when
 * the page embeds `data-indelible-quote` proofs without a `data-indelible`
 * root (e.g. a standalone page of quotes from other attested sources).
 *
 * @returns {{ attestation: object|null, text: string, quotes: Array, quoteOnly?: boolean } | null}
 */
function getPageData() {
  const data = extractPageData();
  if (data) return data;

  const quotes = [];
  for (const el of document.querySelectorAll('[data-indelible-quote]')) {
    try {
      quotes.push({
        text: normalise(el.textContent),
        proofData: JSON.parse(el.getAttribute('data-indelible-quote')),
      });
    } catch (_) {
      // Skip elements with malformed proof JSON (mirrors extractPageData).
    }
  }
  return quotes.length > 0 ? { attestation: null, text: '', quotes, quoteOnly: true } : null;
}

// ── Frame reporting ─────────────────────────────────────────────────────────
//
// This script runs in every frame (manifest `all_frames`), including nested
// and sandboxed/srcdoc/blob iframes such as Claude artifacts. Each frame
// reports only its own document; the background worker aggregates frames per
// tab. Pages that render content after load (SPAs, artifact viewers) are
// handled by re-scanning on DOM mutations and re-reporting when the extracted
// data changes.

const RESCAN_DELAY_MS = 500;
const WATCHED_ATTRIBUTES = [
  'data-indelible',
  'data-indelible-quote',
  'data-indelible-include',
  'data-indelible-exclude',
];

/** Identifies this document to the background worker (see INDELIBLE_FRAME_GONE). */
const DOC_TOKEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** JSON of the last data reported, used to skip redundant reports. */
let lastSignature = null;
/** Whether this frame currently has data registered with the background. */
let reported = false;
let rescanTimer = null;
let observer = null;

function extensionAlive() {
  try {
    return Boolean(browserAPI.runtime?.id);
  } catch (_) {
    return false;
  }
}

function send(message) {
  try {
    const result = browserAPI.runtime.sendMessage(message);
    result?.catch?.(() => {});
  } catch (_) {
    // Extension was reloaded or removed — stop watching this document.
    observer?.disconnect();
  }
}

/**
 * Scan this document and report its Indelible data to the background worker
 * if it changed since the last report.
 *
 * @param {boolean} [force]  Report even if unchanged (e.g. after the worker restarted).
 */
function scanAndReport(force = false) {
  if (!extensionAlive()) {
    observer?.disconnect();
    return;
  }

  const data = getPageData();
  const signature = JSON.stringify(data);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  if (data) {
    // The previous badges belong to the old data; fresh results will follow.
    lastQuoteResults = [];
    removeQuoteBadges();
    send({
      type: 'INDELIBLE_FRAME_DATA',
      docToken: DOC_TOKEN,
      data: { ...data, fullPageLength: document.body?.innerText.length ?? 0 },
    });
    reported = true;
  } else if (reported) {
    removeQuoteBadges();
    send({ type: 'INDELIBLE_FRAME_GONE', docToken: DOC_TOKEN });
    reported = false;
  }
}

function scheduleRescan() {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    scanAndReport();
  }, RESCAN_DELAY_MS);
}

// ── Messaging ────────────────────────────────────────────────────────────────

// Respond to requests from the popup.
browserAPI.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RESEND_INDELIBLE') {
    // The background worker lost its state (e.g. it was restarted) — report again.
    scanAndReport(true);
    sendResponse({ ok: true });
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

// Report on initial load, then keep watching for content rendered later.
scanAndReport();

observer = new MutationObserver(scheduleRescan);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: WATCHED_ATTRIBUTES,
});

// Unregister this frame when its document goes away (iframe removed or
// navigated), and re-register if it is restored from the back/forward cache.
window.addEventListener('pagehide', () => {
  if (reported) send({ type: 'INDELIBLE_FRAME_GONE', docToken: DOC_TOKEN });
  reported = false;
  lastSignature = null;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) scanAndReport(true);
});
