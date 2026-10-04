import { describe, expect, test } from "bun:test";
import { parseBearerToken } from "../../../src/server/transport/auth";

describe("parseBearerToken", () => {
  test("extracts the trimmed token from Bearer headers and fails closed otherwise", () => {
    for (const h of ["Bearer secret-token", "  bearer   secret-token  ", "BEARER secret-token"]) {
      expect(parseBearerToken(h)).toBe("secret-token");
    }
    for (const bad of [
      null,
      "",
      "   ",
      "Bearer",
      "Bearer   ",
      "Basic secret-token",
      "Token secret-token",
    ]) {
      expect(parseBearerToken(bad)).toBeNull();
    }
  });
});
