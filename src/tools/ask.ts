import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";

const nonEmptyQuestionSchema = z.string().trim().min(1).describe("The question to ask");

const askSingleInputSchema = z.object({
  question: nonEmptyQuestionSchema,
  options: z.array(z.string()).optional().describe("Multiple-choice options"),
}).strict();

const askStructuredInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: nonEmptyQuestionSchema.describe("The complete question to ask the user"),
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
}).strict();

export const askInputSchema = z
  .object({
    question: askSingleInputSchema.shape.question.optional(),
    options: askSingleInputSchema.shape.options.optional(),
    questions: askStructuredInputSchema.shape.questions.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const hasSingleAsk = input.question !== undefined;
    const hasStructuredAsk = input.questions !== undefined;

    if (!hasSingleAsk && !hasStructuredAsk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either `question` (single ask) or `questions` (structured ask).",
      });
      return;
    }

    if (hasSingleAsk && hasStructuredAsk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use either `question` or `questions`, not both.",
      });
    }

    if (!hasSingleAsk && input.options !== undefined) {
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
      const parsedInput = askInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new Error(parsedInput.error.issues[0]?.message ?? "ask: invalid input");
      }
      const validated = parsedInput.data;

      if (validated.questions !== undefined) {
        ctx.log(`tool> ask ${JSON.stringify({ questions: validated.questions })}`);
        const answers: Record<string, string> = {};
        for (const q of validated.questions) {
          const options = q.options?.map((option) => option.label);
          const answer = await ctx.askUser(q.question, options);
          answers[q.question] = answer;
        }
        const result = { questions: validated.questions, answers };
        ctx.log(`tool< ask ${JSON.stringify(result)}`);
        return result;
      }

      if (validated.question === undefined) {
        throw new Error("ask: missing `question` for single-question mode");
      }
      const question = validated.question;
      ctx.log(`tool> ask ${JSON.stringify({ question, options: validated.options })}`);
      const answer = await ctx.askUser(question, validated.options);
      ctx.log(`tool< ask ${JSON.stringify({ answer })}`);
      return answer;
    },
  });
}
