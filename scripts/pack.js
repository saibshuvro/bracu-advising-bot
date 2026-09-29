/* Builds dist/bracu-advising-bot-v<version>.zip for a GitHub release: the contents of extension/ with manifest.json at
 * the zip root (so Chrome accepts the zip dropped on chrome://extensions), plus LICENSE.
 *   npm run pack
 * Refuses to build if package.json or the README's download link don't match the manifest's version. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const fail = (msg) => {
  console.error(`pack: ${msg}`);
  process.exit(1);
};

const { version } = JSON.parse(read('extension/manifest.json'));
const pkg = JSON.parse(read('package.json'));
if (pkg.version !== version) fail(`package.json says ${pkg.version} but extension/manifest.json says ${version}`);

const name = `bracu-advising-bot-v${version}.zip`;
if (!read('README.md').includes(`/releases/download/v${version}/${name}`)) {
  fail(`README.md's download link doesn't point at v${version}/${name}`);
}

const out = path.join(ROOT, 'dist', name);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
// -X leaves out file owner and extra timestamps; '.*' skips dotfiles such as .DS_Store.
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '.*', '*/.*'], { cwd: path.join(ROOT, 'extension'), stdio: 'inherit' });
execFileSync('zip', ['-j', '-X', '-q', out, path.join(ROOT, 'LICENSE')], { stdio: 'inherit' });
console.log(`dist/${name}`);
