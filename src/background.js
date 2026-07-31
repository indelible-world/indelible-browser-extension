/**
 * background.js — Indelible Verifier service worker
 *
 * Tracks which tabs contain Indelible-marked pages, automatically verifies
 * each detected attestation against the blockchain, and manages the
 * extension action badge accordingly.
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

const DEFAULT_CHAIN = 'sepolia';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<number, object>} tabId → { data, verification? } */
const tabState = new Map();

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
 * Verify the Indelible attestation for a tab and update its badge.
 *
 * @param {number} tabId
 * @param {object} data  Extracted page data from the content script.
 */
async function autoVerify(tabId, data) {
  if (!data.text) return; // Nothing to hash — keep the 'detected' badge.

  const entry = tabState.get(tabId);
  if (entry) entry.verifying = true;

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
    const entry = tabState.get(tabId);
    if (entry) {
      entry.verifying = false;
      entry.verification = {
        resultCode:        verification.resultCode,
        headline:          verification.headline,
        details:           verification.details,
        attestations:      toSerializable(verification.attestations),
        primaryResultCode: verification.primaryResultCode,
        cssClass:          verification.cssClass,
      };
    }

    switch (verification.primaryResultCode) {
      case RESULT_CODE.VERIFIED:
        setBadge(tabId, 'verified');
        break;
      case RESULT_CODE.REVOKED:
        setBadge(tabId, 'revoked');
        break;
      case RESULT_CODE.UNVERIFIED:
      case RESULT_CODE.WARNING:
        setBadge(tabId, 'warning');
        break;
      case RESULT_CODE.NOT_FOUND:
      default:
        setBadge(tabId, 'notFound');
    }
  } catch (err) {
    console.error('[Indelible] Auto-verification failed:', err);
    const entry = tabState.get(tabId);
    if (entry) entry.verifying = false;
    setBadge(tabId, 'error');
  }
}

/**
 * Auto-verify every embedded quote for a tab, store the per-quote results,
 * and push them to the content script so it can render inline check/✗ badges.
 *
 * @param {number} tabId
 * @param {object} data  Extracted page data from the content script.
 */
async function autoVerifyQuotes(tabId, data) {
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];
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

  const entry = tabState.get(tabId);
  if (entry) entry.quoteResults = results;

  // Push the results to the content script so it can render inline badges.
  try {
    await browserAPI.tabs.sendMessage(tabId, { type: 'QUOTE_RESULTS', results });
  } catch (_) {
    // Content script may not be reachable — badges will simply not appear.
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INDELIBLE_DETECTED' && sender.tab) {
    const tabId = sender.tab.id;
    tabState.set(tabId, {
      data: msg.data,
      verifying: false,
      verification: null,
      quoteResults: null,
    });
    setBadge(tabId, 'detected');
    autoVerify(tabId, msg.data);
    autoVerifyQuotes(tabId, msg.data);
    return;
  }

  if (msg.type === 'OPEN_QUOTE_DETAILS' && sender.tab) {
    // A user clicked an inline quote badge on the page. Persist which quote to
    // focus, then open the popup. The request goes to session storage rather
    // than tabState because the service worker may have been terminated since
    // the page loaded, leaving tabState empty.
    const tabId = sender.tab.id;
    focusStore.set({ [focusKey(tabId)]: msg.quoteIndex ?? null }).catch(() => {});
    // Called synchronously in the same turn as the write so the user gesture
    // that Firefox requires for openPopup() is still active.
    browserAPI.action.openPopup?.()?.catch?.(() => {});
    return;
  }

  if (msg.type === 'GET_VERIFICATION_RESULT') {
    const entry = tabState.get(msg.tabId);
    if (entry) {
      sendResponse({
        verification: entry.verification ?? null,
        verifying: entry.verifying ?? false,
        quoteResults: entry.quoteResults ?? null,
      });
    } else {
      sendResponse(null);
    }
    return true;
  }
});

// ── Tab lifecycle ─────────────────────────────────────────────────────────────

browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear state when a tab starts navigating to a new page.
  if (changeInfo.status === 'loading') {
    tabState.delete(tabId);
    focusStore.remove(focusKey(tabId)).catch(() => {});
    setBadge(tabId, false);
  }
});

browserAPI.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  focusStore.remove(focusKey(tabId)).catch(() => {});
});
