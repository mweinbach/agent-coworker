import { expect, test } from "bun:test";
import path from "node:path";

test("renders Android and iOS composer policies in an isolated component harness", async () => {
  const fixturePath = path.join(import.meta.dir, "fixtures", "mobile-composer-components.tsx");
  const child = Bun.spawn({
    cmd: [process.execPath, "test", fixturePath],
    cwd: path.resolve(import.meta.dir, ".."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  const output = `${stdout}\n${stderr}`;
  expect(output).toContain("android renders editable first-character policy");
  expect(output).toContain("ios renders editable first-character policy");
});
