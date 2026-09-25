// In-app updates for the unsigned macOS build, after Noa's installer.
//
// Electron's autoUpdater (Squirrel.Mac) only installs signed apps, so we do it
// ourselves: read latest-mac.yml from the newest GitHub release, download its
// zip, check the SHA-512 it lists, then a detached script swaps the .app once
// we have quit and opens the new one. A download made by the app itself is not
// quarantined, so the new version opens without another Gatekeeper prompt.
// The digest only proves the zip is the one the release lists; whoever can
// publish releases on the repo is trusted.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'rickkwang/Deskling';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const FEED_URL = `${RELEASES_URL}/latest/download/latest-mac.yml`;
const TRUSTED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export const releasePage = (version) => (version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL);

// latest-mac.yml as electron-builder writes it: top-level `key: value` lines
// and a `files:` list of `- url/sha512/size` entries.
export function parseFeed(text) {
  const feed = { files: [] };
  let file = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\s*)(- )?(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, item, key, raw] = m;
    const value = raw.replace(/^'(.*)'$/, '$1');
    if (!indent && !item) {
      file = null;
      if (key !== 'files') feed[key] = value;
    } else {
      if (item) feed.files.push(file = {});
      if (file) file[key] = value;
    }
  }
  return feed;
}

// Plain x.y.z comparison (we don't publish pre-releases).
export function isNewer(latest, current) {
  const a = String(latest).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function sha512Digest(value) {
  const buf = Buffer.from(String(value || ''), 'base64');
  return buf.length === 64 && buf.toString('base64') === value ? buf : null;
}

// The zip to install, as an asset of this version's release.
export function zipAsset(feed) {
  const file = feed.files.find((f) => f.url?.endsWith('.zip') && sha512Digest(f.sha512));
  if (!file) throw new Error('The release lists no zip with a valid SHA-512.');
  return {
    url: `${RELEASES_URL}/download/v${encodeURIComponent(feed.version)}/${encodeURIComponent(path.posix.basename(file.url))}`,
    sha512: sha512Digest(file.sha512),
  };
}

const trusted = (url) => {
  try { return TRUSTED_HOSTS.has(new URL(url).hostname); } catch { return false; }
};

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!trusted(res.url)) throw new Error(`Refusing a download from ${new URL(res.url).hostname}.`);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  return res;
}

// The newer release, or null when we are up to date.
export async function checkForUpdate(currentVersion) {
  const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null; // nothing published yet
  if (!res.ok) throw new Error(`Update check failed (${res.status}).`);
  const feed = parseFeed(await res.text());
  return feed.version && isNewer(feed.version, currentVersion) ? feed : null;
}

async function download(url, file, expected) {
  const res = await get(url);
  const hash = createHash('sha512');
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, fs.createWriteStream(file));
  const actual = hash.digest();
  if (!timingSafeEqual(actual, expected)) throw new Error('The downloaded update failed its SHA-512 check.');
}

// <bundle>.app/Contents/MacOS/<exe>
const bundlePath = (exe) => path.resolve(exe, '../../..');

// Where the new version goes: over the running app, or /Applications when
// macOS runs us from a randomized read-only copy (App Translocation).
export function installTarget(exe, name) {
  const current = bundlePath(exe);
  return current.includes('/AppTranslocation/') ? `/Applications/${name}.app` : current;
}

const q = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

// Waits for us to quit, swaps the bundle (keeping a backup until the new one
// opens), and opens the release page if anything goes wrong.
export function installScript({ source, target, workDir, pid, page }) {
  const backup = `${target}.old`;
  return `#!/bin/bash
set -uo pipefail
exec >>${q(path.join(workDir, 'install.log'))} 2>&1
fail() { echo "[deskling-update] $1"; [ -d ${q(backup)} ] && { rm -rf ${q(target)}; mv ${q(backup)} ${q(target)}; }; open ${q(page)}; exit 1; }
for _ in $(seq 150); do kill -0 ${pid} 2>/dev/null || break; sleep 0.2; done
kill -0 ${pid} 2>/dev/null && fail "the app did not quit"
rm -rf ${q(backup)}
if [ -d ${q(target)} ]; then mv ${q(target)} ${q(backup)} || fail "could not move the old app aside"; fi
/usr/bin/ditto ${q(source)} ${q(target)} || fail "could not copy the new app"
/usr/bin/open ${q(target)} || fail "could not open the new app"
rm -rf ${q(backup)} ${q(workDir)}
echo "[deskling-update] installed"
`;
}

// Downloads and verifies `feed`'s zip, then hands over to the install script.
// Resolves once the script is waiting: the caller must quit the app.
export async function prepareInstall(feed, { exe, name }) {
  const target = installTarget(exe, name);
  const dir = path.dirname(target);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(dir === '/Applications'
      ? `This account can't change apps in Applications, so ask an administrator to install it.`
      : `I can't update myself inside ${dir}. Move ${name} to Applications first.`);
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskling-update-'));
  try {
    const asset = zipAsset(feed);
    const zip = path.join(workDir, 'update.zip');
    await download(asset.url, zip, asset.sha512);
    const out = path.join(workDir, 'app');
    const unzip = spawnSync('/usr/bin/ditto', ['-x', '-k', zip, out], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new Error(unzip.stderr.trim() || 'Could not unpack the update.');
    const source = path.join(out, `${name}.app`);
    if (!fs.existsSync(source)) throw new Error(`The update has no ${name}.app.`);
    const script = path.join(workDir, 'install.sh');
    fs.writeFileSync(script, installScript({ source, target, workDir, pid: process.pid, page: releasePage(feed.version) }), { mode: 0o755 });
    spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
}
