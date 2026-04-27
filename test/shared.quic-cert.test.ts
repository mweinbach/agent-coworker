import { describe, expect, test } from "bun:test";

import {
  createEphemeralQuicCertificate,
  fingerprintCertificateDerBase64,
} from "../src/shared/quicCert";

describe("quic certificate helpers", () => {
  test("creates a self-signed cert with stable pinning fingerprints", async () => {
    const cert = await createEphemeralQuicCertificate(new Date("2026-01-01T00:00:00Z"), 60_000);

    expect(cert.certPem).toContain("BEGIN CERTIFICATE");
    expect(cert.keyPem).toContain("BEGIN PRIVATE KEY");
    expect(cert.certSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(cert.spkiSha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cert.identityPub.length).toBeGreaterThan(40);
    expect(cert.notAfter).toBe("2026-01-01T00:01:00.000Z");

    expect(fingerprintCertificateDerBase64(cert.certDerBase64)).toEqual({
      certSha256: cert.certSha256,
      spkiSha256: cert.spkiSha256,
    });
  });
});
