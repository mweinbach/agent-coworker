import { inflateSync } from "node:zlib";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Strict bounded decoder for Poppler's non-interlaced 8-bit RGB/RGBA PNGs. */
export function validatePng(png: Buffer): { width: number; height: number; inkPixels: number } {
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("Invalid PNG signature");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let ended = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (length > 10_000_000 || offset + 12 + length > png.length)
      throw new Error("Invalid PNG chunk");
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const bytes = png.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)
    ) {
      throw new Error("PNG CRC mismatch");
    }
    if (offset === 8 && type !== "IHDR") throw new Error("Missing PNG header");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new Error("Invalid PNG header");
      width = bytes.readUInt32BE(0);
      height = bytes.readUInt32BE(4);
      channels = bytes[9] === 2 ? 3 : bytes[9] === 6 ? 4 : 0;
      if (
        !channels ||
        bytes[8] !== 8 ||
        bytes[10] ||
        bytes[11] ||
        bytes[12] ||
        Math.max(width, height) !== 1200 ||
        Math.min(width, height) < 100
      )
        throw new Error("Unexpected PNG format/dimensions");
    } else if (type === "IDAT") compressed.push(bytes);
    else if (type === "IEND") {
      if (length !== 0) throw new Error("Invalid PNG end");
      ended = true;
      offset += 12;
      break;
    } else if (type[0] === type[0]?.toUpperCase())
      throw new Error(`Unknown critical PNG chunk: ${type}`);
    offset += length + 12;
  }
  if (!ended || offset !== png.length || !compressed.length) throw new Error("Truncated PNG");
  const stride = width * channels;
  const expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error("Wrong PNG decoded size");
  let previous = Buffer.alloc(stride);
  let inkPixels = 0;
  let lightPixels = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error("Invalid PNG filter");
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      row[x] = (row[x] + [0, a, b, Math.floor((a + b) / 2), paeth][filter]) & 255;
    }
    for (let x = 0; x < stride; x += channels) {
      if (channels === 4 && row[x + 3] !== 255)
        throw new Error("Unexpected transparent PDF render");
      const light = (row[x] + row[x + 1] + row[x + 2]) / 3;
      if (light < 230) inkPixels++;
      if (light > 245) lightPixels++;
    }
    previous = row;
  }
  if (inkPixels < width * height * 0.001 || lightPixels < width * height * 0.01) {
    throw new Error("Blank or solid PNG");
  }
  return { width, height, inkPixels };
}
