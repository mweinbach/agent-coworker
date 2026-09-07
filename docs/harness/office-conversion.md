# Office conversion qualification

## Direction

Keep the existing Office authoring libraries and Poppler. Replace the problematic
native macOS LibreOffice application with a genuinely headless engine only after
conversion, isolation, fidelity, and redistribution checks pass. Do not weaken the
sandbox or silently substitute a separately generated PDF for an Office render.

The current candidate is `@matbee/libreoffice-converter@2.7.2`, a LibreOffice-WASM
package. It removes Cocoa/AppKit from the conversion path, not LibreOffice's layout
engine. It is a qualification candidate, **not the production runtime default**.

## Local evidence

On macOS 27 ARM64 with Node 24.14, the candidate converted synthetic DOCX, PPTX, and
XLSX inputs under real Seatbelt enforcement with networking disabled:

| Fixture | Validated result |
| --- | --- |
| DOCX with table, image, header/footer, page break | Two-page PDF and two nonblank PNGs |
| PPTX with two text/image slides | Two-page PDF and two nonblank PNGs |
| XLSX with formula and chart | One-page PDF and nonblank PNG; formula recalculated to 360 |

The supervised run completed in approximately 1.75 seconds, including initialization,
and sampled aggregate peak RSS was approximately 1.58 GiB. Synthetic denied-read,
denied-write, and localhost-network probes failed with `EPERM`. Extracted package
files remained unchanged. These results establish basic functionality, not full
Office layout or typography parity.

## Isolation and lifecycle

Run the converter in a disposable, supervised Node process, never in the harness
process. Its loader patches filesystem APIs, and version 2.7.2 leaves referenced
timers after `destroy()`. The qualification CLI awaits output writes and destruction,
then explicitly exits; the supervisor retains timeout and descendant-cleanup
responsibility. No package files are patched to conceal this behavior.

Acquire dependencies during setup only. Conversion uses local assets, a clean
environment, isolated HOME/temp paths, explicit scratch writes, and the enforcing
OS backend. A missing backend is a failure, not a successful skipped conversion.

## Repeatable qualification

`.github/workflows/office-conversion-qualification.yml` runs native macOS ARM64,
Linux x64, and Linux ARM64 qualification. It does not publish a runtime. Setup
uses Node 24, system Poppler, and checksum-pinned test packages without lifecycle
scripts. Linux also requires bubblewrap, system Python/ctypes, and usable user
namespaces.

```sh
export OFFICE_WASM_TEMP_DIR="$RUNNER_TEMP"
export OFFICE_WASM_ARTIFACT_DIR="$RUNNER_TEMP/office-wasm-evidence"
bun --no-env-file scripts/officeWasmQualification.ts setup
bun --no-env-file scripts/officeWasmQualification.ts qualify
```

The artifact directory must be new. Evidence includes the synthetic PDFs/PNGs,
page/text checks, package-integrity checks, resource samples, and denial probes.
Qualification further restricts reads so the converter cannot inspect unrelated
runner-home files. Ordinary unit tests do not download packages or launch Office.
Windows qualification is explicitly unsupported until native resource supervision
is implemented and tested; this is separate from Windows sandbox enforcement CI.

### Native GitHub evidence

[Run 34066812060](https://github.com/mweinbach/agent-coworker/actions/runs/34066812060)
passed on macOS ARM64, Linux x64, and Linux ARM64. Each produced the expected
2/2/1-page PDFs, five nonblank PNGs, and recalculated XLSX value `360`; all 701
package files remained unchanged. Write and network probes were denied on every
runner. Linux also verified denial of a synthetic file in the real runner home.

Initialization and conversion totaled approximately 4.1 seconds on macOS ARM64
and 3.6 seconds on Linux ARM64. Linux x64 took approximately 78 seconds, including
a 75.5-second first DOCX conversion. Investigate that cold-conversion outlier
before setting production latency expectations.

## Production blockers

- The npm package declares MPL-2.0 but omits standalone license/notice files.
  Resolve corresponding-source and bundled font/license materials before shipping.
- Published PDF metadata identifies LibreOfficeDev 24.8.8.0.0, older than the
  native 26.2.3.2 package. Review representative imported-document render diffs
  and licensed font coverage before promising equivalent fidelity.
- npm attestation subject digests matched the downloaded archive; attestation
  signatures and the corresponding WASM build provenance still need verification.
- Resolve or explicitly own the converter's timer/worker lifecycle and memory
  costs before including it in a signed unified runtime.

The existing signed runtime pin is unchanged. A production cutover also requires
the runtime producer and independently updated workspace skills to agree on the
managed converter entrypoint. No host-soffice or cloud-service fallback is added.

## Source identity

- [Candidate source](https://github.com/matbeedotcom/libreoffice-document-converter)
- [Published package metadata](https://registry.npmjs.org/@matbee/libreoffice-converter/2.7.2)
- Package SHA-256: `14d670936fe220ee49becbfd40bf233ceabb94981fa9987fccde345449ee2c3a`
- Package `gitHead`: `b72a3d584bc28c5111afafcf25def7a24fb5fcb0`
- Published: 2026-07-21. Evaluated: 2026-09-06.
