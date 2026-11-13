import { describe, it, expect } from 'vitest';
import { isInputValidationMessage } from '../routes/media.js';

describe('media error classification', () => {
  it('maps caller-input errors to 400', () => {
    expect(isInputValidationMessage('input file path is required')).toBe(true);
    expect(isInputValidationMessage('input file not found: /tmp/x.png')).toBe(true);
    expect(isInputValidationMessage('Unknown image action: spin')).toBe(true);
    expect(isInputValidationMessage('input file path is outside the allowed media directories: /etc/passwd')).toBe(true);
    expect(isInputValidationMessage('ffmpeg exited with code 1')).toBe(false);
  });

  it('stays fast on adversarial "unknown " repetition', () => {
    const evil = 'unknown '.repeat(100_000);
    const t0 = Date.now();
    isInputValidationMessage(evil);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
