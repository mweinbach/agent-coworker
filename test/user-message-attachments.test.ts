import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importUserMessageAttachments } from "../src/server/session/userMessageAttachments";
import type { AgentConfig } from "../src/types";

function makeConfig(
  workingDirectory: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    preferredChildModel: "gpt-5.2",
    workingDirectory,
    outputDirectory: path.join(workingDirectory, "output"),
    uploadsDirectory: path.join(workingDirectory, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(workingDirectory, ".agent-project"),
    userAgentDir: path.join(workingDirectory, ".agent"),
    builtInDir: workingDirectory,
    builtInConfigDir: path.join(workingDirectory, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

describe("importUserMessageAttachments", () => {
  test("imports image attachments into the workspace and builds multimodal user content", async () => {
    const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "message-attachments-image-"));
    const imageBase64 = Buffer.from("image-bytes").toString("base64");

    const imported = await importUserMessageAttachments({
      config: makeConfig(workingDirectory),
      text: "Describe this image.",
      attachments: [
        {
          filename: "photo.png",
          mimeType: "image/png",
          contentBase64: imageBase64,
        },
      ],
    });

    expect(imported.attachments).toHaveLength(1);
    expect(imported.attachments[0]).toMatchObject({
      filename: "photo.png",
      mimeType: "image/png",
      kind: "image",
      path: path.join(workingDirectory, "photo.png"),
    });
    expect(await fs.readFile(path.join(workingDirectory, "photo.png"), "utf8")).toBe("image-bytes");
    expect(imported.content).toEqual([
      { type: "text", text: "Describe this image." },
      {
        type: "text",
        text: `Imported attachment files are now available in the workspace at these paths:\n- ${path.join(workingDirectory, "photo.png")} (image/png)`,
      },
      {
        type: "image",
        data: imageBase64,
        mimeType: "image/png",
      },
    ]);
    expect(imported.titleText).toBe("Describe this image.");
  });

  test("imports Gemini-native audio and PDF attachments", async () => {
    const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "message-attachments-google-"));

    const imported = await importUserMessageAttachments({
      config: makeConfig(workingDirectory, {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      }),
      text: "",
      attachments: [
        {
          filename: "voice.wav",
          mimeType: "audio/wav",
          contentBase64: Buffer.from("audio").toString("base64"),
        },
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          contentBase64: Buffer.from("pdf").toString("base64"),
        },
      ],
    });

    expect(imported.attachments.map((attachment) => attachment.kind)).toEqual(["audio", "document"]);
    expect(imported.content).toEqual([
      {
        type: "text",
        text: [
          "Imported attachment files are now available in the workspace at these paths:",
          `- ${path.join(workingDirectory, "voice.wav")} (audio/wav)`,
          `- ${path.join(workingDirectory, "report.pdf")} (application/pdf)`,
        ].join("\n"),
      },
      {
        type: "audio",
        data: Buffer.from("audio").toString("base64"),
        mimeType: "audio/wav",
      },
      {
        type: "document",
        data: Buffer.from("pdf").toString("base64"),
        mimeType: "application/pdf",
      },
    ]);
    expect(imported.titleText).toBe("Attachments: voice.wav, report.pdf");
  });

  test("rejects unsupported attachment types for the current model", async () => {
    const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "message-attachments-reject-"));

    await expect(importUserMessageAttachments({
      config: makeConfig(workingDirectory),
      text: "",
      attachments: [
        {
          filename: "voice.wav",
          mimeType: "audio/wav",
          contentBase64: Buffer.from("audio").toString("base64"),
        },
      ],
    })).rejects.toMatchObject({
      message: expect.stringContaining("does not accept audio/wav attachments"),
      code: "validation_failed",
      source: "session",
    });
  });

  test("avoids overwriting existing workspace files by generating unique names", async () => {
    const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "message-attachments-collision-"));
    await fs.writeFile(path.join(workingDirectory, "photo.png"), "existing");

    const imported = await importUserMessageAttachments({
      config: makeConfig(workingDirectory),
      text: "",
      attachments: [
        {
          filename: "photo.png",
          mimeType: "image/png",
          contentBase64: Buffer.from("new-image").toString("base64"),
        },
      ],
    });

    expect(imported.attachments[0]?.filename).toBe("photo-2.png");
    expect(await fs.readFile(path.join(workingDirectory, "photo.png"), "utf8")).toBe("existing");
    expect(await fs.readFile(path.join(workingDirectory, "photo-2.png"), "utf8")).toBe("new-image");
  });
});
