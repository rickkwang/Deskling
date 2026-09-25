// node --test test/  — update feed parsing and the install script (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseFeed, isNewer, zipAsset, installTarget, installScript } from '../src/main/updater.js';

const SHA = Buffer.alloc(64, 7).toString('base64');
const FEED = `version: 0.2.0
files:
  - url: Deskling-0.2.0-arm64-mac.zip
    sha512: ${SHA}
    size: 1234
  - url: Deskling-0.2.0-arm64.dmg
    sha512: ${SHA}
    size: 5678
path: Deskling-0.2.0-arm64-mac.zip
sha512: ${SHA}
releaseDate: '2026-09-25T06:33:24.926Z'
`;

test('latest-mac.yml is read as electron-builder writes it', () => {
  const feed = parseFeed(FEED);
  assert.equal(feed.version, '0.2.0');
  assert.equal(feed.releaseDate, '2026-09-25T06:33:24.926Z');
  assert.deepEqual(feed.files.map((f) => f.url), ['Deskling-0.2.0-arm64-mac.zip', 'Deskling-0.2.0-arm64.dmg']);
  assert.equal(feed.files[0].sha512, SHA);
});

test('versions compare numerically', () => {
  assert.ok(isNewer('0.2.0', '0.1.0'));
  assert.ok(isNewer('0.10.0', '0.9.3'));
  assert.ok(isNewer('1.0', '0.9.9'));
  assert.ok(!isNewer('0.1.0', '0.1.0'));
  assert.ok(!isNewer('0.1.0', '0.2.0'));
});

test('the zip is fetched from its own release, never from a URL in the feed', () => {
  const asset = zipAsset(parseFeed(FEED));
  assert.equal(asset.url, 'https://github.com/rickkwang/Deskling/releases/download/v0.2.0/Deskling-0.2.0-arm64-mac.zip');
  assert.equal(asset.sha512.length, 64);
  const evil = parseFeed(FEED.replace('url: Deskling-0.2.0-arm64-mac.zip', 'url: https://evil.example/x/Deskling.zip'));
  assert.match(zipAsset(evil).url, /^https:\/\/github\.com\/rickkwang\/Deskling\/releases\/download\/v0\.2\.0\/Deskling\.zip$/);
});

test('a feed without a well-formed digest is refused', () => {
  assert.throws(() => zipAsset(parseFeed(FEED.replaceAll(SHA, 'bad'))), /SHA-512/);
  assert.throws(() => zipAsset({ version: '0.2.0', files: [] }), /SHA-512/);
});

test('updates go over the running app, or to Applications from App Translocation', () => {
  assert.equal(installTarget('/Applications/Deskling.app/Contents/MacOS/Deskling', 'Deskling'), '/Applications/Deskling.app');
  assert.equal(installTarget('/Users/me/Apps/Deskling.app/Contents/MacOS/Deskling', 'Deskling'), '/Users/me/Apps/Deskling.app');
  assert.equal(installTarget('/private/var/folders/x/AppTranslocation/ABC/d/Deskling.app/Contents/MacOS/Deskling', 'Deskling'), '/Applications/Deskling.app');
});

test('the install script is valid bash and quotes its paths', () => {
  const script = installScript({ source: "/tmp/it's/Deskling.app", target: '/Applications/Deskling.app', workDir: '/tmp/w', pid: 123, page: 'https://github.com/x' });
  assert.equal(spawnSync('/bin/bash', ['-n'], { input: script }).status, 0);
  assert.ok(script.includes(`'/tmp/it'"'"'s/Deskling.app'`));
});
