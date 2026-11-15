/**
 * Voice messages.
 *
 * Discord voice notes arrive as ordinary file attachments, so the path is:
 *
 *   detect audio → download (bounded) → base64 → POST /v1/voice/transcribe →
 *   post the transcript → treat the transcript as the request text.
 *
 * Three deliberate choices:
 *
 *  - **Size is checked twice.** Once from the attachment metadata (saves a
 *    download), and once from the actual bytes (a lying `size` must not be able
 *    to make the bot buffer a huge file).
 *  - **The transcript is posted before it is acted on.** The user must see what
 *    the bot thinks they said, because speech recognition is the only place in
 *    this bot where the request text is not literally the user's words.
 *  - **Failures are per-message.** A transcription failure replies with the
 *    reason and does not stop the bot or consume the message.
 */
import { ApiError, ApiUnreachableError, describeError, type FetchLike, type OperantApi } from '../api/client.js';
import type { TranscribeResponse } from '../api/types.js';
import type { IncomingAttachment } from '../discord/types.js';
import type { Logger } from '../logger.js';

/** Extensions Discord uses for audio attachments. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'opus',
  'webm',
  'flac',
  'aac',
]);

/** Mime types that are audio even when the filename has no usable extension. */
const AUDIO_MIME_PATTERN = /^(audio\/|video\/webm$|application\/ogg$)/i;

export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index === -1 || index === filename.length - 1) return '';
  return filename.slice(index + 1).toLowerCase();
}

/** An attachment is audio when its extension *or* its content type says so. */
export function isAudioAttachment(attachment: IncomingAttachment): boolean {
  if (attachment.contentType && AUDIO_MIME_PATTERN.test(attachment.contentType)) return true;
  return AUDIO_EXTENSIONS.has(extensionOf(attachment.name));
}

export function findAudioAttachment(
  attachments: readonly IncomingAttachment[] | undefined,
): IncomingAttachment | null {
  if (!attachments) return null;
  for (const attachment of attachments) {
    if (isAudioAttachment(attachment)) return attachment;
  }
  return null;
}

export interface VoiceDeps {
  readonly api: Pick<OperantApi, 'transcribe'>;
  readonly logger: Logger;
  readonly maxAttachmentBytes: number;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** 'fast' keeps the Discord round-trip short; 'accurate' is for offline use. */
  readonly profile?: 'fast' | 'accurate';
}

export type VoiceResult =
  | { readonly ok: true; readonly transcript: TranscribeResponse; readonly bytes: number }
  | { readonly ok: false; readonly error: string };

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Download and transcribe one attachment.
 *
 * Never throws: every failure is returned as `{ ok: false, error }` so the caller
 * can tell the user something specific.
 */
export async function transcribeAudioAttachment(
  attachment: IncomingAttachment,
  deps: VoiceDeps,
): Promise<VoiceResult> {
  const max = deps.maxAttachmentBytes;
  if (attachment.size > max) {
    return {
      ok: false,
      error: `audio attachment is ${humanBytes(attachment.size)}, above the ${humanBytes(max)} limit — send a shorter clip or upload it as a file`,
    };
  }

  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  let bytes: Buffer;
  try {
    const response = await fetchImpl(attachment.url, {
      method: 'GET',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
    });
    if (!response.ok) {
      return { ok: false, error: `could not download the audio (HTTP ${response.status})` };
    }
    const arrayBuffer = await response.arrayBuffer();
    bytes = Buffer.from(arrayBuffer);
  } catch (error) {
    deps.logger.warn('audio download failed', {
      attachment: attachment.name,
      error: describeError(error),
    });
    return { ok: false, error: `could not download the audio: ${describeError(error)}` };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, error: 'the downloaded audio was empty' };
  }
  if (bytes.byteLength > max) {
    return {
      ok: false,
      error: `download was ${humanBytes(bytes.byteLength)}, above the ${humanBytes(max)} limit`,
    };
  }

  try {
    const transcript = await deps.api.transcribe(bytes.toString('base64'), {
      ...(deps.profile ? { profile: deps.profile } : {}),
    });
    if (transcript.text.trim() === '') {
      return { ok: false, error: 'the transcription came back empty — no speech detected' };
    }
    return { ok: true, transcript, bytes: bytes.byteLength };
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) {
      return { ok: false, error: `the speech service rejected the audio as too large (${error.code})` };
    }
    if (error instanceof ApiUnreachableError) {
      return { ok: false, error: 'the speech service is unreachable from the control plane' };
    }
    deps.logger.warn('transcription failed', {
      attachment: attachment.name,
      error: describeError(error),
    });
    return { ok: false, error: `transcription failed: ${describeError(error)}` };
  }
}