/**
 * background.js — Indelible Verifier service worker
 *
 * Tracks which tabs (and which frames within them, including nested iframes)
 * contain Indelible-marked content, automatically verifies each detected
 * attestation and quote against the blockchain, and manages the extension
 * action badge accordingly.
 */

import {
  createRawCIDv1,
  verifyCid,
  verifyQuoteProof,
  createIndelibleClient,
  getChainKeyById,
  RESULT_CODE,
} from 'indelible';

const browserAPI = globalThis.browser ?? globalThis.chrome;

const DEFAULT_CHAIN = 'arbitrum';

/** How long GET_TAB_STATE waits for frames to re-report after a worker restart. */
const RESEND_WAIT_MS = 400;

// ── State ────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FrameEntry
 * @property {number} frameId
 * @property {string|null} docToken   Identifies the reporting document, so a late
 *   "gone" message from a previous document in the same frame is ignored.
 * @property {string|null} url        URL of the frame's document.
 * @property {string} signature       JSON of `data`, used to skip redundant reports.
 * @property {object} data            Extracted page data from the content script.
 * @property {boolean} verifying
 * @property {object|null} verification
 * @property {boolean} verifyError
 * @property {{ index: number, verified: boolean }[]|null} quoteResults
 */

/** @type {Map<number, Map<number, FrameEntry>>} tabId → frameId → entry */
const tabState = new Map();

/** @returns {Map<number, FrameEntry>} */
function framesFor(tabId) {
  let frames = tabState.get(tabId);
  if (!frames) {
    frames = new Map();
    tabState.set(tabId, frames);
  }
  return frames;
}

/** Whether `entry` is still the current entry for its frame (not superseded). */
function isCurrent(tabId, entry) {
  return tabState.get(tabId)?.get(entry.frameId) === entry;
}

// Pending "focus this quote when the popup opens" requests. Kept in extension
// storage so they survive service-worker termination; session storage is used
// when available so the request never outlives the browser session.
const focusStore = browserAPI.storage.session ?? browserAPI.storage.local;

const focusKey = (tabId) => `focusedQuote:${tabId}`;

// ── Badge helpers ─────────────────────────────────────────────────────────────

/**
 * Set the extension badge for a tab.
 *
 * @param {number} tabId
 * @param {'detected'|'verified'|'notFound'|'warning'|'revoked'|'error'|null} state
 */
function setBadge(tabId, state) {
  const BADGE_CONFIGS = {
    detected: { text: 'I', color: '#2563eb' },  // blue  — Indelible detected, verifying
    verified: { text: '✓', color: '#16a34a' },  // green — on-chain attestation found & valid
    notFound: { text: '?', color: '#6b7280' },  // grey  — no on-chain record found
    warning:  { text: '!', color: '#d97706' },  // amber — warning (e.g. multiple results)
    revoked:  { text: '✗', color: '#dc2626' },  // red   — attestation revoked
    error:    { text: '!', color: '#dc2626' },  // red   — verification error
  };

  const cfg = BADGE_CONFIGS[state];
  if (cfg) {
    browserAPI.action.setBadgeText({ tabId, text: cfg.text });
    browserAPI.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
    if (browserAPI.action.setBadgeTextColor) {
      browserAPI.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
  } else {
    browserAPI.action.setBadgeText({ tabId, text: '' });
  }
}

// Worst state first: a single failing frame dominates the tab badge, and a
// tab only shows "verified" once every frame has finished and verified.
const BADGE_PRIORITY = ['revoked', 'error', 'warning', 'notFound', 'detected', 'verified'];

/**
 * Badge state contributed by a single frame. Frames with an attested article
 * are judged on the article; quote-only frames are judged on their quotes.
 *
 * @param {FrameEntry} entry
 * @returns {string}
 */
function frameBadgeState(entry) {
  if (entry.data.text) {
    if (entry.verifyError) return 'error';
    if (!entry.verification) return 'detected';
    switch (entry.verification.primaryResultCode) {
      case RESULT_CODE.VERIFIED:   return 'verified';
      case RESULT_CODE.REVOKED:    return 'revoked';
      case RESULT_CODE.UNVERIFIED:
      case RESULT_CODE.WARNING:    return 'warning';
      default:                     return 'notFound';
    }
  }
  if (!entry.quoteResults) return 'detected';
  return entry.quoteResults.every(r => r.verified) ? 'verified' : 'warning';
}

/** Recompute and apply the action badge for a tab from all of its frames. */
function updateTabBadge(tabId) {
  const frames = tabState.get(tabId);
  if (!frames || frames.size === 0) {
    setBadge(tabId, null);
    return;
  }
  let worst = BADGE_PRIORITY.length - 1;
  for (const entry of frames.values()) {
    worst = Math.min(worst, BADGE_PRIORITY.indexOf(frameBadgeState(entry)));
  }
  setBadge(tabId, BADGE_PRIORITY[worst]);
}

// ── Auto-verification ─────────────────────────────────────────────────────────

/**
 * Deep-copy a value, converting BigInt to Number. Extension message passing
 * uses JSON serialisation, which throws on BigInt ("Could not serialize
 * message"); on-chain values such as attestation timestamps are BigInt.
 */
function toSerializable(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toSerializable(v)]),
    );
  }
  return value;
}

/**
 * Verify the Indelible article attestation reported by one frame.
 *
 * @param {number} tabId
 * @param {FrameEntry} entry
 */
async function autoVerify(tabId, entry) {
  const { data } = entry;
  if (!data.text) return; // Nothing to hash — quote-only frame.

  entry.verifying = true;

  try {
    const { customRpcUrls = {} } = await browserAPI.storage.sync.get({ customRpcUrls: {} });

    const chainId  = data.attestation?.chainId ?? null;
    const chainKey = (chainId != null && getChainKeyById(chainId)) || DEFAULT_CHAIN;
    const client   = createIndelibleClient(chainKey, customRpcUrls[chainKey]);

    const cid       = await createRawCIDv1(data.text);
    const authority = data.attestation?.authority ?? null;

    const verification = await verifyCid(client, cid, authority);

    // Persist the verification result so the popup can read it.
    // Serialise computed getters explicitly — they are lost when the object
    // crosses the message-passing boundary to the popup.
    entry.verification = {
      resultCode:        verification.resultCode,
      headline:          verification.headline,
      details:           verification.details,
      attestations:      toSerializable(verification.attestations),
      primaryResultCode: verification.primaryResultCode,
      cssClass:          verification.cssClass,
    };
  } catch (err) {
    console.error('[Indelible] Auto-verification failed:', err);
    entry.verifyError = true;
  } finally {
    entry.verifying = false;
  }

  if (isCurrent(tabId, entry)) updateTabBadge(tabId);
}

/**
 * Auto-verify every embedded quote reported by one frame, store the per-quote
 * results, and push them back to that frame so it can render inline badges.
 *
 * @param {number} tabId
 * @param {FrameEntry} entry
 */
async function autoVerifyQuotes(tabId, entry) {
  const quotes = Array.isArray(entry.data.quotes) ? entry.data.quotes : [];
  if (quotes.length === 0) return;

  const { customRpcUrls = {} } = await browserAPI.storage.sync.get({ customRpcUrls: {} });

  const results = await Promise.all(quotes.map(async (quote, index) => {
    try {
      const chainId  = quote.proofData?.chainId ?? null;
      const chainKey = (chainId != null && getChainKeyById(chainId)) || DEFAULT_CHAIN;
      const client   = createIndelibleClient(chainKey, customRpcUrls[chainKey]);

      const { verification, quoteText, allProofsValid } =
        await verifyQuoteProof(client, quote.proofData);

      // A quote is considered "verified" when its Merkle proofs are valid, the
      // source attestation is VERIFIED (not revoked/unverified), and the page
      // text matches the text committed in the proof.
      const isVerified =
        allProofsValid &&
        verification.primaryResultCode === RESULT_CODE.VERIFIED &&
        Boolean(quoteText) &&
        quoteText.includes(quote.text);

      return { index, verified: isVerified };
    } catch (err) {
      console.error('[Indelible] Quote auto-verification failed:', err);
      return { index, verified: false };
    }
  }));

  entry.quoteResults = results;
  if (!isCurrent(tabId, entry)) return;
  updateTabBadge(tabId);

  // Push the results to the reporting frame so it can render inline badges.
  try {
    await browserAPI.tabs.sendMessage(
      tabId,
      { type: 'QUOTE_RESULTS', results },
      { frameId: entry.frameId },
    );
  } catch (_) {
    // Content script may not be reachable — badges will simply not appear.
  }
}

/**
 * Ask every frame in a tab to report its Indelible data again. Used when the
 * service worker has lost its in-memory state (it is terminated when idle).
 */
async function requestResend(tabId) {
  try {
    await browserAPI.tabs.sendMessage(tabId, { type: 'RESEND_INDELIBLE' });
  } catch (_) {
    // No content script in this tab.
  }
}

/** Serialisable snapshot of a tab's frames for the popup, top frame first. */
function tabSnapshot(tabId) {
  const frames = [...(tabState.get(tabId)?.values() ?? [])]
    .sort((a, b) => a.frameId - b.frameId)
    .map(entry => ({
      frameId:      entry.frameId,
      url:          entry.url,
      data:         entry.data,
      verifying:    entry.verifying,
      verification: entry.verification,
      quoteResults: entry.quoteResults,
    }));
  return { frames };
}

// ── Message handling ──────────────────────────────────────────────────────────

browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INDELIBLE_FRAME_DATA' && sender.tab) {
    // A frame (top-level page or any nested iframe) reported Indelible content.
    const tabId     = sender.tab.id;
    const frameId   = sender.frameId ?? 0;
    const frames    = framesFor(tabId);
    // fullPageLength tracks unrelated page churn, so it doesn't count as a change.
    const { fullPageLength: _ignored, ...content } = msg.data ?? {};
    const signature = JSON.stringify(content);

    const existing = frames.get(frameId);
    if (existing && existing.signature === signature) {
      // Unchanged (e.g. a resend) — just refresh the document identity and
      // re-deliver any quote results so the frame can redraw its badges.
      existing.docToken = msg.docToken ?? existing.docToken;
      existing.data     = msg.data;
      if (existing.quoteResults) {
        browserAPI.tabs
          .sendMessage(tabId, { type: 'QUOTE_RESULTS', results: existing.quoteResults }, { frameId })
          .catch(() => {});
      }
      return;
    }

    /** @type {FrameEntry} */
    const entry = {
      frameId,
      docToken:     msg.docToken ?? null,
      url:          sender.url ?? null,
      signature,
      data:         msg.data,
      verifying:    false,
      verification: null,
      verifyError:  false,
      quoteResults: null,
    };
    frames.set(frameId, entry);
    updateTabBadge(tabId);
    autoVerify(tabId, entry);
    autoVerifyQuotes(tabId, entry);
    return;
  }

  if (msg.type === 'INDELIBLE_FRAME_GONE' && sender.tab) {
    const tabId   = sender.tab.id;
    const frameId = sender.frameId ?? 0;
    const frames  = tabState.get(tabId);
    const entry   = frames?.get(frameId);
    if (entry && (!msg.docToken || !entry.docToken || msg.docToken === entry.docToken)) {
      frames.delete(frameId);
      updateTabBadge(tabId);
    }
    return;
  }

  if (msg.type === 'OPEN_QUOTE_DETAILS' && sender.tab) {
    // A user clicked an inline quote badge on the page. Persist which quote to
    // focus, then open the popup. The request goes to session storage rather
    // than tabState because the service worker may have been terminated since
    // the page loaded, leaving tabState empty.
    const tabId = sender.tab.id;
    focusStore.set({
      [focusKey(tabId)]: { frameId: sender.frameId ?? 0, quoteIndex: msg.quoteIndex ?? null },
    }).catch(() => {});
    // Called synchronously in the same turn as the write so the user gesture
    // that Firefox requires for openPopup() is still active.
    browserAPI.action.openPopup?.()?.catch?.(() => {});
    return;
  }

  if (msg.type === 'GET_TAB_STATE') {
    const tabId = msg.tabId;
    if (tabState.get(tabId)?.size) {
      sendResponse(tabSnapshot(tabId));
      return;
    }
    // No state — likely a restarted service worker. Ask the frames to report
    // again and give them a moment before answering.
    requestResend(tabId);
    setTimeout(() => sendResponse(tabSnapshot(tabId)), RESEND_WAIT_MS);
    return true;
  }
});

// ── Tab lifecycle ─────────────────────────────────────────────────────────────

browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear state when a tab starts navigating to a new page.
  if (changeInfo.status === 'loading') {
    tabState.delete(tabId);
    focusStore.remove(focusKey(tabId)).catch(() => {});
    setBadge(tabId, null);
  } else if (changeInfo.status === 'complete') {
    // 'loading' also fires for some same-document (SPA) navigations, which
    // clear state while the frames stay alive; have them report again.
    requestResend(tabId);
  }
});

browserAPI.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  focusStore.remove(focusKey(tabId)).catch(() => {});
});
