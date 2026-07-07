import { z } from "zod";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function requireThreadControl(ctx: ToolContext) {
  if (!ctx.threadControl) {
    throw new Error("Thread management is unavailable outside an eligible root session.");
  }
  return ctx.threadControl;
}

const hostIdSchema = z.string().trim().min(1).optional();
const threadIdSchema = z.string().trim().min(1);
const promptSchema = z.string().trim().min(1).max(100_000);
const modelSchema = z.string().trim().min(1).optional();
const thinkingSchema = z.string().trim().min(1).optional();

const createThreadTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("project"),
      projectId: z.string().trim().min(1),
      environment: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("local") }).strict(),
          z
            .object({
              type: z.literal("worktree"),
              startingState: z.unknown().optional(),
            })
            .strict(),
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("projectless"),
      directoryName: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

export function createThreadManagementTools(ctx: ToolContext): Record<string, unknown> {
  return {
    list_projects: defineTool({
      description:
        "List local Cowork project workspaces that can be used as create_thread project targets.",
      inputSchema: z.object({}).strict(),
      execute: async () => await requireThreadControl(ctx).listProjects(),
    }),

    list_threads: defineTool({
      description:
        "List recent local Cowork threads across known projects and managed one-off chats. Archived threads are hidden unless matched by query; pinned threads sort first.",
      inputSchema: z
        .object({
          hostId: hostIdSchema,
          limit: z.number().int().positive().max(200).optional(),
          query: z.string().trim().min(1).optional(),
        })
        .strict(),
      execute: async (input: { hostId?: string; limit?: number; query?: string }) => {
        ctx.log(`tool> list_threads ${JSON.stringify(input)}`);
        const result = await requireThreadControl(ctx).listThreads(input);
        ctx.log(
          `tool< list_threads ${JSON.stringify({ count: result.threads.length, total: result.total })}`,
        );
        return result;
      },
    }),

    read_thread: defineTool({
      description:
        "Read a compact, paginated transcript for a Cowork thread without subscribing to live updates. Tool outputs are omitted unless includeOutputs is true.",
      inputSchema: z
        .object({
          threadId: threadIdSchema,
          hostId: hostIdSchema,
          cursor: z.string().trim().min(1).optional(),
          includeOutputs: z.boolean().optional(),
          maxOutputCharsPerItem: z.number().int().positive().max(20_000).optional(),
          turnLimit: z.number().int().positive().max(50).optional(),
        })
        .strict(),
      execute: async (input: {
        threadId: string;
        hostId?: string;
        cursor?: string;
        includeOutputs?: boolean;
        maxOutputCharsPerItem?: number;
        turnLimit?: number;
      }) => {
        ctx.log(
          `tool> read_thread ${JSON.stringify({
            threadId: input.threadId,
            cursor: input.cursor,
            includeOutputs: input.includeOutputs === true,
            turnLimit: input.turnLimit,
          })}`,
        );
        const result = await requireThreadControl(ctx).readThread(input);
        ctx.log(
          `tool< read_thread ${JSON.stringify({
            threadId: result.thread.threadId,
            turns: result.turns.length,
            hasNextCursor: !!result.nextCursor,
          })}`,
        );
        return result;
      },
    }),

    create_thread: defineTool({
      description:
        "Create a new Cowork thread in a known project or managed projectless chat, start the prompt in the background, and return the new thread summary.",
      inputSchema: z
        .object({
          hostId: hostIdSchema,
          prompt: promptSchema,
          target: createThreadTargetSchema,
          model: modelSchema,
          thinking: thinkingSchema,
        })
        .strict(),
      execute: async (input: {
        hostId?: string;
        prompt: string;
        target: z.infer<typeof createThreadTargetSchema>;
        model?: string;
        thinking?: string;
      }) => {
        ctx.log(
          `tool> create_thread ${JSON.stringify({
            target: input.target,
            model: input.model,
            thinking: input.thinking,
          })}`,
        );
        await ctx.assertCanMutate?.("create_thread");
        const result = await requireThreadControl(ctx).createThread(input);
        ctx.log(`tool< create_thread ${JSON.stringify({ threadId: result.thread.threadId })}`);
        return result;
      },
    }),

    send_message_to_thread: defineTool({
      description:
        "Send a follow-up user message to an idle Cowork thread. Busy threads return queued=false/busy=true rather than being steered.",
      inputSchema: z
        .object({
          threadId: threadIdSchema,
          hostId: hostIdSchema,
          prompt: promptSchema,
          model: modelSchema,
          thinking: thinkingSchema,
        })
        .strict(),
      execute: async (input: {
        threadId: string;
        hostId?: string;
        prompt: string;
        model?: string;
        thinking?: string;
      }) => {
        ctx.log(
          `tool> send_message_to_thread ${JSON.stringify({
            threadId: input.threadId,
            model: input.model,
            thinking: input.thinking,
          })}`,
        );
        await ctx.assertCanMutate?.("send_message_to_thread");
        const result = await requireThreadControl(ctx).sendMessage(input);
        ctx.log(`tool< send_message_to_thread ${JSON.stringify(result)}`);
        return result;
      },
    }),

    fork_thread: defineTool({
      description: "Fork a Cowork thread. This returns unsupported until Phase 2 ships.",
      inputSchema: z
        .object({
          threadId: threadIdSchema.optional(),
          hostId: hostIdSchema,
          environment: z.unknown().optional(),
        })
        .strict(),
      execute: async (input: { threadId?: string; hostId?: string; environment?: unknown }) =>
        await requireThreadControl(ctx).forkThread(input),
    }),

    handoff_thread: defineTool({
      description: "Start a Cowork thread handoff. This returns unsupported until Phase 3 ships.",
      inputSchema: z
        .object({
          threadId: threadIdSchema,
          hostId: hostIdSchema,
          destinationHostId: z.string().trim().min(1).optional(),
          followUpPrompt: z.string().trim().min(1).optional(),
        })
        .strict(),
      execute: async (input: {
        threadId: string;
        hostId?: string;
        destinationHostId?: string;
        followUpPrompt?: string;
      }) => await requireThreadControl(ctx).handoffThread(input),
    }),

    get_handoff_status: defineTool({
      description: "Read handoff operation status. This returns unsupported until Phase 3 ships.",
      inputSchema: z
        .object({
          operationId: z.string().trim().min(1),
          hostId: hostIdSchema,
          afterRevision: z.number().int().nonnegative().optional(),
          waitMs: z.number().int().nonnegative().max(60_000).optional(),
        })
        .strict(),
      execute: async (input: {
        operationId: string;
        hostId?: string;
        afterRevision?: number;
        waitMs?: number;
      }) => await requireThreadControl(ctx).getHandoffStatus(input),
    }),

    set_thread_title: defineTool({
      description:
        "Set a Cowork thread title. Defaults to the current thread when threadId is omitted.",
      inputSchema: z
        .object({
          threadId: threadIdSchema.optional(),
          hostId: hostIdSchema,
          title: z.string().trim().min(1).max(200),
        })
        .strict(),
      execute: async (input: { threadId?: string; hostId?: string; title: string }) => {
        await ctx.assertCanMutate?.("set_thread_title");
        return await requireThreadControl(ctx).setTitle(input);
      },
    }),

    set_thread_pinned: defineTool({
      description:
        "Pin or unpin a Cowork thread. Defaults to the current thread when threadId is omitted.",
      inputSchema: z
        .object({
          threadId: threadIdSchema.optional(),
          hostId: hostIdSchema,
          pinned: z.boolean(),
        })
        .strict(),
      execute: async (input: { threadId?: string; hostId?: string; pinned: boolean }) => {
        await ctx.assertCanMutate?.("set_thread_pinned");
        return await requireThreadControl(ctx).setPinned(input);
      },
    }),

    set_thread_archived: defineTool({
      description:
        "Archive or restore a Cowork thread. Defaults to the current thread when threadId is omitted.",
      inputSchema: z
        .object({
          threadId: threadIdSchema.optional(),
          hostId: hostIdSchema,
          archived: z.boolean(),
        })
        .strict(),
      execute: async (input: { threadId?: string; hostId?: string; archived: boolean }) => {
        await ctx.assertCanMutate?.("set_thread_archived");
        return await requireThreadControl(ctx).setArchived(input);
      },
    }),
  };
}
