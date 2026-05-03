const path = require('path');
const webpack = require('webpack');

const sharedPolyfills = {
  resolve: {
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
    },
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: ['process/browser'],
    }),
  ],
  experiments: {
    topLevelAwait: true,
  },
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
    },
    ...sharedPolyfills,
  },

  // Background service worker — minimal, no npm dependencies
  {
    name: 'background',
    target: 'webworker',
    entry: './src/background.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'background.js',
    },
    experiments: { topLevelAwait: true },
  },

  // Content script — runs in the page context, DOM-only, no npm dependencies
  {
    name: 'content',
    target: 'web',
    entry: './src/content.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'content.js',
    },
    experiments: { topLevelAwait: true },
  },
];
