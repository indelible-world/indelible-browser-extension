// Zips the contents of build/<target>/ into build/<target>.zip (files at the zip root, no wrapping folder).
// Usage: node scripts/zip.js [chrome|firefox]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const target = process.argv[2] ?? 'firefox';
if (target !== 'chrome' && target !== 'firefox') {
  console.error(`unknown target "${target}" (expected chrome or firefox)`);
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build', target);
const zipPath = path.join(root, 'build', `${target}.zip`);

if (!fs.existsSync(buildDir)) {
  console.error(`build/${target}/ not found — run \`npm run stage:${target}\` first`);
  process.exit(1);
}

fs.rmSync(zipPath, { force: true });

// Run zip from inside buildDir so entries are added at the archive root, not under a wrapping folder.
const result = spawnSync('zip', ['-r', '-X', zipPath, '.', '-x', '.*'], {
  cwd: buildDir,
  stdio: 'inherit',
});

if (result.error || result.status !== 0) {
  console.error('zip failed', result.error ?? `exit code ${result.status}`);
  process.exit(1);
}

console.log(`created build/${target}.zip`);
