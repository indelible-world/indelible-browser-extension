/**
 * background.js — Indelible Verifier service worker
 *
 * Tracks which tabs contain Indelible-marked pages and manages the
 * extension action badge accordingly.
 */

const browserAPI = globalThis.browser ?? globalThis.chrome;

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<number, object>} tabId → extracted Indelible data */
const tabState = new Map();

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadge(tabId, hasIndelible) {
  if (hasIndelible) {
    browserAPI.action.setBadgeText({ tabId, text: 'I' });
    browserAPI.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    if (browserAPI.action.setBadgeTextColor) {
      browserAPI.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
  } else {
    browserAPI.action.setBadgeText({ tabId, text: '' });
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

browserAPI.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'INDELIBLE_DETECTED' && sender.tab) {
    tabState.set(sender.tab.id, msg.data);
    setBadge(sender.tab.id, true);
  }
});

// ── Tab lifecycle ─────────────────────────────────────────────────────────────

browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear state when a tab starts navigating to a new page.
  if (changeInfo.status === 'loading') {
    tabState.delete(tabId);
    setBadge(tabId, false);
  }
});

browserAPI.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});
