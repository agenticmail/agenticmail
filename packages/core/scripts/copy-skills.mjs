import { mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'src', 'skills', 'built-in');
const dest = join(process.cwd(), 'dist', 'skills', 'built-in');
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
