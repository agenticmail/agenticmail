/**
 * Symmetric secret encryption for credentials stored at rest in SQLite.
 *
 * Extracted from gateway/manager.ts so the same AES-256-GCM scheme can be
 * reused for any credential the platform persists (relay passwords,
 * Cloudflare tokens, SMS provider API passwords + webhook secrets, ...).
 *
 * Format: "enc2:salt:iv:authTag:ciphertext" — all hex-encoded. The key is
 * the deployment master key; a per-secret random salt + scrypt KDF means
 * two identical plaintexts never produce the same ciphertext and a leaked
 * SQLite file is useless without the master key.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto';

/** Derive a 32-byte AES key from the master key using scrypt + a random salt. */
function deriveKey(key: string, salt: Buffer): Buffer {
  return scryptSync(key, salt, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Encrypt a string using AES-256-GCM with a scrypt-derived key.
 * Returns "enc2:salt:iv:authTag:ciphertext" (all hex-encoded).
 */
export function encryptSecret(plaintext: string, key: string): string {
  const salt = randomBytes(16);
  const derivedKey = deriveKey(key, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc2:${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string encrypted with {@link encryptSecret}.
 * Supports the new "enc2:" (scrypt) and legacy "enc:" (SHA-256) formats.
 * Returns the original plaintext, or the input unchanged if it isn't
 * recognizably encrypted (tolerates legacy plaintext for migration).
 */
export function decryptSecret(value: string, key: string): string {
  if (value.startsWith('enc2:')) {
    // New scrypt-based format: enc2:salt:iv:authTag:ciphertext
    const parts = value.split(':');
    if (parts.length !== 5) return value;
    const [, saltHex, ivHex, authTagHex, ciphertextHex] = parts;
    const derivedKey = deriveKey(key, Buffer.from(saltHex, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  }
  if (value.startsWith('enc:')) {
    // Legacy SHA-256 format: enc:iv:authTag:ciphertext — read-only for migration
    const parts = value.split(':');
    if (parts.length !== 4) return value;
    const [, ivHex, authTagHex, ciphertextHex] = parts;
    const keyHash = createHash('sha256').update(key).digest();
    const decipher = createDecipheriv('aes-256-gcm', keyHash, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  }
  return value; // plaintext (unencrypted legacy)
}

/** True if the value looks like an {@link encryptSecret} output. */
export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('enc2:') || value.startsWith('enc:'));
}
