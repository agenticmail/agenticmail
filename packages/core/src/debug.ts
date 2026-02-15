/**
 * Debug logger — only outputs when AGENTICMAIL_DEBUG is set.
 * Use for per-message operational logs that would flood production stdout.
 */
const enabled = () => !!process.env.AGENTICMAIL_DEBUG;

export function debug(tag: string, message: string): void {
  if (enabled()) console.log(`[${tag}] ${message}`);
}

export function debugWarn(tag: string, message: string): void {
  if (enabled()) console.warn(`[${tag}] ${message}`);
}
