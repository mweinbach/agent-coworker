import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as citationMetadataInternal } from "../../src/server/citationMetadata";
import type { ResearchRecord } from "../../src/server/research/types";
import { SessionDb } from "../../src/server/sessionDb";
import {
  cancelResearchInteractionMock,
  createResearchFileSearchStoreMock,
  createResearchInteractionStreamMock,
  deferred,
  deleteResearchFileSearchStoreMock,
  installFetchStub,
  makeResearchRecord,
  makeTmpCoworkHome,
  ResearchService,
  registerResearchServiceHooks,
  researchRuntimeImpls,
  restoreFetchStub,
  resumeResearchInteractionStreamMock,
  uploadFileToResearchFileSearchStoreMock,
  waitFor,
} from "./research.harness";

describe("research service", () => {
  registerResearchServiceHooks();

  test("scopes research list and get operations to the configured workspace", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-workspace-a",
        workspacePath: "/tmp/workspace-a",
        status: "completed",
      }),
    );
    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-workspace-b",
        workspacePath: "/tmp/workspace-b",
        status: "completed",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      workspacePath: "/tmp/workspace-a",
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const listed = await service.list();

      expect(listed.map((record) => record.id)).toEqual(["research-workspace-a"]);
      expect(await service.get("research-workspace-a")).not.toBeNull();
      expect(await service.get("research-workspace-b")).toBeNull();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("canonicalizes workspace paths when reading research rows", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-workspace-canonical",
        workspacePath: "/tmp/demo/./workspace",
        status: "completed",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      workspacePath: "/tmp/demo/workspace",
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      expect((await service.list()).map((record) => record.id)).toEqual([
        "research-workspace-canonical",
      ]);
      expect(await service.get("research-workspace-canonical")).not.toBeNull();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resolves opaque Google grounding source URLs before persisting research sources", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-1";
    const resolvedUrl = "https://example.com/resolved-report";
    const resolvedTitle = "Resolved report title";

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const host = input instanceof Request ? input.headers.get("host") : null;
      if (
        url.includes("/grounding-api-redirect/source-1") ||
        host === "vertexaisearch.cloud.google.com"
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    researchRuntimeImpls.createResearchInteractionStream = async () =>
      (async function* () {
        yield {
          event_type: "content.start",
          event_id: "evt-1",
          interaction: { id: "interaction-123", status: "running" },
        };
        yield {
          event_type: "content.start",
          event_id: "evt-2",
          content: {
            type: "text_annotation",
            annotations: [
              {
                type: "url_citation",
                url: redirectUrl,
                title: "vertexaisearch.cloud.google.com",
              },
            ],
          },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-3",
          interaction: { id: "interaction-123", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.start({ input: "Find citation metadata." });
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "completed",
      );

      expect(completed?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
        }),
      ]);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resolves stored opaque Google grounding source URLs when reading existing research", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-2";
    const resolvedUrl = "https://example.com/resolved-existing";
    const resolvedTitle = "Resolved existing source";

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/source-2")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-existing",
        status: "completed",
        sources: [
          {
            url: redirectUrl,
            title: "vertexaisearch.cloud.google.com",
            sourceType: "url",
            host: "vertexaisearch.cloud.google.com",
          },
        ],
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.get("research-existing");
      expect(research?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
          host: "example.com",
        }),
      ]);
      expect(sessionDb.getResearch("research-existing")?.sources).toEqual(research?.sources);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resolves stored opaque Google grounding source URLs when listing research", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-list";
    const resolvedUrl = "https://example.com/resolved-list";
    const resolvedTitle = "Resolved listed source";

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/source-list")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-listed",
        status: "completed",
        sources: [
          {
            url: redirectUrl,
            title: "vertexaisearch.cloud.google.com",
            sourceType: "url",
            host: "vertexaisearch.cloud.google.com",
          },
        ],
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.list();
      expect(research.find((record) => record.id === "research-listed")?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
          host: "example.com",
        }),
      ]);
      expect(sessionDb.getResearch("research-listed")?.sources).toEqual(
        research.find((record) => record.id === "research-listed")?.sources,
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });
});
