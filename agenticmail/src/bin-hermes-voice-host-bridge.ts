#!/usr/bin/env node
/**
 * Wrapper bin shipped with `@agenticmail/cli` so Hermes deployments get the
 * same host-owned realtime bridge from a single AgenticMail CLI install.
 */
import './suppress-experimental-warnings.js';
import { runHostBin } from './bin-host-shim.js';

runHostBin('@agenticmail/hermes', 'agenticmail-hermes-voice-host-bridge');
