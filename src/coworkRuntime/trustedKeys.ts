import type { TrustedRuntimeKeys } from "./integrity";

/**
 * Cowork runtime release signing roots. Private keys live only in the
 * cowork-runtime release environment and are never accepted from process env.
 */
export const TRUSTED_COWORK_RUNTIME_KEYS: TrustedRuntimeKeys = Object.freeze({
  "cowork-runtime-release-1": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0qoRsFDknvXPqHt2sOibJTPThM7rh/1UyU8g9L+fwIw=
-----END PUBLIC KEY-----
`,
});
