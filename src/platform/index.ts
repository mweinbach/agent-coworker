/**
 * The platform abstraction layer. One implementation per platform-sensitive
 * concern; platform branching lives INSIDE these modules. Callers never read
 * process.platform (enforced by test/platform-boundary.test.ts).
 *
 * Usage: `import * as platform from "../platform"` then
 * `platform.paths.isInside(...)`, or import named symbols from a submodule.
 *
 * Semantics worth knowing at the barrel level:
 * - paths.isInside / assertWithinRoots case-fold on win32 ONLY (accept-side;
 *   folding on darwin would widen sandbox scopes on case-sensitive APFS).
 * - paths.crossesProtectedMetadata folds on win32 AND darwin (deny-side;
 *   over-blocking is safe).
 * - paths.samePath folds win32-only; use paths.canonicalKey when you want
 *   dedupe-key semantics (folds win32+darwin).
 * - pathString requires an explicit PathStyle everywhere — no host default.
 */
export * as approval from "./approval";
export * as env from "./env";
export * as exec from "./exec";
export { type DesktopPlatform, hostPlatform, type PlatformId, toDesktopPlatform } from "./host";
export * as pathString from "./pathString";
export * as paths from "./paths";
export * as shell from "./shell";
export * as text from "./text";
