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

import { createPublicClient, http } from 'viem';
import { mainnet, arbitrum, base, sepolia } from 'viem/chains';
import { createRawCIDv1, downloadJson, verifyCid, verifyQuoteProof } from 'indelible-protocol';

// ── Chain / RPC configuration (mirrors verify.js) ───────────────────────────

const ALCHEMY_KEY = '3Fxk_v1qhXH-B5SjNWXYo'; // Restricted to Indelible contracts

const chains = {
  ethereum: mainnet,
  arbitrum,
  base,
  sepolia,
};

const defaultRpcUrls = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  base:     `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  sepolia:  `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};

/** Result code → CSS class (mirrors codeClassMap in verify.js) */
const codeClassMap = {
  0: 'result-not-found',
  1: 'result-verified',
  2: 'result-unverified',
  3: 'result-revoked',
  4: 'result-warning',
};

/** Priority order when multiple result codes are present */
const codePriority = [2, 3, 0, 4, 1];

// ── DOM references ───────────────────────────────────────────────────────────

const settingsToggle       = document.getElementById('settingsToggle');
const settingsPanel        = document.getElementById('settingsPanel');
const chainSelect          = document.getElementById('chainSelect');
const rpcInput             = document.getElementById('rpcInput');

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

// Quotes tab
const noQuotesMsg          = document.getElementById('noQuotesMsg');
const quotesContainer      = document.getElementById('quotesContainer');

// ── Viem client ──────────────────────────────────────────────────────────────

let client;

function buildClient() {
  const chainKey = chainSelect.value;
  const chain    = chains[chainKey] ?? sepolia;
  const rpcUrl   = rpcInput.value.trim() || defaultRpcUrls[chainKey] || defaultRpcUrls.sepolia;

  client = createPublicClient({ chain, transport: http(rpcUrl) });
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const saved = await chrome.storage.sync.get({ chain: 'sepolia', rpcUrl: '' });
  chainSelect.value = saved.chain;
  rpcInput.value    = saved.rpcUrl;
  buildClient();
}

async function saveSettings() {
  await chrome.storage.sync.set({
    chain:  chainSelect.value,
    rpcUrl: rpcInput.value.trim(),
  });
}

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

chainSelect.addEventListener('change', () => { buildClient(); saveSettings(); });

let rpcDebounce;
rpcInput.addEventListener('input', () => {
  clearTimeout(rpcDebounce);
  rpcDebounce = setTimeout(() => { buildClient(); saveSettings(); }, 500);
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
 * Pick the primary result code from an array using codePriority order.
 *
 * @param {number[]} codes
 * @returns {number}
 */
function primaryCode(codes) {
  return codePriority.find(c => codes.includes(c)) ?? codes[codes.length - 1];
}

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
  const code = primaryCode(verification.resultCode);
  box.className  = `result-box ${valid ? (codeClassMap[code] ?? '') : 'result-unverified'}`;
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

// ── Chain auto-switch ─────────────────────────────────────────────────────────

/**
 * If the attestation or proof data embeds a chainId, switch the chain
 * selector to match so the correct network is queried automatically.
 *
 * @param {number|undefined} chainId
 */
function autoSwitchChain(chainId) {
  if (!chainId) return;
  const entry = Object.entries(chains).find(([, c]) => c.id === chainId);
  if (entry) {
    chainSelect.value = entry[0];
    buildClient();
  }
}

// ── Article tab logic ────────────────────────────────────────────────────────

let downloadVerifyRefData = null;

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

  try {
    const verification = await verifyCid(client, cid, authority);
    renderResult(verifyResult, verifyHeading, verifyDetails, verification);

    // Offer an attestation reference download for the most recent attestation.
    const refAtt = verification.attestations?.[verification.attestations.length - 1];
    if (refAtt?.index != null) {
      downloadVerifyRefData = {
        ipfsCid:           refAtt.cid,
        chainId:           (chains[chainSelect.value] ?? sepolia).id,
        authority:         refAtt.authority,
        attestationIndex:  Number(refAtt.index),
      };
      downloadVerifyRefBtn.hidden = false;
    }

    verifyResult.hidden = false;
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

  resultBox.append(resultHeading, quoteText, resultDetails, downloadBtn);
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

    // Auto-switch chain if embedded in the proof data.
    autoSwitchChain(quote.proofData.chainId);

    try {
      const { verification, quoteText: extractedText, allProofsValid } =
        await verifyQuoteProof(client, quote.proofData);

      renderResult(resultBox, resultHeading, resultDetails, verification, allProofsValid);
      quoteText.textContent = extractedText ? `"${extractedText}"` : '';

      // Compare page text against the extracted proof text.
      if (allProofsValid && extractedText && extractedText !== quote.text) {
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
          chainId:          (chains[chainSelect.value] ?? sepolia).id,
          authority:        refAtt.authority,
          attestationIndex: Number(refAtt.index),
        };
        downloadBtn.hidden = false;
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

// ── Initialisation ────────────────────────────────────────────────────────────

(async function init() {
  // Load persisted settings and build the viem client.
  await loadSettings();

  // Query the active tab's content script for Indelible data.
  let pageData = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      pageData = await chrome.tabs.sendMessage(tab.id, { type: 'GET_INDELIBLE_DATA' });
    }
  } catch (_) {
    // Content script not available on this page (e.g. chrome:// URLs).
  }

  if (pageData) {
    // ── Indelible content detected ────────────────────────────────────────
    pageStatus.textContent = '✓ Indelible content detected on this page';
    pageStatus.className   = 'page-status detected';
    pageStatus.hidden      = false;

    // Auto-switch chain if the attestation metadata specifies one.
    autoSwitchChain(pageData.attestation?.chainId);

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
  } else {
    // ── No Indelible content ──────────────────────────────────────────────
    pageStatus.textContent = 'No Indelible content detected on this page. Enter details manually.';
    pageStatus.className   = 'page-status not-detected';
    pageStatus.hidden      = false;

    noQuotesMsg.hidden = false;
  }
})();
