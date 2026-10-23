import { copyFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve('config.local.json');
try { await access(destination); process.stderr.write('Existing config.local.json preserved.\n'); }
catch { await copyFile(resolve('config.example.json'), destination); process.stderr.write('Created config.local.json; edit repository paths before use.\n'); }
