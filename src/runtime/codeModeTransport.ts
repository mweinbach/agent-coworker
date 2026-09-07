/** Newline-delimited JSON. Bound bytes BEFORE decoding or parsing each frame. */
export class CodeModeFrameDecoder {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Uint8Array, receive: (message: unknown) => void): void {
    let offset = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.append(chunk.subarray(offset, index));
      const decoded = this.decoder.decode(this.buffer.subarray(0, this.length));
      this.length = 0;
      receive(JSON.parse(decoded));
      offset = index + 1;
    }
    if (offset < chunk.length) this.append(chunk.subarray(offset));
  }

  end(): void {
    if (this.length !== 0) throw new Error("incomplete code mode transport frame");
  }

  private append(bytes: Uint8Array): void {
    const length = this.length + bytes.byteLength;
    if (length > this.maxFrameBytes) throw new Error("code mode transport frame exceeds limit");
    if (length > this.buffer.length) {
      const capacity = Math.min(this.maxFrameBytes, Math.max(length, this.buffer.length * 2, 4096));
      const buffer = Buffer.allocUnsafe(capacity);
      this.buffer.copy(buffer, 0, 0, this.length);
      this.buffer = buffer;
    }
    // A single geometrically grown buffer also bounds overhead when an
    // adversarial sender fragments one frame into millions of one-byte chunks.
    this.buffer.set(bytes, this.length);
    this.length = length;
  }
}

export function encodeCodeModeFrame(message: unknown, maxFrameBytes: number): string {
  const payload = JSON.stringify(message);
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > maxFrameBytes) {
    throw new Error("code mode transport frame exceeds limit");
  }
  return `${payload}\n`;
}
