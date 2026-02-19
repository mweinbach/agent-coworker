import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";

const legacyAskInputSchema = z.object({
  question: z.string().describe("The question to ask"),
  options: z.array(z.string()).optional().describe("Multiple-choice options"),
});

const askUserQuestionInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("The complete question to ask the user"),
        header: z.string().optional().describe("Short label shown in UX"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Option label"),
              description: z.string().optional().describe("Option description"),
            })
          )
          .optional()
          .describe("Structured options for the question"),
        multiSelect: z.boolean().optional().describe("Whether multiple options may be selected"),
      })
    )
    .min(1)
    .max(4)
    .describe("Questions to ask the user"),
});

export const askInputSchema = z
  .object({
    question: legacyAskInputSchema.shape.question.optional(),
    options: legacyAskInputSchema.shape.options.optional(),
    questions: askUserQuestionInputSchema.shape.questions.optional(),
  })
  .superRefine((input, ctx) => {
    const hasLegacy = typeof input.question === "string";
    const hasStructured = Array.isArray(input.questions);

    if (!hasLegacy && !hasStructured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either `question` (single ask) or `questions` (structured ask).",
      });
      return;
    }

    if (hasLegacy && hasStructured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use either `question` or `questions`, not both.",
      });
    }

    if (!hasLegacy && input.options !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "`options` is only valid with `question`.",
      });
    }
  });

export function createAskTool(ctx: ToolContext) {
  return tool({
    description:
      "Ask the user a clarifying question. Provide options when possible. Returns the user's answer.",
    inputSchema: askInputSchema,
    execute: async (input) => {
      if (Array.isArray(input.questions)) {
        ctx.log(`tool> ask ${JSON.stringify({ questions: input.questions })}`);
        const answers: Record<string, string> = {};
        for (const q of input.questions) {
          const options = q.options?.map((option) => option.label);
          const answer = await ctx.askUser(q.question, options);
          answers[q.question] = answer;
        }
        const result = { questions: input.questions, answers };
        ctx.log(`tool< ask ${JSON.stringify(result)}`);
        return result;
      }

      if (typeof input.question !== "string" || input.question.length === 0) {
        throw new Error("ask: missing `question` for single-question mode");
      }
      const question = input.question;
      ctx.log(`tool> ask ${JSON.stringify({ question, options: input.options })}`);
      const answer = await ctx.askUser(question, input.options);
      ctx.log(`tool< ask ${JSON.stringify({ answer })}`);
      return answer;
    },
  });
}
