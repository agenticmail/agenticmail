#!/usr/bin/env node
/**
 * Wrapper bin shipped with `@agenticmail/cli` so `agenticmail-codex`
 * is on PATH after `npm install -g @agenticmail/cli`, even though
 * `@agenticmail/codex` is only a transitive optionalDependency.
 *
 * See bin-host-shim.ts for the full rationale.
 */
import './suppress-experimental-warnings.js';
import { runHostBin } from './bin-host-shim.js';

runHostBin('@agenticmail/codex', 'agenticmail-codex');
