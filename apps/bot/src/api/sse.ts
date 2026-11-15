/**
 * Server-sent-events reader.
 *
 * The control plane streams `event: job_event` / `event: job_done` frames plus
 * `: keepalive` comments. This parser is deliberately small and total: unknown
 * frames are yielded as-is (the caller decides what to ignore), comments are
 * dropped, and a truncated final frame is discarded rather than guessed at.
 */

export interface SseFrame {
  /** `event:` field; defaults to `message` per the SSE spec. */
  readonly event: string;
  /** `data:` lines joined with newlines. */
  readonly data: string;
}

/** Split a buffer on blank lines, tolerating CRLF. Exported for tests. */
export function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { blocks: parts, rest };
}

/** Parse one block of `event:`/`data:`/`id:`/comment lines. */
export function parseSseBlock(block: string): SseFrame | null {
  const dataLines: string[] = [];
  let event = 'message';
  let sawField = false;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') continue;
    // A leading colon is a comment (keepalive).
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value || 'message';
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    } else if (field === 'id' || field === 'retry') {
      sawField = true;
    }
  }
  if (!sawField || dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Yield frames from a byte stream until it closes.
 *
 * The caller owns cancellation: aborting the fetch's `AbortSignal` makes the
 * reader throw, which propagates out of the generator.
 */
export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { blocks, rest } = splitSseBlocks(buffer);
      buffer = rest;
      for (const block of blocks) {
        const frame = parseSseBlock(block);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    const { blocks } = splitSseBlocks(buffer);
    for (const block of blocks) {
      const frame = parseSseBlock(block);
      if (frame) yield frame;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader already released by cancellation; nothing to do.
    }
  }
}

/** Convenience: decode a fetch Response into frames. */
export async function* readSseResponse(
  response: Response,
): AsyncGenerator<SseFrame, void, void> {
  if (!response.body) return;
  yield* readSseStream(response.body);
}

/** Build an SSE body from text chunks; used by tests and tooling. */
export function sseStreamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}