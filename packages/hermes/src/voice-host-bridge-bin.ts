#!/usr/bin/env node
import { runVoiceHostBridgeCli } from '@agenticmail/voice-host-bridge/cli';

void runVoiceHostBridgeCli().then((code) => {
  process.exitCode = code;
});
