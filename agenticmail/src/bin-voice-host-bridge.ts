#!/usr/bin/env node
/**
 * Wrapper bin shipped with `@agenticmail/cli` so the generic localhost
 * voice host bridge is on PATH after one global CLI install.
 */
import './suppress-experimental-warnings.js';
import { runHostBin } from './bin-host-shim.js';

runHostBin('@agenticmail/voice-host-bridge', 'agenticmail-voice-host-bridge');
