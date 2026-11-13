/**
 * MediaManager unit tests.
 *
 * The media toolset drives external system binaries (ffmpeg, ffprobe,
 * ImageMagick, whisper.cpp, Python). These tests never run a real
 * binary — `node:child_process` is fully mocked. What they lock in:
 *
 *   1. Argument construction — every binary is invoked via execFile
 *      with an ARGUMENT ARRAY (no shell, no string interpolation).
 *   2. Feature-detection — a missing binary produces a clear,
 *      actionable error and never crashes.
 *   3. Security — untrusted input paths are validated: a leading-dash
 *      path (flag-injection), a control-character path, and a
 *      non-existent file are all rejected before any binary runs.
 *   4. Output containment — generated output files land inside the
 *      configured output directory.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// ─── child_process mock ────────────────────────────────────────────
//
// `execFile` calls are recorded; `execFileSync` (used by binary
// detection) reports a binary as present/absent based on `presentBins`.
const execFileCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
let presentBins = new Set<string>(['ffmpeg', 'ffprobe', 'magick']);
let ffprobeJson = '{"format":{"duration":"10.0"},"streams":[{"codec_type":"video","width":1920,"height":1080}]}';

vi.mock('node:child_process', () => {
  return {
    // promisify(execFile) requires the Node callback signature.
    execFile: (cmd: string, args: string[], opts: unknown, cb?: Function) => {
      const callback = typeof opts === 'function' ? (opts as Function) : cb;
      execFileCalls.push({ cmd, args, opts: typeof opts === 'function' ? undefined : opts });
      // ffprobe returns JSON on stdout; everything else returns empty.
      const stdout = cmd.includes('ffprobe') ? ffprobeJson : 'identify-100x40';
      if (callback) callback(null, { stdout, stderr: '' });
      return { stdout, stderr: '' } as unknown;
    },
    execFileSync: (cmd: string) => {
      if (presentBins.has(cmd)) {
        // Return a version banner the detector's regex will match.
        if (cmd === 'ffmpeg') return Buffer.from('ffmpeg version 6.1.1 Copyright (c)');
        if (cmd === 'ffprobe') return Buffer.from('ffprobe version 6.1.1 Copyright (c)');
        if (cmd === 'magick' || cmd === 'convert') return Buffer.from('Version: ImageMagick 7.1.1-21');
        if (cmd === 'whisper-cli' || cmd === 'whisper') return Buffer.from('usage: whisper-cli');
        if (cmd === 'python3' || cmd === 'python') return Buffer.from('Python 3.12.4');
        return Buffer.from('present');
      }
      const err = new Error(`command not found: ${cmd}`);
      throw err;
    },
  };
});

// ─── fs mock ───────────────────────────────────────────────────────
//
// Treat any path NOT containing "missing" as existent so input-path
// validation passes for test files. mkdir/write/stat/rm are no-ops.
vi.mock('node:fs', () => {
  return {
    existsSync: (p: string) => typeof p === 'string' && !p.includes('missing'),
    mkdirSync: () => undefined,
    statSync: () => ({ size: 2048 }),
    writeFileSync: () => undefined,
    readFileSync: () => '',
    readdirSync: () => [],
    unlinkSync: () => undefined,
    rmSync: () => undefined,
  };
});

let MediaManager: typeof import('../media/manager.js').MediaManager;
let detectBinary: typeof import('../media/binaries.js').detectBinary;
let clearMediaCapabilityCache: typeof import('../media/binaries.js').clearMediaCapabilityCache;
let getMediaCapabilities: typeof import('../media/binaries.js').getMediaCapabilities;

beforeEach(async () => {
  vi.resetModules();
  execFileCalls.length = 0;
  presentBins = new Set(['ffmpeg', 'ffprobe', 'magick']);
  ffprobeJson = '{"format":{"duration":"10.0"},"streams":[{"codec_type":"video","width":1920,"height":1080}]}';
  ({ MediaManager } = await import('../media/manager.js'));
  ({ detectBinary, clearMediaCapabilityCache, getMediaCapabilities } = await import('../media/binaries.js'));
  clearMediaCapabilityCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

function newManager() {
  return new MediaManager({ outputDir: '/tmp/agenticmail-media-test' });
}

describe('binary feature-detection', () => {
  it('detects an available binary and caches the result', () => {
    const cap = detectBinary('ffmpeg');
    expect(cap.available).toBe(true);
    expect(cap.command).toBe('ffmpeg');
    expect(cap.version).toBe('6.1.1');
  });

  it('reports a missing binary with an actionable install hint', () => {
    presentBins = new Set(['ffmpeg']); // ImageMagick absent
    clearMediaCapabilityCache();
    const cap = detectBinary('imagemagick');
    expect(cap.available).toBe(false);
    expect(cap.installHint).toMatch(/install/i);
    expect(cap.installHint).toMatch(/imagemagick/i);
  });

  it('getMediaCapabilities reports ready only when ffmpeg + ffprobe are present', () => {
    clearMediaCapabilityCache();
    expect(getMediaCapabilities().ready).toBe(true);
    presentBins = new Set(['ffmpeg']); // ffprobe absent
    clearMediaCapabilityCache();
    expect(getMediaCapabilities({ force: true }).ready).toBe(false);
  });

  it('ImageMagick 6 fallback — uses `convert` when `magick` is absent', () => {
    presentBins = new Set(['ffmpeg', 'ffprobe', 'convert']);
    clearMediaCapabilityCache();
    const cap = detectBinary('imagemagick');
    expect(cap.available).toBe(true);
    expect(cap.command).toBe('convert');
  });
});

describe('graceful degradation — absent binary', () => {
  it('image_edit throws an install hint when ImageMagick is missing', async () => {
    presentBins = new Set(['ffmpeg', 'ffprobe']);
    clearMediaCapabilityCache();
    await expect(newManager().imageEdit({ input: '/tmp/in.png', action: 'grayscale' }))
      .rejects.toThrow(/imagemagick is required/i);
  });

  it('video_edit throws an install hint when ffmpeg is missing', async () => {
    presentBins = new Set(['ffprobe']);
    clearMediaCapabilityCache();
    await expect(newManager().videoEdit({ input: '/tmp/in.mp4', action: 'remove_audio' }))
      .rejects.toThrow(/ffmpeg is required/i);
  });

  it('media_info throws an install hint when ffprobe is missing', async () => {
    presentBins = new Set(['ffmpeg']);
    clearMediaCapabilityCache();
    await expect(newManager().mediaInfo('/tmp/in.mp4'))
      .rejects.toThrow(/ffprobe is required/i);
  });

  it('the error never escapes as an uncaught crash — it is a normal rejection', async () => {
    presentBins = new Set();
    clearMediaCapabilityCache();
    const result = await newManager().videoEdit({ input: '/tmp/in.mp4', action: 'trim' })
      .then(() => 'resolved', (e) => (e as Error).message);
    expect(result).toMatch(/ffmpeg is required/i);
  });
});

describe('security — untrusted input path validation', () => {
  it('rejects an input path starting with "-" (flag-injection guard)', async () => {
    await expect(newManager().imageEdit({ input: '-rf', action: 'grayscale' }))
      .rejects.toThrow(/may not start with "-"/);
  });

  it('rejects an input path with control characters', async () => {
    await expect(newManager().imageEdit({ input: '/tmp/a\u0000b.png', action: 'grayscale' }))
      .rejects.toThrow(/control characters/);
  });

  it('rejects a non-existent input file', async () => {
    await expect(newManager().imageEdit({ input: '/tmp/missing-file.png', action: 'grayscale' }))
      .rejects.toThrow(/not found/);
  });

  it('rejects an empty input path', async () => {
    await expect(newManager().mediaInfo(''))
      .rejects.toThrow(/required/);
  });

  it('validates the secondary path too (watermark flag-injection guard)', async () => {
    await expect(newManager().videoEdit({
      input: '/tmp/in.mp4', action: 'watermark', watermarkPath: '--evil',
    })).rejects.toThrow(/may not start with "-"/);
  });
});

describe('argument construction — execFile arg arrays, never a shell', () => {
  it('image grayscale builds a magick arg array with input and a contained output', async () => {
    const out = await newManager().imageEdit({ input: '/tmp/in.png', action: 'grayscale' });
    const call = execFileCalls.find((c) => c.cmd === 'magick');
    expect(call).toBeTruthy();
    // Args are an ARRAY — no shell, no concatenated command string.
    expect(Array.isArray(call!.args)).toBe(true);
    expect(call!.args[0]).toBe('/tmp/in.png');
    expect(call!.args).toContain('-colorspace');
    expect(call!.args).toContain('Gray');
    // Output landed inside the configured output dir.
    expect(out.filePath).toMatch(/^\/tmp\/agenticmail-media-test\//);
    expect(out.sizeBytes).toBe(2048);
  });

  it('image resize encodes the geometry as a single arg element', async () => {
    await newManager().imageEdit({ input: '/tmp/in.png', action: 'resize', width: 640, height: 480 });
    const call = execFileCalls.find((c) => c.cmd === 'magick');
    expect(call!.args).toContain('-resize');
    expect(call!.args).toContain('640x480');
  });

  it('image quality is clamped into [1,100]', async () => {
    await newManager().imageEdit({ input: '/tmp/in.png', action: 'compress', quality: 9999 });
    const call = execFileCalls.find((c) => c.cmd === 'magick');
    const qIdx = call!.args.indexOf('-quality');
    expect(call!.args[qIdx + 1]).toBe('100');
  });

  it('video trim invokes ffmpeg with -ss / -to and a copy codec', async () => {
    await newManager().videoEdit({ input: '/tmp/in.mp4', action: 'trim', start: '5', end: '15' });
    const call = execFileCalls.find((c) => c.cmd === 'ffmpeg');
    expect(call!.args).toContain('-i');
    expect(call!.args).toContain('/tmp/in.mp4');
    expect(call!.args).toContain('-ss');
    expect(call!.args[call!.args.indexOf('-ss') + 1]).toBe('5');
    expect(call!.args).toContain('-to');
    expect(call!.args).toContain('copy');
  });

  it('video crf is clamped into [0,51]', async () => {
    await newManager().videoEdit({ input: '/tmp/in.mp4', action: 'compress', crf: 999 });
    const call = execFileCalls.find((c) => c.cmd === 'ffmpeg' && c.args.includes('-crf'));
    const idx = call!.args.indexOf('-crf');
    expect(call!.args[idx + 1]).toBe('51');
  });

  it('every execFile call passes a bounded timeout', async () => {
    await newManager().videoEdit({ input: '/tmp/in.mp4', action: 'remove_audio' });
    for (const call of execFileCalls) {
      if (call.opts) {
        const timeout = (call.opts as { timeout?: number }).timeout;
        expect(typeof timeout).toBe('number');
        expect(timeout!).toBeGreaterThan(0);
      }
    }
  });

  it('every execFile call passes a bounded maxBuffer', async () => {
    await newManager().videoEdit({ input: '/tmp/in.mp4', action: 'remove_audio' });
    const main = execFileCalls.find((c) => c.cmd === 'ffmpeg');
    expect((main!.opts as { maxBuffer?: number }).maxBuffer).toBeGreaterThan(0);
  });

  it('media_info parses ffprobe JSON into a structured result', async () => {
    const info = await newManager().mediaInfo('/tmp/in.mp4');
    expect(info.ok).toBe(true);
    expect(info.duration).toBe('10.0');
    expect(info.streams[0].type).toBe('video');
    expect(info.streams[0].width).toBe(1920);
  });

  it('audio merge requires at least 2 files', async () => {
    await expect(newManager().audioEdit({ action: 'merge', files: ['/tmp/a.mp3'] }))
      .rejects.toThrow(/at least 2 files/i);
  });

  it('audio fade builds an afade filter as a single arg element', async () => {
    await newManager().audioEdit({ input: '/tmp/a.mp3', action: 'fade', fadeType: 'in', fadeDuration: 2 });
    const call = execFileCalls.find((c) => c.cmd === 'ffmpeg' && c.args.includes('-af'));
    const af = call!.args[call!.args.indexOf('-af') + 1];
    expect(af).toContain('afade=t=in');
  });

  it('unknown actions are rejected with a clear error', async () => {
    await expect(newManager().imageEdit({ input: '/tmp/in.png', action: 'teleport' as never }))
      .rejects.toThrow(/Unknown image action/);
  });
});

describe('tts / voice-clone dispatch', () => {
  it('tts_generate fails with an actionable hint when node-edge-tts is absent', async () => {
    // node-edge-tts is not installed in the test environment.
    await expect(newManager().ttsGenerate({ text: 'hello' }))
      .rejects.toThrow(/node-edge-tts/);
  });

  it('listVoices returns the preset table without touching any binary', () => {
    const voices = newManager().listVoices();
    expect(voices.default).toBeTruthy();
    expect(voices.presets.length).toBeGreaterThan(0);
    expect(execFileCalls.length).toBe(0);
  });

  it('voice_clone requires a caller-supplied reference (no built-in voice)', async () => {
    presentBins = new Set(['ffmpeg', 'ffprobe', 'magick', 'python3']);
    clearMediaCapabilityCache();
    // refText omitted — must be rejected.
    await expect(newManager().voiceClone({
      text: 'hi', refAudio: '/tmp/ref.wav', refText: '' as unknown as string,
    })).rejects.toThrow(/refText is required/);
  });

  it('voice_clone passes the script + a JSON params path to python (no interpolation)', async () => {
    presentBins = new Set(['ffmpeg', 'ffprobe', 'magick', 'python3']);
    clearMediaCapabilityCache();
    await newManager().voiceClone({
      text: 'hello world', refAudio: '/tmp/ref.wav', refText: 'a reference line',
    });
    const call = execFileCalls.find((c) => c.cmd === 'python3');
    expect(call).toBeTruthy();
    // python -c <script> <params-file> — the untrusted text is in the
    // JSON params file, never spliced into the script string.
    expect(call!.args[0]).toBe('-c');
    expect(call!.args[1]).not.toContain('hello world');
    expect(call!.args[2]).toMatch(/voiceclone-params/);
  });
});

describe('security — input confinement and interpreter allow-list', () => {
  it('rejects an input path outside every allowed media root', async () => {
    await expect(newManager().imageEdit({ input: '/etc/passwd', action: 'grayscale' }))
      .rejects.toThrow(/outside the allowed media directories/);
    expect(execFileCalls.find((c) => c.cmd === 'magick')).toBeUndefined();
  });

  it('rejects ../ traversal that escapes the temp dir', async () => {
    await expect(newManager().mediaInfo('/tmp/../etc/hosts'))
      .rejects.toThrow(/outside the allowed media directories/);
  });

  it('rejects hidden top-level entries under the home directory', async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    await expect(newManager().mediaInfo(join(homedir(), '.ssh', 'id_rsa')))
      .rejects.toThrow(/outside the allowed media directories/);
  });

  it('accepts a normal file under the home directory', async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    presentBins = new Set(['ffmpeg', 'ffprobe', 'magick']);
    clearMediaCapabilityCache();
    const input = join(homedir(), 'Videos', 'clip.mp4');
    await newManager().mediaInfo(input);
    const call = execFileCalls.find((c) => c.cmd === 'ffprobe');
    expect(call!.args).toContain(input);
  });

  it('confines every file of a merge, not just the first', async () => {
    await expect(newManager().audioEdit({
      action: 'merge', files: ['/tmp/a.mp3', '/etc/shadow'],
    })).rejects.toThrow(/files\[1\] file path is outside/);
  });

  it('confines a caller-supplied whisper model path', async () => {
    presentBins = new Set(['ffmpeg', 'ffprobe', 'whisper-cli']);
    clearMediaCapabilityCache();
    await expect(newManager().videoUnderstand({ input: '/tmp/in.mp4', whisperModel: '/etc/passwd' }))
      .rejects.toThrow(/whisperModel file path is outside/);
  });

  it('voice_clone refuses a pythonBin that is not a Python interpreter', async () => {
    await expect(newManager().voiceClone({
      text: 'hi', refAudio: '/tmp/ref.wav', refText: 'ref', pythonBin: '/bin/sh',
    })).rejects.toThrow(/Invalid pythonBin/);
    await expect(newManager().voiceClone({
      text: 'hi', refAudio: '/tmp/ref.wav', refText: 'ref', pythonBin: 'python3',
    })).rejects.toThrow(/absolute path/);
    expect(execFileCalls.find((c) => c.cmd === '/bin/sh')).toBeUndefined();
  });

  it('voice_clone accepts a venv python interpreter path', async () => {
    await newManager().voiceClone({
      text: 'hi', refAudio: '/tmp/ref.wav', refText: 'ref', pythonBin: '/tmp/venv/bin/python3.12',
    });
    expect(execFileCalls.find((c) => c.cmd === '/tmp/venv/bin/python3.12')).toBeTruthy();
  });
});
