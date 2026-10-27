import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const localeDir = path.join(process.cwd(), 'locale');
const base = JSON.parse(readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const baseKeys = Object.keys(base);

let failed = false;
for (const file of readdirSync(localeDir).filter((name) => name.endsWith('.json'))) {
  const data = JSON.parse(readFileSync(path.join(localeDir, file), 'utf8'));
  const keys = Object.keys(data);
  const missing = baseKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !baseKeys.includes(key));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${file}: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
  } else {
    console.log(`${file}: ok`);
  }
}

if (failed) process.exit(1);