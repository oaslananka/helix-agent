import type { WSClient } from './wsClient.js';

export interface StreamChunk {
  callId: string;
  index: number;
  content: string;
  isFinal: boolean;
}

const CHUNK_SIZE = 8192; // 8KB per chunk

/**
 * Send a large tool result in chunks over WebSocket.
 * Gateway'in chunked sonuçları birleştireceği varsayılır.
 */
export async function sendStreamingResult(
  wsClient: WSClient,
  callId: string,
  content: string
): Promise<void> {
  if (content.length <= CHUNK_SIZE) {
    // Small result — send as normal
    await wsClient.sendCallResult(callId, [{ type: 'text', text: content }]);
    return;
  }

  // Large result — stream in chunks
  let index = 0;
  for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
    const chunk = content.slice(offset, offset + CHUNK_SIZE);
    const isFinal = offset + CHUNK_SIZE >= content.length;

    await wsClient.sendStreamChunk({
      callId,
      index,
      content: chunk,
      isFinal,
    });

    index++;

    // Small delay to prevent flooding
    if (!isFinal) await new Promise((r) => setTimeout(r, 10));
  }
}
