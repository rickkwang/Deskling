#!/usr/bin/env node
// Imports a sprite sheet made with the Deskling sheet prompt (8x5 poses on a
// flat chroma-key background) as a user character.
//
// Usage: node tools/import-sheet.mjs <image> --name "My Pet" [--id my-pet]
//          [--description "..."] [--height 86] [--out <dir>] [--force]
// Default output: ~/Library/Application Support/Deskling/characters/<id>/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodePng, encodePng, isPng } from '../src/character/png-codec.js';
import { importSheet, idFromName } from '../src/character/sheet-import.js';
import { validateCharacter } from '../src/character/validate.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const VALUED = ['--name', '--id', '--description', '--height', '--out'];
const input = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const name = opt('name');
if (!input || !name) {
  console.error('usage: import-sheet.mjs <image> --name "My Pet" [--id my-pet] [--description "..."] [--height 86] [--out dir] [--force]');
  process.exit(1);
}
const id = opt('id') || idFromName(name);
const out = opt('out') || path.join(os.homedir(), 'Library', 'Application Support', 'Deskling', 'characters', id);
if (fs.existsSync(out) && !args.includes('--force')) {
  console.error(`${out} already exists (pass --force to replace it)`);
  process.exit(1);
}

let bytes = fs.readFileSync(input);
if (!isPng(bytes)) {
  // JPEG, WebP, HEIC…: let macOS convert it.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskling-')), 'sheet.png');
  execFileSync('sips', ['-s', 'format', 'png', input, '--out', tmp], { stdio: 'ignore' });
  bytes = fs.readFileSync(tmp);
}

const { character, sheet, warnings } = importSheet(decodePng(bytes), {
  name, id, description: opt('description'), height: Number(opt('height')) || undefined,
});
const { errors, warnings: more } = validateCharacter(character, { sheetSize: sheet });
if (errors.length) {
  errors.forEach((e) => console.error(`error: ${e}`));
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'spritesheet.png'), encodePng(sheet));
fs.writeFileSync(path.join(out, 'character.json'), `${JSON.stringify(character, null, 1)}\n`);
[...warnings, ...more].forEach((w) => console.warn(`warn: ${w}`));
const { cellWidth, cellHeight } = character.spritesheet;
console.log(`ok   ${id}: ${cellWidth}x${cellHeight} cells -> ${out}`);
