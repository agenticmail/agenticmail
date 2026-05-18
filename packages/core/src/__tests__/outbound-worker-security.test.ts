import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, '../gateway/workers');

describe('outbound worker security defaults', () => {
  it('does not ship with a public outbound secret fallback', () => {
    const source = readFileSync(resolve(workerDir, 'outbound.js'), 'utf8');
    const metadata = JSON.parse(readFileSync(resolve(workerDir, 'metadata.json'), 'utf8'));

    expect(source).not.toContain('outbound_2sabi_secret_key');
    expect(metadata.bindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'OUTBOUND_SECRET', type: 'plain_text' }),
    ]));
  });

  it('rejects control characters before SMTP envelope commands are built', () => {
    const source = readFileSync(resolve(workerDir, 'outbound.js'), 'utf8');

    expect(source).toContain('assertEnvelopeAddress(from, "from")');
    expect(source).toContain('assertEnvelopeAddress(to, "recipient")');
    expect(source).toContain('CONTROL_CHARS');
  });
});
