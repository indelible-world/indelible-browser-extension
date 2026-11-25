const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// indelible ≥0.4 lazy-loads pdfjs-dist / pdf-lib for PDF support via dynamic
// import(). The extension never uses PDF features, and code-split chunks break
// in extension contexts (content scripts can't resolve webpack's automatic
// publicPath), so stub them out and keep every bundle as a single file.
const noPdfAlias = {
  'pdfjs-dist/legacy/build/pdf.mjs': false,
  'pdf-lib': false,
};

const sharedPolyfills = {
  resolve: {
    alias: noPdfAlias,
    fallback: {
      buffer: require.resolve('buffer/'),
      process: require.resolve('process/browser'),
      stream: false,
      crypto: false,
      http: false,
      https: false,
      os: false,
      path: false,
      fs: false,
      net: false,
      tls: false,
      'node:worker_threads': false,
    },
  },
  plugins: [
    new webpack.ProvidePlugin({
      // Absolute paths so packages outside this directory (e.g. an `npm link`ed
      // indelible) can still resolve the polyfills.
      Buffer: [require.resolve('buffer/'), 'Buffer'],
      process: [require.resolve('process/browser')],
    }),
  ],
  experiments: {
    topLevelAwait: true,
  },
  // Suppress the intentional dynamic import in ox/viem's tempo chain (dead code in browser)
  ignoreWarnings: [
    {
      module: /ox\/_esm\/tempo\/internal\/virtualMasterPool\.js/,
      message: /Critical dependency/,
    },
  ],
  // Extension bundles are installed locally — web performance size limits don't apply
  performance: { hints: false },
};

module.exports = [
  // Popup bundle — runs as a normal browser page inside the popup window
  {
    name: 'popup',
    target: 'web',
    entry: './src/popup/popup.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'popup.js',
      assetModuleFilename: 'fonts/[name][ext]',
      // Keeps webpack's runtime from emitting a `new Function('return this')`
      // globalThis fallback, which add-on reviewers flag as eval.
      environment: { globalThis: true },
      asyncChunks: false,
    },
    ...sharedPolyfills,
    module: {
      rules: [
        {
          test: /\.css$/i,
          use: [MiniCssExtractPlugin.loader, 'css-loader'],
        },
        {
          test: /\.(woff2?|ttf|eot)$/i,
          type: 'asset/resource',
        },
      ],
    },
    plugins: [
      ...sharedPolyfills.plugins,
      new MiniCssExtractPlugin({ filename: 'popup.css' }),
    ],
  },

  // Background service worker — uses indelible for auto-verification
  {
    name: 'background',
    target: 'webworker',
    entry: './src/background.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'background.js',
      environment: { globalThis: true },
      asyncChunks: false,
    },
    ...sharedPolyfills,
  },

  // Content script — runs in the page context, DOM-only, no npm dependencies
  {
    name: 'content',
    target: 'web',
    entry: './src/content.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'content.js',
      environment: { globalThis: true },
      asyncChunks: false,
    },
    resolve: { alias: noPdfAlias },
    experiments: { topLevelAwait: true },
    ignoreWarnings: sharedPolyfills.ignoreWarnings,
    performance: { hints: false },
  },
];
