import { describe, expect, test } from "bun:test";

import { parseBearerToken } from "../../../src/server/transport/auth";

describe("parseBearerToken", () => {
  test("extracts the trimmed token from Bearer headers", () => {
    expect(parseBearerToken("Bearer secret-token")).toBe("secret-token");
    expect(parseBearerToken("  bearer   secret-token  ")).toBe("secret-token");
    expect(parseBearerToken("BEARER secret-token")).toBe("secret-token");
  });

  test("fails closed for missing, empty, or non-Bearer credentials", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("   ")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer   ")).toBeNull();
    expect(parseBearerToken("Basic secret-token")).toBeNull();
    expect(parseBearerToken("Token secret-token")).toBeNull();
  });
});
