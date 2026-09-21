import { z } from "zod";

export const citationSchema = z.object({
  title: z.string().describe("The title of the cited page."),
  // Plain `z.string()`, not `.url()`: the latter emits JSON Schema `format: "uri"`,
  // which OpenAI's strict structured-output schema validation rejects outright.
  url: z.string().describe("The exact URL that was fetched."),
  quote: z.string().describe("A short, exact quote from the page supporting the answer."),
});

export const docsAnswerSchema = z.object({
  found: z.boolean().describe("Whether the documentation answers the question."),
  answer: z
    .string()
    .describe("The answer, grounded in fetched pages. Empty string when `found` is false."),
  confidence: z.enum(["high", "medium", "low"]),
  citations: z
    .array(citationSchema)
    .describe("Sources backing the answer. Empty when `found` is false."),
  // Nullable, not optional: OpenAI's strict structured-output mode requires every
  // property to appear in `required`, so an absent Zod `.optional()` field is rejected.
  followUp: z
    .string()
    .nullable()
    .describe("When `found` is false: what to search or read next. Null otherwise."),
});

export type DocsAnswer = z.infer<typeof docsAnswerSchema>;
