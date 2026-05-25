#!/usr/bin/env node
import { runMeetMediaSidecarCli } from '@agenticmail/voice-host-bridge/meet-sidecar-cli';

void runMeetMediaSidecarCli().then((code) => {
  process.exitCode = code;
});
