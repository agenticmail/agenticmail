import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';

describe('resolveConfig', () => {
  const originalEnv = process.env;

  // Use a non-existent data dir so the file-based config.json on the
  // developer machine never interferes with env-var tests.
  const isolatedDataDir = join(tmpdir(), `agenticmail-test-${Date.now()}`);

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Isolate every test from any real ~/.agenticmail/config.json
    process.env.AGENTICMAIL_DATA_DIR = isolatedDataDir;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when no env vars or overrides', () => {
    delete process.env.STALWART_URL;
    delete process.env.STALWART_ADMIN_USER;
    delete process.env.STALWART_ADMIN_PASSWORD;
    delete process.env.AGENTICMAIL_MASTER_KEY;
    delete process.env.AGENTICMAIL_API_PORT;

    const config = resolveConfig();
    expect(config.stalwart.url).toBe('http://localhost:8080');
    expect(config.smtp.port).toBe(587);
    expect(config.imap.port).toBe(143);
    expect(config.api.port).toBe(3100);
  });

  it('reads from env vars', () => {
    process.env.STALWART_URL = 'http://myserver:9090';
    process.env.SMTP_PORT = '2525';
    process.env.AGENTICMAIL_MASTER_KEY = 'mk_test';

    const config = resolveConfig();
    expect(config.stalwart.url).toBe('http://myserver:9090');
    expect(config.smtp.port).toBe(2525);
    expect(config.masterKey).toBe('mk_test');
  });

  it('applies explicit overrides last', () => {
    process.env.AGENTICMAIL_API_PORT = '4000';

    const config = resolveConfig({ api: { port: 5000, host: '0.0.0.0' } });
    expect(config.api.port).toBe(5000);
    expect(config.api.host).toBe('0.0.0.0');
  });
});
