/**
 * Voice messages.
 *
 * The asserted path is the whole one: audio attachment → bounded download →
 * base64 → POST /v1/voice/transcribe → transcript posted → transcript used as
 * the request text. The failure tests prove the bot says something specific and
 * never falls through to submitting an empty request.
 */
import { describe, expect, it } from 'vitest';
import { OperantApi } from '../src/api/client.js';
import { OperantBot } from '../src/bot/handler.js';
import {
  AUDIO_EXTENSIONS,
  extensionOf,
  findAudioAttachment,
  isAudioAttachment,
} from '../src/bot/voice.js';
import { silentLogger } from '../src/logger.js';
import {
  FakeIncomingMessage,
  acceptedResponse,
  jsonResponse,
  makeApprovalSink,
  makeFetch,
  makeTestConfig,
  sseResponse,
  successfulJobFrames,
  textResponse,
} from './support/fakes.js';

const AUDIO_BYTES = Buffer.from('OggS-not-really-audio-but-bytes', 'utf8');

function build(handlerOverrides: Record<string, () => Response> = {}, maxBytes = 25 * 1024 * 1024) {
  const fetcher = makeFetch((call) => {
    if (call.url.startsWith('https://cdn.example/')) {
      const override = handlerOverrides['download'];
      if (override) return override();
      return new Response(AUDIO_BYTES, { status: 200 });
    }
    if (call.method === 'POST' && call.url.includes('/v1/voice/transcribe')) {
      const override = handlerOverrides['transcribe'];
      if (override) return override();
      return jsonResponse(200, {
        text: 'deploy the api and tell me when it is green',
        language: 'en',
        durationSec: 3.4,
        model: 'faster-whisper-small',
        rtf: 0.18,
      });
    }
    if (call.method === 'POST' && call.url.includes('/v1/requests')) {
      return jsonResponse(202, acceptedResponse());
    }
    if (call.url.includes('/stream')) return sseResponse(successfulJobFrames('deployed'));
    return jsonResponse(404, { error: 'not_found' });
  });
  const config = makeTestConfig({ editIntervalMs: 5, maxAttachmentBytes: maxBytes });
  const bot = new OperantBot({
    config,
    api: new OperantApi({
      base: config.apiBase,
      token: config.apiToken,
      fetchImpl: fetcher.fetchImpl,
      maxRetries: 0,
    }),
    logger: silentLogger(),
    approvals: makeApprovalSink(),
    fetchImpl: fetcher.fetchImpl,
  });
  return { bot, fetcher };
}

const voiceAttachment = (overrides: Partial<{
  name: string;
  contentType: string;
  size: number;
  url: string;
}> = {}) => ({
  id: 'att-1',
  name: overrides.name ?? 'voice-message.ogg',
  contentType: overrides.contentType ?? 'audio/ogg',
  size: overrides.size ?? AUDIO_BYTES.byteLength,
  url: overrides.url ?? 'https://cdn.example/voice-message.ogg',
});

describe('audio attachment detection', () => {
  it('accepts every documented extension', () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(extensionOf(`note.${ext.toUpperCase()}`)).toBe(ext);
      expect(
        isAudioAttachment({
          id: 'a',
          name: `note.${ext}`,
          contentType: 'application/octet-stream',
          size: 1,
          url: 'https://cdn.example/x',
        }),
      ).toBe(true);
    }
  });

  it('accepts an audio content type even with an odd filename', () => {
    expect(
      isAudioAttachment({
        id: 'a',
        name: 'clip.dat',
        contentType: 'audio/mpeg',
        size: 1,
        url: 'https://cdn.example/x',
      }),
    ).toBe(true);
  });

  it('rejects images and text files', () => {
    expect(
      findAudioAttachment([
        { id: 'a', name: 'shot.png', contentType: 'image/png', size: 1, url: 'https://cdn.example/x' },
        { id: 'b', name: 'notes.txt', contentType: 'text/plain', size: 1, url: 'https://cdn.example/y' },
      ]),
    ).toBeNull();
  });
});

describe('voice message path', () => {
  it('downloads, base64s, transcribes, posts the transcript, and treats it as the request', async () => {
    const { bot, fetcher } = build();
    const message = new FakeIncomingMessage({
      channelId: 'chan-voice',
      content: '',
      attachments: [voiceAttachment()],
    });

    await bot.handleMessage(message);
    await bot.whenIdle();

    // 1. the attachment was downloaded
    const downloads = fetcher.calls.filter((call) => call.url.startsWith('https://cdn.example/'));
    expect(downloads).toHaveLength(1);

    // 2. the transcript call carried the exact base64 of the downloaded bytes
    const transcribes = fetcher.matching('POST', '/v1/voice/transcribe');
    expect(transcribes).toHaveLength(1);
    const payload = transcribes[0]!.json as Record<string, unknown>;
    const expected = AUDIO_BYTES.toString('base64');
    expect(payload['audioBase64']).toBe(expected);
    // The deployed API validates `ref`; the published contract names `audioBase64`.
    expect(payload['ref']).toBe(expected);
    expect(payload['profile']).toBe('fast');
    expect(transcribes[0]!.headers['authorization']).toBe('Bearer test-api-token');

    // 3. the transcript is posted for the user to check, before anything runs
    const transcriptReply = message.replies[0]!;
    expect(transcriptReply.initial?.content).toContain('Transcribing');
    expect(transcriptReply.lastContent).toContain('Transcript');
    expect(transcriptReply.lastContent).toContain('faster-whisper-small');
    expect(transcriptReply.lastContent).toContain('deploy the api');

    // 4. the transcript became the request text
    const posts = fetcher.matching('POST', '/v1/requests');
    expect(posts).toHaveLength(1);
    expect((posts[0]!.json as Record<string, unknown>)['text']).toBe(
      'deploy the api and tell me when it is green',
    );

    // 5. the working message is the second reply and finishes as completed
    expect(message.replies).toHaveLength(2);
    expect(message.replies[1]!.lastContent).toContain('Work completed');

    await bot.shutdown();
  });

  it('refuses an oversized attachment before downloading it', async () => {
    const { bot, fetcher } = build({}, 1_024);
    const message = new FakeIncomingMessage({
      content: '',
      attachments: [voiceAttachment({ size: 5 * 1_024 * 1_024 })],
    });

    await bot.handleMessage(message);

    expect(fetcher.calls).toHaveLength(0);
    const reply = message.replies[0]!;
    expect(reply.lastContent).toContain('could not transcribe that audio');
    expect(reply.lastContent).toContain('above the');
    expect(reply.lastContent).toContain('limit');
    await bot.shutdown();
  });

  it('reports a transcription failure and does not submit a request', async () => {
    const { bot, fetcher } = build({
      transcribe: () => textResponse(502, '{"error":"model crashed"}'),
    });
    const message = new FakeIncomingMessage({
      content: '',
      attachments: [voiceAttachment()],
    });

    await bot.handleMessage(message);

    expect(fetcher.count('POST', '/v1/requests')).toBe(0);
    const reply = message.replies[0]!;
    expect(reply.lastContent).toContain('could not transcribe that audio');
    expect(reply.lastContent).toContain('transcription failed');
    await bot.shutdown();
  });

  it('reports an empty transcript instead of submitting an empty request', async () => {
    const { bot, fetcher } = build({
      transcribe: () =>
        jsonResponse(200, { text: '   ', language: null, durationSec: 1, model: 'x', rtf: 1 }),
    });
    const message = new FakeIncomingMessage({ content: '', attachments: [voiceAttachment()] });

    await bot.handleMessage(message);

    expect(fetcher.count('POST', '/v1/requests')).toBe(0);
    expect(message.replies[0]!.lastContent).toContain('no speech detected');
    await bot.shutdown();
  });

  it('combines typed text with a voice note rather than dropping either', async () => {
    const { bot, fetcher } = build();
    const message = new FakeIncomingMessage({
      content: 'context: production only',
      attachments: [voiceAttachment()],
    });

    await bot.handleMessage(message);
    await bot.whenIdle();

    const text = (fetcher.matching('POST', '/v1/requests')[0]!.json as Record<string, unknown>)['text'];
    expect(String(text)).toContain('context: production only');
    expect(String(text)).toContain('deploy the api');
    await bot.shutdown();
  });
});