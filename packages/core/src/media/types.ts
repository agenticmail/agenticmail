// @agenticmail/core — Media toolset types
//
// Shared types for the media module: the eight media operations
// (TTS, image / video / audio editing, probing, video understanding,
// voice cloning), their option shapes, and the binary-capability
// surface used for graceful degradation.

/** External binary a media operation depends on. */
export type MediaBinary = 'ffmpeg' | 'ffprobe' | 'imagemagick' | 'whisper' | 'python' | 'edge-tts';

/**
 * Detection result for one external binary. `available: false` carries
 * an actionable `installHint` the agent can relay to the operator.
 */
export interface MediaCapability {
  /** Binary identifier. */
  binary: MediaBinary;
  /** Whether the binary was found and is runnable. */
  available: boolean;
  /** Version string when detectable. */
  version?: string;
  /** Resolved path / command used to invoke it. */
  command?: string;
  /** Human-readable description of what it powers. */
  description: string;
  /** Install instructions, present when `available` is false. */
  installHint?: string;
}

/** Aggregate media capability report — one entry per binary. */
export interface MediaCapabilityReport {
  /** Per-binary detection results. */
  capabilities: MediaCapability[];
  /** True when at least ffmpeg + ffprobe are present (the baseline). */
  ready: boolean;
  /** When the report was generated. */
  checkedAt: string;
}

/** Result envelope for an operation that produced an output file. */
export interface MediaFileResult {
  ok: true;
  /** Absolute path of the produced file. */
  filePath: string;
  /** Size of the produced file in bytes. */
  sizeBytes: number;
  /** Output container/format, when meaningful. */
  format?: string;
  /** Operation-specific extra fields. */
  [key: string]: unknown;
}

// ─── tts_generate ────────────────────────────────────────────────────

export interface TtsGenerateOptions {
  /** Text to synthesise. */
  text: string;
  /** Voice preset name or a full Edge voice id. */
  voice?: string;
  /** Speaking rate, e.g. "+20%" / "-10%". */
  rate?: string;
  /** Pitch shift, e.g. "+5Hz" / "-10Hz". */
  pitch?: string;
}

// ─── image_edit ──────────────────────────────────────────────────────

export type ImageAction =
  | 'resize' | 'crop' | 'rotate' | 'convert' | 'compress'
  | 'text_overlay' | 'flip' | 'blur' | 'sharpen' | 'grayscale';

export interface ImageEditOptions {
  /** Absolute path to the input image. */
  input: string;
  /** Edit action to perform. */
  action: ImageAction;
  width?: number;
  height?: number;
  angle?: number;
  format?: string;
  quality?: number;
  text?: string;
  position?: string;
  fontSize?: number;
  fontColor?: string;
  blurRadius?: number;
  direction?: 'horizontal' | 'vertical';
  offsetX?: number;
  offsetY?: number;
}

// ─── video_edit ──────────────────────────────────────────────────────

export type VideoAction =
  | 'trim' | 'extract_frame' | 'extract_frames' | 'convert' | 'gif'
  | 'compress' | 'resize' | 'add_audio' | 'remove_audio' | 'speed'
  | 'color_grade' | 'transition' | 'text_overlay' | 'picture_in_picture'
  | 'split_screen' | 'ken_burns' | 'slow_motion' | 'watermark'
  | 'concatenate' | 'audio_mix' | 'auto_caption';

export interface VideoEditOptions {
  /** Absolute path to the input video (or image for ken_burns). */
  input: string;
  /** Edit action to perform. */
  action: VideoAction;
  start?: string;
  end?: string;
  duration?: string;
  timestamp?: string;
  interval?: number;
  format?: string;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  audioPath?: string;
  speedFactor?: number;
  secondInput?: string;
  transitionType?: string;
  transitionDuration?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  textPosition?: string;
  textBg?: string;
  textStart?: string;
  textEnd?: string;
  overlayOpacity?: number;
  overlayScale?: number;
  watermarkPosition?: string;
  watermarkPath?: string;
  pipWidth?: number;
  pipPosition?: string;
  splitDirection?: 'horizontal' | 'vertical';
  zoomDirection?: string;
  zoomDuration?: number;
  zoomFactor?: number;
  files?: string[];
  bgVolume?: string;
  fgVolume?: string;
  colorPreset?: string;
  lutPath?: string;
  captionColor?: string;
  captionFontSize?: number;
  /** Path to a whisper.cpp model file (.bin) — required for auto_caption. */
  whisperModel?: string;
}

// ─── audio_edit ──────────────────────────────────────────────────────

export type AudioAction =
  | 'trim' | 'convert' | 'merge' | 'volume' | 'speed'
  | 'extract' | 'reverse' | 'fade';

export interface AudioEditOptions {
  /** Absolute path to the input audio (or video for `extract`). */
  input?: string;
  /** Edit action to perform. */
  action: AudioAction;
  start?: string;
  end?: string;
  duration?: string;
  format?: string;
  files?: string[];
  volume?: string;
  speedFactor?: number;
  fadeType?: 'in' | 'out' | 'both';
  fadeDuration?: number;
}

// ─── media_info ──────────────────────────────────────────────────────

export interface MediaStreamInfo {
  type?: string;
  codec?: string;
  width?: number;
  height?: number;
  duration?: string;
  bitRate?: string;
  sampleRate?: string;
  channels?: number;
  fps?: string;
}

export interface MediaInfoResult {
  ok: true;
  file: string;
  format?: string;
  duration?: string;
  sizeBytes: number;
  bitRate?: string;
  streams: MediaStreamInfo[];
}

// ─── video_understand ────────────────────────────────────────────────

export interface VideoUnderstandOptions {
  /** Absolute path to the input video. */
  input: string;
  /** Seconds between extracted frames (default 3). */
  frameInterval?: number;
  /** Maximum number of frames to extract (default 30). */
  maxFrames?: number;
  /** Path to a whisper.cpp model file (.bin) — enables transcription. */
  whisperModel?: string;
}

export interface VideoTimelineEntry {
  timeSeconds: number;
  timeDisplay: string;
  framePath: string;
  spokenText: string;
}

export interface VideoUnderstandResult {
  ok: true;
  video: string;
  duration: number;
  resolution: string;
  totalFramesExtracted: number;
  transcriptSegments: number;
  timeline: VideoTimelineEntry[];
  frameDir: string;
  hint: string;
}

// ─── voice_clone ─────────────────────────────────────────────────────

export interface VoiceCloneOptions {
  /** Text to speak in the cloned voice. */
  text: string;
  /** Absolute path to the reference audio sample (required). */
  refAudio: string;
  /** Transcript of the reference audio (required). */
  refText: string;
  /**
   * Optional absolute path to the Python interpreter with F5-TTS installed.
   * Library callers only — the HTTP route never forwards it. Must be named
   * like a Python interpreter. Falls back to AGENTICMAIL_PYTHON_BIN, then PATH.
   */
  pythonBin?: string;
  /** Compute device passed to F5-TTS (default 'cpu'). */
  device?: string;
}
