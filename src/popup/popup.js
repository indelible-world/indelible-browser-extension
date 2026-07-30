/**
 * popup.js — Indelible Verifier popup logic
 *
 * Mirrors the verification functionality of the indelible-static site's
 * verify.js, adapted for the Chrome extension popup context.
 *
 * Flow:
 *  1. On open, query the active tab's content script for extracted
 *     Indelible data (attestation metadata + attested text + embedded quotes).
 *  2. Auto-populate the Article form fields from the extracted data.
 *  3. Allow the user to verify the article CID or any detected quotes
 *     against the blockchain using indelible-protocol.
 */

import {
  createRawCIDv1,
  downloadJson,
  verifyCid,
  verifyQuoteProof,
  CHAINS,
  CHAIN_DISPLAY_NAMES,
  createIndelibleClient,
  getChainKeyById,
  prettifyTimestamp,
  getCIDFromRawDigest,
  ens,
} from 'indelible';

const browserAPI = globalThis.browser ?? globalThis.chrome;

// ── DOM references ───────────────────────────────────────────────────────────

const settingsToggle       = document.getElementById('settingsToggle');
const settingsPanel        = document.getElementById('settingsPanel');
const chainSelect          = document.getElementById('chainSelect');
const rpcInput             = document.getElementById('rpcInput');
const showBadgesToggle     = document.getElementById('showBadgesToggle');

const tabBtns              = document.querySelectorAll('.tab-btn');
const tabArticle           = document.getElementById('tab-article');
const tabQuotes            = document.getElementById('tab-quotes');

const pageStatus           = document.getElementById('pageStatus');

// Article tab
const articleForm          = document.getElementById('articleForm');
const articleInput         = document.getElementById('articleInput');
const cidField             = document.getElementById('cidField');
const authorityInput       = document.getElementById('authorityInput');
const verifyButton         = document.getElementById('verifyButton');
const verifyStatus         = document.getElementById('verifyStatus');
const verifyResult         = document.getElementById('verifyResult');
const verifyHeading        = document.getElementById('verifyHeading');
const verifyDetails        = document.getElementById('verifyDetails');
const downloadVerifyRefBtn = document.getElementById('downloadVerifyRefButton');
const childCidSection      = document.getElementById('childCidSection');
const childCidValue        = document.getElementById('childCidValue');
const childCidVerifyLink   = document.getElementById('childCidVerifyLink');

// Quotes tab
const noQuotesMsg          = document.getElementById('noQuotesMsg');
const quotesContainer      = document.getElementById('quotesContainer');

// Domain authority section
const domainSection        = document.getElementById('domainSection');
const domainResult         = document.getElementById('domainResult');
const domainHeading        = document.getElementById('domainHeading');
const domainDetails        = document.getElementById('domainDetails');
const domainStatus         = document.getElementById('domainStatus');

// Highlight / coverage
const highlightToggleBtn    = document.getElementById('highlightToggleBtn');
const partialCoverageBanner = document.getElementById('partialCoverageBanner');

// ── Viem client ──────────────────────────────────────────────────────────────

/** Per-chain custom RPC URLs keyed by chain name. Loaded from storage. */
let customRpcUrls = {};

/**
 * Build a viem client for a given chain ID.
 * Uses the user's stored custom RPC URL for that chain if set,
 * otherwise falls back to the module's default + public RPC URLs.
 * If chainId is unrecognised or undefined, falls back to the chain
 * currently selected in the settings panel.
 *
 * @param {number|undefined} chainId
 * @returns {import('viem').PublicClient}
 */
function buildClientForChain(chainId) {
  const chainKey = (chainId != null && getChainKeyById(chainId)) || chainSelect.value;
  return createIndelibleClient(chainKey, customRpcUrls[chainKey]);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const saved = await browserAPI.storage.sync.get({ customRpcUrls: {}, showQuoteBadges: true });
  customRpcUrls = saved.customRpcUrls;
  // Show the stored custom RPC URL for the currently selected chain.
  rpcInput.value = customRpcUrls[chainSelect.value] || '';
  showBadgesToggle.checked = saved.showQuoteBadges;
}

async function saveSettings() {
  customRpcUrls[chainSelect.value] = rpcInput.value.trim();
  await browserAPI.storage.sync.set({ customRpcUrls });
}

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

// Toggle inline on-page quote badges. Persist the choice and tell the active
// tab's content script to add or remove the badges immediately.
showBadgesToggle.addEventListener('change', async () => {
  const enabled = showBadgesToggle.checked;
  await browserAPI.storage.sync.set({ showQuoteBadges: enabled });
  if (activeTabId) {
    try {
      await browserAPI.tabs.sendMessage(activeTabId, { type: 'SET_QUOTE_BADGES', enabled });
    } catch (_) {
      // Content script may not be reachable — nothing to update.
    }
  }
});

// When the chain selector changes, show the stored custom RPC for that chain.
chainSelect.addEventListener('change', () => {
  rpcInput.value = customRpcUrls[chainSelect.value] || '';
});

let rpcDebounce;
rpcInput.addEventListener('input', () => {
  clearTimeout(rpcDebounce);
  rpcDebounce = setTimeout(saveSettings, 500);
});

// ── Tab navigation ────────────────────────────────────────────────────────────

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const target = btn.dataset.tab;
    tabArticle.hidden = target !== 'article';
    tabQuotes.hidden  = target !== 'quotes';
  });
});

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Render a verification result into a given result-box element.
 *
 * @param {Element}  box         .result-box element
 * @param {Element}  heading     h3 inside the box
 * @param {Element}  details     ul inside the box
 * @param {object}   verification  from verifyCid / verifyQuoteProof
 * @param {boolean}  valid        allProofsValid (always true for verifyCid)
 */
function renderResult(box, heading, details, verification, valid = true) {
  box.className  = `result-box ${valid ? (verification.cssClass ?? '') : 'result-unverified'}`;
  heading.textContent = valid ? verification.headline : 'Invalid Proof';

  details.innerHTML = '';
  const lines = valid
    ? verification.details
    : ['The Merkle proof could not be verified against the on-chain attestation.'];

  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    details.appendChild(li);
  }
}

// ── childIpfsHash helpers ─────────────────────────────────────────────────────

/**
 * Returns true if the given bytes32 hex value is non-zero.
 *
 * @param {string|null|undefined} hex  e.g. "0x1234…"
 */
function isNonZeroBytes32(hex) {
  return typeof hex === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hex) && !/^0x0{64}$/.test(hex);
}

/**
 * Convert a bytes32 hex string (as stored on-chain) to a CIDv1 string.
 *
 * @param {string} bytes32Hex  e.g. "0xabc…" (66 chars)
 * @returns {string}  base32lower CIDv1
 */
function bytes32ToCid(bytes32Hex) {
  const hex = bytes32Hex.replace(/^0x/, '');
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    digest[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return getCIDFromRawDigest(digest);
}

// ── Article tab logic ────────────────────────────────────────────────────────
/** Chain ID extracted from the page's attestation metadata (set during init). */
let pageChainId = null;
let downloadVerifyRefData = null;
/** Hostname of the active tab (e.g. "www.nytimes.com"). */
let pageHostname = null;
/** ID of the active tab — used by the highlight toggle after init completes. */
let activeTabId = null;
/** Whether the attested-text highlight is currently active on the page. */
let highlightActive = false;

/**
 * Render a result line into the domain section.
 *
 * @param {'verified'|'not-found'|'unverified'|'error'} kind
 * @param {string} headline
 * @param {string[]} lines
 */
function renderDomainResult(kind, headline, lines) {
  const cls = {
    verified:   'result-verified',
    'not-found':'result-not-found',
    unverified: 'result-unverified',
    error:      'result-not-found',
  }[kind] ?? '';

  domainResult.className     = `result-box ${cls}`;
  domainHeading.textContent  = headline;
  domainDetails.innerHTML    = '';
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    domainDetails.appendChild(li);
  }
  domainResult.hidden = false;
}

/**
 * Candidate hostnames to look up against ENS bindings — strips a leading "www."
 * and falls back to the registrable parent (e.g. "nytimes.com" from
 * "subdomain.nytimes.com"). All candidates are lower-cased.
 *
 * @param {string} hostname
 * @returns {string[]}
 */
function domainBindingCandidates(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  const candidates = new Set([host]);

  // Also try the registrable (last two labels). Naive but good enough for
  // common TLDs like .com / .org / .net used by news domains.
  const parts = host.split('.');
  if (parts.length > 2) {
    candidates.add(parts.slice(-2).join('.'));
  }
  return [...candidates];
}

/**
 * Check whether the active tab's hostname was bound to `authority` via the
 * Indelible ENS contract at `attestationTimestamp`, then render the result.
 *
 * @param {`0x${string}`} authority
 * @param {number} attestationTimestamp  Unix seconds the attestation was published.
 * @param {number|null} chainId          Chain the attestation lives on.
 */
async function checkDomainBinding(authority, attestationTimestamp, chainId) {
  if (!pageHostname) return;

  domainSection.hidden = false;
  domainResult.hidden  = true;
  domainStatus.hidden  = false;

  try {
    const client = buildClientForChain(chainId);
    const bindings = await ens.getBindingsByAddress(client, authority);
    const candidates = domainBindingCandidates(pageHostname);

    // Match by ENS-binding name === one of the domain candidates.
    const matching = bindings.filter(b =>
      candidates.includes((b.name || '').toLowerCase())
    );

    if (matching.length === 0) {
      renderDomainResult('not-found', 'No matching domain binding',
        [
          `Page hostname: ${pageHostname}`,
          `Authority ${authority} has no ENS binding registered for this domain.`,
        ]);
      return;
    }

    const activeAtPublish = matching.filter(b => b.isActiveAt(attestationTimestamp));

    if (activeAtPublish.length === 0) {
      const b = matching[0];
      const lines = [
        `Page hostname: ${pageHostname}`,
        `Authority ${authority} has a binding for "${b.name}", but it was not active when the article was published (${prettifyTimestamp(attestationTimestamp)}).`,
        `Binding start: ${prettifyTimestamp(b.startTimestamp)}`,
      ];
      if (b.endTimestamp !== 0) {
        lines.push(`Binding end: ${prettifyTimestamp(b.endTimestamp)}`);
      }
      renderDomainResult('unverified', 'Domain binding inactive at publish time', lines);
      return;
    }

    const b = activeAtPublish[0];
    renderDomainResult('verified', 'Domain binding verified', [
      `"${b.name}" was bound to ${authority} at the time of publication (${prettifyTimestamp(attestationTimestamp)}).`,
      `Binding start: ${prettifyTimestamp(b.startTimestamp)}`,
      b.endTimestamp !== 0
        ? `Binding end: ${prettifyTimestamp(b.endTimestamp)}`
        : 'Binding still active.',
    ]);
  } catch (err) {
    console.error('[Indelible] Domain binding check failed:', err);
    renderDomainResult('error', 'Error', [err.message]);
  } finally {
    domainStatus.hidden = true;
  }
}

/**
 * Pick the attestation to use for the domain-binding check from a verification
 * result. Prefers the latest attestation by the authority claimed in the page
 * metadata; otherwise falls back to the most recent attestation.
 *
 * @param {object} verification
 * @param {`0x${string}`|null} preferredAuthority
 * @returns {{ authority: `0x${string}`, timestamp: number } | null}
 */
function pickAttestationForDomainCheck(verification, preferredAuthority) {
  const atts = verification?.attestations;
  if (!Array.isArray(atts) || atts.length === 0) return null;

  let chosen = null;
  if (preferredAuthority) {
    const lower = preferredAuthority.toLowerCase();
    chosen = [...atts].reverse().find(a => a.authority?.toLowerCase() === lower) ?? null;
  }
  if (!chosen) chosen = atts[atts.length - 1];

  if (!chosen?.authority || chosen.timestamp == null) return null;
  return { authority: chosen.authority, timestamp: Number(chosen.timestamp) };
}

/** Update the CID field whenever the article text changes. */
articleInput.addEventListener('input', async () => {
  const text = articleInput.value;
  if (text.trim()) {
    cidField.readOnly = true;
    cidField.value    = await createRawCIDv1(text);
  } else {
    cidField.readOnly = false;
    cidField.value    = '';
  }
});

cidField.addEventListener('input', () => {
  if (cidField.value.trim()) {
    articleInput.readOnly = true;
  } else {
    articleInput.readOnly = false;
  }
});

articleForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const cid       = cidField.value.trim();
  const authority = authorityInput.value.trim() || null;

  if (!cid) {
    cidField.focus();
    return;
  }

  verifyResult.hidden  = true;
  verifyStatus.hidden  = false;
  verifyButton.disabled = true;
  downloadVerifyRefBtn.hidden = true;
  childCidSection.hidden = true;

  try {
    const verification = await verifyCid(buildClientForChain(pageChainId), cid, authority);
    renderResult(verifyResult, verifyHeading, verifyDetails, verification);

    // Offer an attestation reference download for the most recent attestation.
    const refAtt = verification.attestations?.[verification.attestations.length - 1];
    if (refAtt?.index != null) {
      downloadVerifyRefData = {
        ipfsCid:           refAtt.cid,
        chainId:           pageChainId ?? (CHAINS[chainSelect.value] ?? CHAINS.sepolia).id,
        authority:         refAtt.authority,
        attestationIndex:  Number(refAtt.index),
      };
      downloadVerifyRefBtn.hidden = false;
    }

    // Show childIpfsHash (if present and non-zero) with a link to verify it.
    if (isNonZeroBytes32(refAtt?.childIpfsHash)) {
      const childCid = bytes32ToCid(refAtt.childIpfsHash);
      childCidValue.textContent = childCid;
      childCidVerifyLink.dataset.cid = childCid;
      childCidSection.hidden = false;
    }

    verifyResult.hidden = false;

    // Check whether the page's domain was bound to the attesting authority
    // at the time the article was published.
    const picked = pickAttestationForDomainCheck(verification, authority);
    if (picked && pageHostname) {
      checkDomainBinding(picked.authority, picked.timestamp, pageChainId);
    }
  } catch (err) {
    verifyResult.className    = 'result-box result-not-found';
    verifyHeading.textContent = 'Error';
    verifyDetails.innerHTML   = `<li>${err.message}</li>`;
    verifyResult.hidden       = false;
    console.error(err);
  } finally {
    verifyStatus.hidden   = true;
    verifyButton.disabled = false;
  }
});

downloadVerifyRefBtn.addEventListener('click', () => {
  if (downloadVerifyRefData) downloadJson(downloadVerifyRefData, 'attestation-reference.json');
});

childCidVerifyLink.addEventListener('click', (event) => {
  event.preventDefault();
  const cid = childCidVerifyLink.dataset.cid;
  if (!cid) return;
  // Switch to the article tab and pre-fill the CID field.
  tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'article'));
  tabArticle.hidden = false;
  tabQuotes.hidden  = true;
  articleInput.value   = '';
  articleInput.readOnly = false;
  cidField.value       = cid;
  cidField.readOnly    = false;
  cidField.focus();
});

// ── Quotes tab logic ─────────────────────────────────────────────────────────

/**
 * Build a card element for a single detected quote.
 *
 * @param {{ text: string, proofData: object }} quote
 * @param {number} index  1-based index for labelling
 * @returns {HTMLElement}
 */
function buildQuoteCard(quote, index) {
  const card = document.createElement('div');
  card.className = 'quote-card';
  // 0-based index matching the document order used by extractPageData(),
  // so inline page badges can request focus on a specific quote card.
  card.dataset.quoteIndex = String(index - 1);

  // Header row: preview text + verify button
  const header = document.createElement('div');
  header.className = 'quote-card-header';

  const preview = document.createElement('p');
  preview.className   = 'quote-preview';
  preview.textContent = `"${quote.text}"`;

  const verifyBtn = document.createElement('button');
  verifyBtn.className   = 'btn-verify-quote';
  verifyBtn.textContent = 'Verify';

  header.appendChild(preview);
  header.appendChild(verifyBtn);
  card.appendChild(header);

  // Source metadata
  if (quote.proofData.ipfsCid) {
    const meta = document.createElement('p');
    meta.className   = 'quote-meta';
    meta.textContent = `CID: ${quote.proofData.ipfsCid}`;
    card.appendChild(meta);
  }
  if (quote.proofData.authority) {
    const meta = document.createElement('p');
    meta.className   = 'quote-meta';
    meta.textContent = `Authority: ${quote.proofData.authority}`;
    card.appendChild(meta);
  }

  // Result area (initially hidden)
  const resultBox    = document.createElement('div');
  resultBox.className = 'result-box';
  resultBox.hidden    = true;

  const resultHeading  = document.createElement('h3');
  resultHeading.className = 'result-heading';
  const resultDetails  = document.createElement('ul');
  resultDetails.className = 'result-details';
  const quoteText      = document.createElement('p');
  quoteText.style.cssText = 'font-size:12px;font-style:italic;color:var(--color-text)';

  const downloadBtn    = document.createElement('button');
  downloadBtn.className   = 'btn-secondary';
  downloadBtn.textContent = 'Download Attestation Reference';
  downloadBtn.hidden      = true;

  const ensNamesEl = document.createElement('p');
  ensNamesEl.className = 'quote-ens-names';
  ensNamesEl.hidden    = true;

  const quoteChildCidSection = document.createElement('div');
  quoteChildCidSection.className = 'child-cid-section';
  quoteChildCidSection.hidden    = true;
  const quoteChildCidLabel = document.createElement('span');
  quoteChildCidLabel.className   = 'child-cid-label';
  quoteChildCidLabel.textContent = 'Child content CID:';
  const quoteChildCidValue = document.createElement('code');
  quoteChildCidValue.className = 'child-cid-value';
  const quoteChildCidLink  = document.createElement('a');
  quoteChildCidLink.className = 'child-cid-verify-link';
  quoteChildCidLink.href      = '#';
  quoteChildCidLink.textContent = 'Verify child CID';
  quoteChildCidSection.append(quoteChildCidLabel, quoteChildCidValue, quoteChildCidLink);

  quoteChildCidLink.addEventListener('click', (event) => {
    event.preventDefault();
    const cid = quoteChildCidLink.dataset.cid;
    if (!cid) return;
    tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'article'));
    tabArticle.hidden = false;
    tabQuotes.hidden  = true;
    articleInput.value    = '';
    articleInput.readOnly = false;
    cidField.value        = cid;
    cidField.readOnly     = false;
    cidField.focus();
  });

  resultBox.append(resultHeading, quoteText, resultDetails, ensNamesEl, quoteChildCidSection, downloadBtn);
  card.appendChild(resultBox);

  // Mismatch comparison box (initially hidden)
  const mismatchBox = document.createElement('div');
  mismatchBox.className = 'quote-mismatch';
  mismatchBox.hidden    = true;

  const mismatchHeading = document.createElement('p');
  mismatchHeading.className   = 'quote-mismatch-heading';
  mismatchHeading.textContent = '⚠ Page text does not match the proof';

  const mismatchPageRow  = document.createElement('div');
  mismatchPageRow.className = 'quote-mismatch-row';
  const mismatchPageLabel = document.createElement('span');
  mismatchPageLabel.className   = 'quote-mismatch-label';
  mismatchPageLabel.textContent = 'On page';
  const mismatchPageText  = document.createElement('span');
  mismatchPageText.className = 'quote-mismatch-text quote-mismatch-page';
  mismatchPageRow.append(mismatchPageLabel, mismatchPageText);

  const mismatchProofRow  = document.createElement('div');
  mismatchProofRow.className = 'quote-mismatch-row';
  const mismatchProofLabel = document.createElement('span');
  mismatchProofLabel.className   = 'quote-mismatch-label';
  mismatchProofLabel.textContent = 'In proof';
  const mismatchProofText  = document.createElement('span');
  mismatchProofText.className = 'quote-mismatch-text quote-mismatch-proof';
  mismatchProofRow.append(mismatchProofLabel, mismatchProofText);

  mismatchBox.append(mismatchHeading, mismatchPageRow, mismatchProofRow);
  card.appendChild(mismatchBox);

  // Status label
  const statusLabel = document.createElement('span');
  statusLabel.className = 'status-msg';
  statusLabel.hidden    = true;
  statusLabel.textContent = 'Verifying…';
  card.appendChild(statusLabel);

  let refData = null;

  downloadBtn.addEventListener('click', () => {
    if (refData) downloadJson(refData, `quote-attestation-reference-${index}.json`);
  });

  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled   = true;
    statusLabel.hidden   = false;
    resultBox.hidden     = true;
    downloadBtn.hidden   = true;

    try {
      const quoteClient = buildClientForChain(quote.proofData.chainId);
      const { verification, quoteText: extractedText, allProofsValid } =
        await verifyQuoteProof(quoteClient, quote.proofData);

      renderResult(resultBox, resultHeading, resultDetails, verification, allProofsValid);
      quoteText.textContent = extractedText ? `"${extractedText}"` : '';

      // Compare page text against the extracted proof text.
      if (allProofsValid && extractedText && !extractedText.includes(quote.text)) {
        mismatchPageText.textContent  = `"${quote.text}"`;
        mismatchProofText.textContent = `"${extractedText}"`;
        mismatchBox.hidden = false;
      } else {
        mismatchBox.hidden = true;
      }

      // Offer reference download for the source attestation.
      const refAtt = verification.attestations?.[verification.attestations.length - 1];
      if (allProofsValid && refAtt?.index != null) {
        refData = {
          ipfsCid:          refAtt.cid,
          chainId:          quote.proofData.chainId ?? (CHAINS[chainSelect.value] ?? CHAINS.sepolia).id,
          authority:        refAtt.authority,
          attestationIndex: Number(refAtt.index),
        };
        downloadBtn.hidden = false;
      }

      // Show ENS names bound to the attesting authority.
      ensNamesEl.hidden = true;
      if (allProofsValid) {
        const authority = refAtt?.authority ?? quote.proofData.authority;
        if (authority) {
          try {
            const bindings = await ens.getBindingsByAddress(quoteClient, authority);
            const names = [...new Set(bindings.map(b => b.name).filter(Boolean))].slice(0, 3);
            if (names.length > 0) {
              ensNamesEl.textContent = `ENS: ${names.join(', ')}`;
              ensNamesEl.hidden = false;
            }
          } catch (_) {}
        }
      }

      // Show childIpfsHash (if present and non-zero) with a link to verify it.
      quoteChildCidSection.hidden = true;
      if (isNonZeroBytes32(refAtt?.childIpfsHash)) {
        const childCid = bytes32ToCid(refAtt.childIpfsHash);
        quoteChildCidValue.textContent = childCid;
        quoteChildCidLink.dataset.cid  = childCid;
        quoteChildCidSection.hidden    = false;
      }

      resultBox.hidden = false;
    } catch (err) {
      resultBox.className    = 'result-box result-not-found';
      resultHeading.textContent = 'Error';
      resultDetails.innerHTML   = `<li>${err.message}</li>`;
      resultBox.hidden          = false;
      console.error(err);
    } finally {
      statusLabel.hidden   = true;
      verifyBtn.disabled   = false;
    }
  });

  return card;
}

/**
 * Populate the Quotes tab with cards for every detected quote.
 *
 * @param {Array} quotes
 */
function renderQuotes(quotes) {
  quotesContainer.innerHTML = '';

  if (!quotes || quotes.length === 0) {
    noQuotesMsg.hidden = false;
    return;
  }

  noQuotesMsg.hidden = true;
  quotes.forEach((quote, i) => {
    quotesContainer.appendChild(buildQuoteCard(quote, i + 1));
  });
}

/**
 * Switch to the Quotes tab, scroll the matching quote card into view, and
 * trigger its verification. Used when the popup is opened via an inline
 * page badge click.
 *
 * @param {number} quoteIndex  0-based index of the quote to focus.
 */
function focusQuoteCard(quoteIndex) {
  // Activate the Quotes tab.
  tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'quotes'));
  tabArticle.hidden = true;
  tabQuotes.hidden  = false;

  const card = quotesContainer.querySelector(`.quote-card[data-quote-index="${quoteIndex}"]`);
  if (!card) return;

  card.scrollIntoView({ block: 'center' });
  card.classList.add('quote-card--focused');

  // Kick off verification for this quote so its details are shown.
  const verifyBtn = card.querySelector('.btn-verify-quote');
  if (verifyBtn && !verifyBtn.disabled) verifyBtn.click();
}

// ── Highlight toggle ─────────────────────────────────────────────────────────

highlightToggleBtn.addEventListener('click', async () => {
  if (!activeTabId) return;
  if (!highlightActive) {
    try {
      const resp = await browserAPI.tabs.sendMessage(activeTabId, { type: 'HIGHLIGHT_INDELIBLE' });
      highlightActive = true;
      const n = resp?.count ?? 0;
      highlightToggleBtn.textContent = `Remove highlight (${n} element${n === 1 ? '' : 's'})`;
      highlightToggleBtn.classList.add('btn-highlight--active');
    } catch (_) {}
  } else {
    try {
      await browserAPI.tabs.sendMessage(activeTabId, { type: 'UNHIGHLIGHT_INDELIBLE' });
    } catch (_) {}
    highlightActive = false;
    highlightToggleBtn.textContent = 'Highlight attested text';
    highlightToggleBtn.classList.remove('btn-highlight--active');
  }
});

// ── Initialisation ────────────────────────────────────────────────────────────

(async function init() {
  // Load persisted settings and build the viem client.
  await loadSettings();

  // Query the active tab's content script for Indelible data.
  let pageData = null;
  let activeTab = null;
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    activeTab = tab ?? null;
    activeTabId = activeTab?.id ?? null;
    if (activeTab?.url) {
      try { pageHostname = new URL(activeTab.url).hostname || null; } catch (_) {}
    }
    if (activeTab?.id) {
      pageData = await browserAPI.tabs.sendMessage(activeTab.id, { type: 'GET_INDELIBLE_DATA' });
    }
  } catch (_) {
    // Content script not available on this page (e.g. chrome:// URLs).
  }

  if (pageData) {
    // ── Indelible content detected ────────────────────────────────────────

    // Store the chain ID from the attestation — used for all verification on this page.
    pageChainId = pageData.attestation?.chainId ?? null;
    const chainLabel = pageChainId
      ? ` · ${CHAIN_DISPLAY_NAMES[pageChainId] ?? `Chain ${pageChainId}`}`
      : '';
    pageStatus.textContent = `✓ Indelible content detected${chainLabel}`;
    pageStatus.className   = 'page-status detected';
    pageStatus.hidden      = false;

    // Populate article text and compute CID.
    if (pageData.text) {
      articleInput.value    = pageData.text;
      articleInput.readOnly = true;
      cidField.readOnly     = true;
      cidField.value        = await createRawCIDv1(pageData.text);
    }

    // Pre-fill authority from attestation metadata if present.
    if (pageData.attestation?.authority) {
      authorityInput.value = pageData.attestation.authority;
    }

    // Populate the Quotes tab.
    renderQuotes(pageData.quotes);

    // Show the highlight toggle button.
    highlightToggleBtn.hidden = false;

    // Show a partial-coverage banner when the attested text covers less than
    // 60% of the page, so the user knows to use Highlight to see what's missing.
    if (pageData.fullPageLength > 0 && pageData.text) {
      if (pageData.text.length / pageData.fullPageLength < 0.6) {
        partialCoverageBanner.hidden = false;
      }
    }

    // ── Load cached auto-verification result from background ──────────────
    if (activeTab?.id) {
      try {
        const cached = await browserAPI.runtime.sendMessage({
          type: 'GET_VERIFICATION_RESULT',
          tabId: activeTab.id,
        });

        // If the popup was opened by clicking an inline quote badge, jump to
        // the Quotes tab and auto-verify that specific quote card.
        if (cached?.focusedQuoteIndex != null) {
          focusQuoteCard(cached.focusedQuoteIndex);
        }

        if (cached?.verification) {
          renderResult(verifyResult, verifyHeading, verifyDetails, cached.verification);

          // Restore the download button if the cached result has a ref attestation.
          const refAtt = cached.verification.attestations?.[cached.verification.attestations.length - 1];
          if (refAtt?.index != null) {
            downloadVerifyRefData = {
              ipfsCid:          refAtt.cid,
              chainId:          pageChainId ?? (CHAINS[chainSelect.value] ?? CHAINS.sepolia).id,
              authority:        refAtt.authority,
              attestationIndex: Number(refAtt.index),
            };
            downloadVerifyRefBtn.hidden = false;
          }

          verifyResult.hidden = false;

          // Run the domain-binding check using the cached verification.
          const picked = pickAttestationForDomainCheck(
            cached.verification,
            pageData?.attestation?.authority ?? null,
          );
          if (picked && pageHostname) {
            checkDomainBinding(picked.authority, picked.timestamp, pageChainId);
          }
        } else if (cached?.verifying) {
          // Auto-verification is still in progress — show the spinner.
          verifyStatus.hidden = false;
        }
      } catch (_) {
        // Background not reachable (e.g. service worker restarted).
      }
    }
  } else {
    // ── No Indelible content ──────────────────────────────────────────────
    pageStatus.textContent = 'No Indelible content detected on this page. Enter details manually.';
    pageStatus.className   = 'page-status not-detected';
    pageStatus.hidden      = false;

    noQuotesMsg.hidden = false;
  }
})();
