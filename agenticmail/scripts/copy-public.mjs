import { mkdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', '..', 'packages', 'api', 'public');
const dest = join(__dirname, '..', 'dist', 'public');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
