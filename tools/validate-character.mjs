#!/usr/bin/env node
// Validates character packages: node tools/validate-character.mjs [characters/<id> ...]
import fs from 'node:fs';
import path from 'node:path';
import { validateCharacter } from '../src/character/validate.js';
import { readPngSize } from '../src/character/png.js';

const dirs = process.argv.slice(2);
const targets = dirs.length ? dirs : fs.readdirSync('characters').map((d) => path.join('characters', d));
let failed = 0;
for (const dir of targets) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8'));
  const sheet = path.join(dir, c.spritesheet?.path || '');
  const sheetSize = fs.existsSync(sheet) ? readPngSize(fs.readFileSync(sheet)) : null;
  const { errors, warnings } = validateCharacter(c, { sheetSize });
  if (!sheetSize) errors.push(`missing spritesheet ${sheet}`);
  const mapped = Object.entries(c.states || {}).filter(([, v]) => v.source === 'app-mapped').map(([k]) => k);
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${c.id}  ${Object.keys(c.animations || {}).length} animations, app-mapped: [${mapped.join(', ')}]`);
  errors.forEach((e) => console.log(`   error: ${e}`));
  warnings.forEach((w) => console.log(`   warn:  ${w}`));
  if (errors.length) failed++;
}
process.exit(failed ? 1 : 0);
