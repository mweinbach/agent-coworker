export function createTrayMaskBitmap(bitmap: Uint8Array | Buffer): Buffer {
  const source = Buffer.from(bitmap);
  const next = Buffer.from(source);

  for (let offset = 0; offset + 3 < source.length; offset += 4) {
    const blue = source[offset] ?? 0;
    const green = source[offset + 1] ?? 0;
    const red = source[offset + 2] ?? 0;
    const alpha = source[offset + 3] ?? 0;
    const luminance = Math.round((0.114 * blue) + (0.587 * green) + (0.299 * red));
    const maskedAlpha = Math.round((255 - luminance) * (alpha / 255));

    next[offset] = 0;
    next[offset + 1] = 0;
    next[offset + 2] = 0;
    next[offset + 3] = maskedAlpha;
  }

  return next;
}
