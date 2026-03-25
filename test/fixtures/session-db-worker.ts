import fs from "node:fs/promises";

import { SessionDb } from "../../src/server/sessionDb";
import type { SessionSnapshot } from "../../src/shared/sessionSnapshot";

type TelemetryEvent = {
  name: string;
  status: "ok" | "error";
  attributes?: Record<string, string | number | boolean>;
  durationMs?: number;
};

function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeSnapshot(sessionId: string, step: number): SessionSnapshot {
  const ts = isoAt(step);
  return {
    sessionId,
    title: `Worker ${sessionId}`,
    titleSource: "model",
    titleModel: "gpt-5.2",
    provider: "openai",
    model: "gpt-5.2",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: `hello-${step}`,
    createdAt: isoAt(0),
    updatedAt: ts,
    messageCount: step + 1,
    lastEventSeq: step + 1,
    feed: [
      {
        id: `${sessionId}-message-${step}`,
        kind: "message",
        role: "user",
        ts,
        text: `hello-${step}`,
      },
    ],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

const [rootDir, sessionsDir, sessionId, expectedCountRaw, outputPath] = process.argv.slice(2);
const expectedCount = Number(expectedCountRaw ?? "0");

if (!rootDir || !sessionsDir || !sessionId || !Number.isFinite(expectedCount) || expectedCount <= 0 || !outputPath) {
  console.error(JSON.stringify({ error: "usage: <rootDir> <sessionsDir> <sessionId> <expectedCount>" }));
  process.exit(1);
}

const telemetry: TelemetryEvent[] = [];

try {
  await fs.mkdir(sessionsDir, { recursive: true });
  const db = await SessionDb.create({
    paths: { rootDir, sessionsDir },
    emitTelemetry: (name, status, attributes, durationMs) => {
      telemetry.push({ name, status, attributes, durationMs });
    },
  });

  try {
    for (let step = 0; step < 4; step += 1) {
      const snapshot = makeSnapshot(sessionId, step);
      await db.persistSessionMutation({
        sessionId,
        eventType: `worker.step.${step}`,
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: snapshot.title,
          titleSource: snapshot.titleSource,
          titleModel: snapshot.titleModel,
          provider: snapshot.provider,
          model: snapshot.model,
          workingDirectory: "/tmp/shared-workspace",
          outputDirectory: "/tmp/shared-workspace/output",
          enableMcp: step % 2 === 0,
          backupsEnabledOverride: null,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: `hello-${step}` }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionSnapshot(sessionId, snapshot);
    }

    const deadline = Date.now() + 10_000;
    let visibleSessionIds: string[] = [];
    while (Date.now() < deadline) {
      visibleSessionIds = db.listSessions().map((session) => session.sessionId).sort();
      if (visibleSessionIds.length >= expectedCount) {
        break;
      }
      await Bun.sleep(25);
    }

    await fs.writeFile(outputPath, `${JSON.stringify({
      sessionId,
      visibleSessionIds,
      telemetry,
    })}\n`, "utf-8");
  } finally {
    db.close();
  }
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  process.exit(1);
}
