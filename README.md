# Indelible Verifier — Browser Extension

A Manifest V3 browser extension (Chrome and Firefox) that detects and verifies [Indelible](https://docs.indelible.world)-attested articles and quotes on any webpage. It reads the Indelible HTMLData Standard attributes directly from the live DOM and verifies content on-chain using the [`indelible`](https://www.npmjs.com/package/indelible) npm package.

---

## Features

- **Auto-detection** — scans every page for `data-indelible` markup and badges the toolbar icon when found
- **Auto-verification** — the background worker verifies detected attestations on-chain and reflects the outcome in the badge (verified, not found, revoked, warning, error)
- **Article verification** — extracts the full attested article text, computes its IPFS CID, and verifies it against the blockchain
- **Quote verification** — finds every embedded `data-indelible-quote` proof on the page and lets you verify each one individually
- **Manual mode** — works on any page; paste in text or a CID manually if the page has no Indelible markup
- **Chain & RPC settings** — supports Ethereum, Arbitrum, Base, and Sepolia; accepts a custom RPC URL per chain
- **Download attestation reference** — exports a `attestation-reference.json` file after a successful verification

---

## Project Structure

```
indelible-browser-extension/
├── manifest.json            Chrome MV3 manifest (source of truth)
├── manifest.firefox.json    Firefox MV3 manifest (generated from manifest.json)
├── popup.html               Popup UI entry point
├── package.json
├── webpack.config.js        Separate bundles for popup, background, content
├── icons/                   Extension icons (icon.svg + rendered PNGs)
├── scripts/
│   ├── build-manifests.js   Derives manifest.firefox.json from manifest.json
│   ├── stage.js             Assembles build/<target>/ as a loadable extension
│   └── zip.js               Zips build/<target>/ contents into build/<target>.zip
├── src/
│   ├── content.js           Content script — extracts Indelible data from the live DOM
│   ├── background.js        Service worker — badge state + auto-verification per tab
│   ├── main.css             Shared styles / font imports
│   └── popup/
│       ├── popup.js         Popup logic — verification using the indelible package
│       └── popup.css        Popup styles
├── dist/                    Webpack output (generated; not committed)
│   ├── popup.js
│   ├── popup.css
│   ├── background.js
│   ├── content.js
│   └── fonts/
└── build/                   Staged unpacked extensions (generated; not committed)
    ├── chrome/
    ├── firefox/
    └── firefox.zip
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm v9 or later
- Google Chrome (or any Chromium-based browser that supports Manifest V3), or Firefox 121+

---

## Building from Source

```bash
# 1. Clone the repository
git clone https://github.com/indelible-world/indelible-browser-extension.git
cd indelible-browser-extension

# 2. Install dependencies
npm install

# 3. Build the extension bundles
npm run build          # production build (minified) + regenerates manifest.firefox.json
# or
npm run dev            # development build with file watching

# 4. Stage a loadable extension folder
npm run stage:chrome   # → build/chrome/
npm run stage:firefox  # → build/firefox/

# 5. (optional) Package the Firefox build for submission
npm run zip:firefox    # → build/firefox.zip
```

The webpack bundles are written to `dist/`; the staged, loadable extensions are written to `build/<target>/`.

`npm run zip:firefox` zips the contents of `build/firefox/` directly (no wrapping folder) into `build/firefox.zip`, e.g. for submission to addons.mozilla.org. Run `npm run stage:firefox` first.

### You must load `build/{browser}/` as the unpacked extension to use it, not `dist/`, `src/`, or `/`

---

## Loading the Extension

### Chrome

1. Open **chrome://extensions** in your browser.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `build/chrome/` folder.
5. The **Indelible Verifier** icon will appear in your Chrome toolbar.

After making code changes, run `npm run build && npm run stage:chrome` again, then click the **↺ refresh** icon on the extension card in `chrome://extensions`.

### Firefox

1. Open **about:debugging#/runtime/this-firefox**.
2. Click **Load Temporary Add-on…**.
3. Select `build/firefox/manifest.json`.

Firefox requires `background.scripts` instead of Chrome's `background.service_worker`, so `manifest.firefox.json` is generated from `manifest.json` by `npm run manifests` (also run automatically as part of `npm run build`). Edit only `manifest.json`.

---

## Using the Extension

### Verify Article

1. Navigate to any webpage that uses the Indelible HTMLData Standard. The toolbar icon badges when Indelible markup is detected, then updates once auto-verification finishes:

   | Badge | Meaning |
   |---|---|
   | **I** (blue) | Markup detected; verification in progress |
   | **✓** (green) | On-chain attestation valid |
   | **?** (grey) | No on-chain record found |
   | **!** (amber) | Warning — e.g. multiple results |
   | **✗** (red) | Attestation revoked |
   | **!** (red) | Verification error |

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
| **Chain** | Fallback blockchain network to query (Sepolia, Ethereum, Arbitrum, Base) when the page's attestation metadata does not specify a `chainId` |
| **Custom RPC URL** | Overrides the default RPC endpoint for the selected chain with your own provider URL |

Settings are persisted across browser sessions via `chrome.storage.sync`. A `chainId` detected in the page's attestation metadata always takes precedence over the selected chain.

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
| `content.js` | Injected into every page | Reads `data-indelible*` attributes from the DOM via `extractPageData()`; responds to popup queries via `chrome.runtime.onMessage` |
| `background.js` | Service worker | Receives detection events from `content.js`; auto-verifies on-chain; sets/clears the per-tab toolbar badge |
| `popup.js` | Popup window | Queries the active tab's content script; calls `verifyCid` / `verifyQuoteProof` from `indelible`; renders results |
