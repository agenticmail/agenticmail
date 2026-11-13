/**
 * Media routes — HTTP surface for the @agenticmail/core MediaManager.
 *
 * The MCP and OpenClaw `media_*` tools are thin clients of these
 * routes, consistent with how the phone / sms / telegram surfaces are
 * wired. Every operation is delegated to MediaManager, which drives
 * external system binaries (ffmpeg, ffprobe, ImageMagick, whisper.cpp,
 * Python) via execFile with argument arrays — never a shell.
 *
 * # Graceful degradation
 *
 * None of those binaries are bundled. MediaManager feature-detects the
 * binary each operation needs and throws an actionable error ("ffmpeg
 * is required … install it: …") when it is absent. These routes map
 * that error to HTTP 503 (Service Unavailable) so an agent learns the
 * capability is missing without the server ever crashing. The
 * `/media/capabilities` route surfaces the full detection report so an
 * agent can check what is available before attempting an operation.
 */

import { Router, type Request, type Response } from 'express';
import { MediaManager, type AgenticMailConfig } from '@agenticmail/core';

/** Detect MediaManager's "binary missing" error so it can map to 503. */
function isBinaryUnavailableError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /\bis required\b/.test(msg) && /\binstall\b/i.test(msg);
}

/** Coerce a request value to a trimmed string. */
function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when a media error message describes bad caller input (→ 400). */
export function isInputValidationMessage(msg: string): boolean {
  // Messages can echo caller input, so: bounded length, and no
  // `.*`-style pattern that backtracks quadratically (CodeQL
  // js/polynomial-redos). "Unknown … action" is two independent tests.
  const head = msg.slice(0, 1000);
  if (/required|not found|Invalid|may not start|outside the allowed/i.test(head)) return true;
  return /\bUnknown\b/i.test(head) && /\baction\b/i.test(head);
}

/**
 * Centralised media error responder.
 *   - "binary missing" → 503, so an agent learns the capability is
 *     opt-in / not installed (the message carries the install hint).
 *   - input-validation phrasing ("required", "not found", "Invalid",
 *     "Unknown … action", "outside the allowed …") → 400.
 *   - everything else → 500.
 */
function sendMediaError(res: Response, err: unknown): void {
  const msg = (err as Error)?.message ?? String(err);
  if (isBinaryUnavailableError(err)) {
    res.status(503).json({ error: msg, capabilityMissing: true });
    return;
  }
  if (isInputValidationMessage(msg)) {
    res.status(400).json({ error: msg });
    return;
  }
  res.status(500).json({ error: msg });
}

export function createMediaRoutes(config: AgenticMailConfig): Router {
  const router = Router();
  // Output files land under <dataDir>/media. Input paths come from the
  // caller (validated inside MediaManager); output paths are generated
  // by MediaManager and never derived from caller input.
  const media = new MediaManager({ dataDir: config.dataDir });

  /** Get the authenticated agent or write 401. */
  function getAgent(req: Request, res: Response): { id: string; email: string } | null {
    const agent = (req as any).agent;
    if (!agent) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return agent;
  }

  // GET /media/capabilities — binary feature-detection report. Agent
  // key scoped; lets an agent see ffmpeg/ffprobe/ImageMagick/whisper/
  // Python/edge-tts availability before attempting an operation.
  router.get('/media/capabilities', (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const force = requestString(req.query.refresh) === 'true';
      res.json(media.capabilities({ force }));
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // GET /media/voices — list the built-in Edge TTS voice presets.
  router.get('/media/voices', (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      res.json(media.listVoices());
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/tts — synthesise speech from text.
  router.post('/media/tts', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.ttsGenerate({
        text: req.body?.text,
        voice: req.body?.voice,
        rate: req.body?.rate,
        pitch: req.body?.pitch,
      });
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/image — edit an image (resize / crop / overlay / …).
  router.post('/media/image', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.imageEdit({
        input: req.body?.input,
        action: req.body?.action,
        width: req.body?.width,
        height: req.body?.height,
        angle: req.body?.angle,
        format: req.body?.format,
        quality: req.body?.quality,
        text: req.body?.text,
        position: req.body?.position,
        fontSize: req.body?.fontSize,
        fontColor: req.body?.fontColor,
        blurRadius: req.body?.blurRadius,
        direction: req.body?.direction,
        offsetX: req.body?.offsetX,
        offsetY: req.body?.offsetY,
      });
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/video — edit a video (trim / caption / cinematic ops).
  router.post('/media/video', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.videoEdit({
        input: req.body?.input,
        action: req.body?.action,
        start: req.body?.start,
        end: req.body?.end,
        duration: req.body?.duration,
        timestamp: req.body?.timestamp,
        interval: req.body?.interval,
        format: req.body?.format,
        width: req.body?.width,
        height: req.body?.height,
        fps: req.body?.fps,
        crf: req.body?.crf,
        audioPath: req.body?.audioPath,
        speedFactor: req.body?.speedFactor,
        secondInput: req.body?.secondInput,
        transitionType: req.body?.transitionType,
        transitionDuration: req.body?.transitionDuration,
        text: req.body?.text,
        fontSize: req.body?.fontSize,
        fontColor: req.body?.fontColor,
        textPosition: req.body?.textPosition,
        textBg: req.body?.textBg,
        textStart: req.body?.textStart,
        textEnd: req.body?.textEnd,
        overlayOpacity: req.body?.overlayOpacity,
        overlayScale: req.body?.overlayScale,
        watermarkPosition: req.body?.watermarkPosition,
        watermarkPath: req.body?.watermarkPath,
        pipWidth: req.body?.pipWidth,
        pipPosition: req.body?.pipPosition,
        splitDirection: req.body?.splitDirection,
        zoomDirection: req.body?.zoomDirection,
        zoomDuration: req.body?.zoomDuration,
        zoomFactor: req.body?.zoomFactor,
        files: req.body?.files,
        bgVolume: req.body?.bgVolume,
        fgVolume: req.body?.fgVolume,
        colorPreset: req.body?.colorPreset,
        lutPath: req.body?.lutPath,
        captionColor: req.body?.captionColor,
        captionFontSize: req.body?.captionFontSize,
        whisperModel: req.body?.whisperModel,
      });
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/audio — edit audio (trim / convert / merge / fade / …).
  router.post('/media/audio', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.audioEdit({
        input: req.body?.input,
        action: req.body?.action,
        start: req.body?.start,
        end: req.body?.end,
        duration: req.body?.duration,
        format: req.body?.format,
        files: req.body?.files,
        volume: req.body?.volume,
        speedFactor: req.body?.speedFactor,
        fadeType: req.body?.fadeType,
        fadeDuration: req.body?.fadeDuration,
      });
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/info — probe a media file's metadata.
  router.post('/media/info', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.mediaInfo(req.body?.input);
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/understand — frames + transcript timeline of a video.
  router.post('/media/understand', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.videoUnderstand({
        input: req.body?.input,
        frameInterval: req.body?.frameInterval,
        maxFrames: req.body?.maxFrames,
        whisperModel: req.body?.whisperModel,
      });
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  // POST /media/voice-clone — reference-voice speech synthesis (F5-TTS).
  router.post('/media/voice-clone', async (req: Request, res: Response) => {
    try {
      if (!getAgent(req, res)) return;
      const result = await media.voiceClone({
        text: req.body?.text,
        refAudio: req.body?.refAudio,
        refText: req.body?.refText,
        // pythonBin is intentionally NOT taken from the request: it names a
        // binary the server executes. Operators pick the interpreter with
        // AGENTICMAIL_PYTHON_BIN (or PATH); agents cannot.
        device: req.body?.device,
      });
      res.json(result);
    } catch (err) {
      sendMediaError(res, err);
    }
  });

  return router;
}
