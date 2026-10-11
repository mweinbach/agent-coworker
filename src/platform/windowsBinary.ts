import fs from "node:fs";

/** Read the PE machine without launching an executable (which Windows may emulate). */
export function readWindowsPeMachine(filePath: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length) return null;
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    const offset = dos.readUInt32LE(0x3c);
    if (offset < dos.length || offset > fs.fstatSync(fd).size - 6) return null;
    const pe = Buffer.alloc(6);
    if (fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length) return null;
    return pe.readUInt32LE(0) === 0x4550 ? pe.readUInt16LE(4) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Require a native PE machine; ARM64EC/ARM64X mixed binaries are not pure ARM64. */
export function isNativeWindowsBinary(filePath: string, arch: string): boolean {
  const machines: Record<string, number> = { arm64: 0xaa64, x64: 0x8664, ia32: 0x14c };
  const expected = machines[arch];
  return expected !== undefined && readWindowsPeMachine(filePath) === expected;
}
