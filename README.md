# Indelible Verifier — Chrome Extension

A Chrome extension that detects and verifies [Indelible](https://indelible-world.github.io/indelible-docs)-attested articles and quotes on any webpage. It reads the Indelible HTMLData Standard attributes directly from the live DOM and verifies content on-chain using the [`indelible-protocol`](https://www.npmjs.com/package/indelible-protocol) npm package.

---

## Features

- **Auto-detection** — scans every page for `data-indelible` markup and badges the toolbar icon when found
- **Article verification** — extracts the full attested article text, computes its IPFS CID, and verifies it against the blockchain
- **Quote verification** — finds every embedded `data-indelible-quote` proof on the page and lets you verify each one individually
- **Manual mode** — works on any page; paste in text or a CID manually if the page has no Indelible markup
- **Chain & RPC settings** — supports Ethereum, Arbitrum, Base, and Sepolia; accepts a custom RPC URL
- **Download attestation reference** — exports a `attestation-reference.json` file after a successful verification

---

## Project Structure

```
indelible-browser-extension/
├── manifest.json            Chrome MV3 extension manifest
├── popup.html               Popup UI entry point
├── package.json
├── webpack.config.js        Separate bundles for popup, background, content
├── src/
│   ├── content.js           Content script — extracts Indelible data from the live DOM
│   ├── background.js        Service worker — manages the toolbar badge per tab
│   └── popup/
│       ├── popup.js         Popup logic — verification using indelible-protocol
│       └── popup.css        Popup styles
└── dist/                    Webpack output (generated; not committed)
    ├── popup.js
    ├── background.js
    └── content.js
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm v9 or later
- Google Chrome (or any Chromium-based browser that supports Manifest V3)

---

## Building from Source

```bash
# 1. Clone the repository
git clone https://github.com/indelible-world/indelible-browser-extension.git
cd indelible-browser-extension

# 2. Install dependencies
npm install

# 3. Build the extension bundles
npm run build          # production build (minified)
# or
npm run dev            # development build with file watching
```

The built files are written to `dist/`.

---

## Loading the Extension in Chrome

1. Open **chrome://extensions** in your browser.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `indelible-browser-extension/` folder (the root, not `dist/`).
5. The **Indelible Verifier** icon will appear in your Chrome toolbar.

After making code changes, run `npm run build` again and click the **↺ refresh** icon on the extension card in `chrome://extensions`.

---

## Using the Extension

### Verify Article

1. Navigate to any webpage that uses the Indelible HTMLData Standard. The toolbar icon will display an **I** badge when Indelible markup is detected.
2. Click the toolbar icon to open the popup.
3. On the **Verify Article** tab, the article text and CID are filled in automatically from the page. The authority address is populated if it is embedded in the attestation metadata.
4. Optionally enter or override the **Authority Address** to verify against a specific signer.
5. Click **Verify** — the result will indicate whether the content is verified, unverified, revoked, or not found on-chain.
6. If verified, click **Download Attestation Reference** to save a `attestation-reference.json` file.

On a page with no Indelible markup, all fields can be filled in manually.

### Verify Quotes

1. Open the popup on a page that contains embedded `data-indelible-quote` elements.
2. Switch to the **Verify Quotes** tab — a card is shown for each detected quote, including a preview of the text and the source CID.
3. Click **Verify** on any card to verify that quote's Merkle proof against the on-chain attestation.
4. Download an attestation reference for any successfully verified quote.

### Settings

Click the **⚙** icon in the popup header to open the Settings panel:

| Setting | Description |
|---|---|
| **Chain** | Selects the blockchain network to query (Sepolia, Ethereum, Arbitrum, Base) |
| **Custom RPC URL** | Overrides the default Alchemy RPC endpoint with your own provider URL |

Settings are persisted across browser sessions via `chrome.storage.sync`.

---

## Implementing the Indelible HTMLData Standard on Your Site

To make your article automatically verifiable by this extension (and by the [Indelible verify site](https://indelible.world)), mark up your HTML as follows.

### Exclusive Mode (whole article)

Mark the article container with `data-indelible` containing the attestation metadata JSON. Everything inside the element is attested by default. Use `data-indelible-exclude` to omit elements such as ads or captions.

```html
<article data-indelible='{
  "ipfsCid":          "bafkrei…",
  "authority":        "0xD77d245c4Fd75adb4eadFC4147469257061f06c1",
  "chainId":          11155111,
  "attestationIndex": 4
}'>
  <h1>My Article Title</h1>
  <p>This text is part of the attestation.</p>
  <aside data-indelible-exclude>
    This sidebar content is excluded from the attestation.
  </aside>
  <p>This paragraph is also attested.</p>
</article>
```

### Inclusive Mode (selected sections only)

Add `data-indelible-include` to only the elements that were attested. Any element without this attribute is excluded.

```html
<article data-indelible='{ "ipfsCid": "bafkrei…", "authority": "0x…", "chainId": 11155111, "attestationIndex": 4 }'>
  <h1 data-indelible-include>My Article Title</h1>
  <p data-indelible-include>This paragraph is attested.</p>
  <p>This paragraph is NOT attested (no include attribute).</p>
</article>
```

### Embedding Verified Quotes

To embed a verified quote from another attested article, add `data-indelible-quote` with the full Merkle proof JSON to the `<blockquote>` (or any element):

```html
<blockquote data-indelible-quote='{
  "ipfsCid":          "bafkrei…",
  "authority":        "0xD77d245c4Fd75adb4eadFC4147469257061f06c1",
  "chainId":          11155111,
  "attestationIndex": 4,
  "proof": [
    {
      "value": ["40", "…chunk of quoted text…"],
      "proof": ["0xabc…", "0xdef…"]
    }
  ]
}'>
  "…the quoted passage from the source article…"
</blockquote>
```

The `proof` array is the Merkle proof generated by the Indelible protocol at attestation time. See the [quote verification docs](https://indelible-world.github.io/indelible-docs/taanq/quote-verification.html) for details on how proofs are constructed.

### Attestation Metadata Fields

| Field | Type | Description |
|---|---|---|
| `ipfsCid` | string | IPFS CID (v1) of the attested content |
| `authority` | string | Ethereum address of the attesting authority |
| `chainId` | number | Chain ID of the network holding the attestation |
| `attestationIndex` | number | On-chain index of the attestation |

---

## Architecture Notes

| Component | Runtime | Role |
|---|---|---|
| `content.js` | Injected into every page | Reads `data-indelible*` attributes from the DOM; responds to popup queries via `chrome.runtime.onMessage` |
| `background.js` | Service worker | Receives detection events from `content.js`; sets/clears the toolbar badge |
| `popup.js` | Popup window | Queries the active tab's content script; calls `verifyCid` / `verifyQuoteProof` from `indelible-protocol`; renders results |

---

## License

MIT
