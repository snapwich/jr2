// A minimal Server-Sent-Events frame parser over a `ReadableStream<Uint8Array>` (the body the
// orchestrator's `streamSSE` produces). Just enough of the SSE grammar for this surface: frames are
// separated by a blank line; within a frame `event:` names the channel (default "message") and one or
// more `data:` lines form the payload. We don't need ids, retry, or comments.
//
// Cancelling the reader in `finally` means a consumer that `break`s out of `for await` closes the
// underlying HTTP connection — that is how `jr2 run` / `jr2 logs` detach without killing the run.

export type SSEFrame = { event: string; data: string };

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = parseFrame(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (frame) yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Parse one frame's lines into `{ event, data }`; returns undefined for a frame with no data. */
function parseFrame(block: string): SSEFrame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}
