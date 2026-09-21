import { createOpenAI } from "@ai-sdk/openai";
import { requireEnv } from "../env.ts";

/** Fast, cheap GPT-5.6-series model: good fit for high-volume agentic tool use. */
export const LANGUAGE_MODEL_ID = "gpt-5.6-luna";

/** Configured OpenAI provider, exposed so callers can create sibling models. */
export const openaiProvider = createOpenAI({
  apiKey: requireEnv("OPENAI_API_KEY"),
});

/** The default language model used across the app's agents. */
export const languageModel = openaiProvider(LANGUAGE_MODEL_ID);
