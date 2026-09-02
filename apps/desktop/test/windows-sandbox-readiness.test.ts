import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import {
  readWindowsSandboxReadiness,
  type WindowsSandboxReadiness,
  writeWindowsSandboxReadiness,
} from "../electron/services/windowsSandboxReadiness";

const readiness: Omit<WindowsSandboxReadiness, "schemaVersion" | "updatedAt"> = {
  state: "ready",
  bundleTrusted: true,
  setupRequired: false,
  enforcement: { filesystem: true, network: true, process: true, integrity: true },
  message: "Enforcement probes passed.",
};
const record: WindowsSandboxReadiness = {
  ...readiness,
  schemaVersion: 1,
  updatedAt: "2026-09-01T12:00:00.000Z",
};

let directory: string;
let destination: string;

beforeEach(async () => {
  const scratchRoot = scratchRoots()[0];
  if (!scratchRoot) throw new Error("No platform scratch root is available.");
  directory = await fs.mkdtemp(path.join(scratchRoot, "cowork-readiness-"));
  destination = path.join(directory, "windows-sandbox", "readiness.json");
});

afterEach(async () => {
  mock.restore();
  await fs.rm(directory, { recursive: true, force: true });
});

async function writeRecord(value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(value), "utf8");
}

describe("Windows sandbox readiness persistence", () => {
  test("round-trips a complete readiness snapshot", async () => {
    expect(await readWindowsSandboxReadiness(directory)).toBeNull();

    await writeWindowsSandboxReadiness(directory, readiness);

    expect(await readWindowsSandboxReadiness(directory)).toEqual({
      ...readiness,
      schemaVersion: 1,
      updatedAt: expect.any(String),
    });
  });

  test("publishes concurrent writes without sharing a temporary file", async () => {
    const writeFile = fs.writeFile;
    let stagedWrites = 0;
    let releaseWrites!: () => void;
    const writesStaged = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await writeFile(...args);
      stagedWrites += 1;
      if (stagedWrites === 2) releaseWrites();
      await writesStaged;
    });

    const results = await Promise.allSettled(
      ["first", "second"].map((message) =>
        writeWindowsSandboxReadiness(directory, { ...readiness, message }),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(["first", "second"]).toContain((await readWindowsSandboxReadiness(directory))?.message);
    expect(await fs.readdir(path.dirname(destination))).toEqual(["readiness.json"]);
  });

  test("keeps the previous snapshot readable until replacement is committed", async () => {
    await writeRecord(record);
    const rename = fs.rename;
    let beforeCommit: WindowsSandboxReadiness | null = null;
    spyOn(fs, "rename").mockImplementation(async (...args) => {
      beforeCommit = await readWindowsSandboxReadiness(directory);
      await rename(...args);
    });

    await writeWindowsSandboxReadiness(directory, { ...readiness, message: "Updated probes." });

    expect(beforeCommit).toEqual(record);
    expect(await readWindowsSandboxReadiness(directory)).toMatchObject({
      message: "Updated probes.",
    });
  });

  test("preserves the previous snapshot and removes staging files when replacement fails", async () => {
    await writeRecord(record);
    spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("Readiness replacement failed"), { code: "EIO" }),
    );

    await expect(writeWindowsSandboxReadiness(directory, readiness)).rejects.toThrow(
      "Readiness replacement failed",
    );

    expect(await readWindowsSandboxReadiness(directory)).toEqual(record);
    expect(await fs.readdir(path.dirname(destination))).toEqual(["readiness.json"]);
  });
});

describe("Windows sandbox readiness validation", () => {
  test.each([
    { label: "empty object", enforcement: {} },
    { label: "boolean", enforcement: true },
    { label: "number", enforcement: 1 },
    { label: "array", enforcement: [true, true, true, true] },
    { label: "missing filesystem", enforcement: { network: true, process: true, integrity: true } },
    { label: "missing network", enforcement: { filesystem: true, process: true, integrity: true } },
    { label: "missing process", enforcement: { filesystem: true, network: true, integrity: true } },
    { label: "missing integrity", enforcement: { filesystem: true, network: true, process: true } },
    { label: "non-boolean field", enforcement: { ...record.enforcement, filesystem: "true" } },
    { label: "unknown field", enforcement: { ...record.enforcement, extra: true } },
  ])("rejects $label enforcement", async ({ enforcement }) => {
    await writeRecord({ ...record, enforcement });

    expect(await readWindowsSandboxReadiness(directory)).toBeNull();
  });

  test.each(["", "not-a-date", "2026-09-01", "2026-02-30T12:00:00.000Z", "2026-09-01T12:00:00"])(
    "rejects invalid timestamp %j",
    async (updatedAt) => {
      await writeRecord({ ...record, updatedAt });

      expect(await readWindowsSandboxReadiness(directory)).toBeNull();
    },
  );

  test("accepts a valid timestamp with a UTC offset", async () => {
    const offsetRecord = { ...record, updatedAt: "2026-09-01T08:00:00-04:00" };
    await writeRecord(offsetRecord);

    expect(await readWindowsSandboxReadiness(directory)).toEqual(offsetRecord);
  });

  test.each([
    { label: "null", value: null },
    { label: "array", value: [record] },
    { label: "unknown version", value: { ...record, schemaVersion: 2 } },
    { label: "unknown state", value: { ...record, state: "unknown" } },
    { label: "non-boolean trust", value: { ...record, bundleTrusted: "true" } },
    { label: "non-boolean setup requirement", value: { ...record, setupRequired: 0 } },
    { label: "missing message", value: { ...record, message: null } },
    { label: "unknown field", value: { ...record, extra: "unexpected diagnostic data" } },
  ])("rejects $label readiness record", async ({ value }) => {
    await writeRecord(value);

    expect(await readWindowsSandboxReadiness(directory)).toBeNull();
  });

  test("returns null for malformed JSON", async () => {
    await writeRecord(record);
    await fs.writeFile(destination, "{not-json", "utf8");

    expect(await readWindowsSandboxReadiness(directory)).toBeNull();
  });
});
