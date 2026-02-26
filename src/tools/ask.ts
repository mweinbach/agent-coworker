import { Type } from "../pi/types";
import { z } from "zod";

import { toAgentTool } from "../pi/toolAdapter";
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

const askParameters = Type.Object({
  question: Type.Optional(Type.String({ description: "The question to ask" })),
  options: Type.Optional(Type.Array(Type.String(), { description: "Multiple-choice options" })),
  questions: Type.Optional(Type.Array(
    Type.Object({
      question: Type.String({ description: "The complete question to ask the user" }),
      header: Type.Optional(Type.String({ description: "Short label shown in UX" })),
      options: Type.Optional(Type.Array(
        Type.Object({
          label: Type.String({ description: "Option label" }),
          description: Type.Optional(Type.String({ description: "Option description" })),
        }),
        { description: "Structured options for the question" },
      )),
      multiSelect: Type.Optional(Type.Boolean({ description: "Whether multiple options may be selected" })),
    }),
    { description: "Questions to ask the user", minItems: 1, maxItems: 4 },
  )),
});

export function createAskTool(ctx: ToolContext) {
  return toAgentTool({
    name: "ask",
    description:
      "Ask the user a clarifying question. Provide options when possible. Returns the user's answer.",
    parameters: askParameters,
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
