import { tool } from "ai";
import { Result } from "better-result";
import { z } from "zod";
import { searchWithSearxng } from "./searxng.ts";
import type { SearchResult } from "./types.ts";

const GENERIC_DESCRIPTION =
  "Search the public web. Returns titles, URLs, and short snippets — not full page " +
  "content. Use `site` to narrow results to a single domain once you know it. Prefer " +
  "a narrow, specific query.";

type WebSearchOutput = { results: SearchResult[]; hint?: string } | { error: string; hint: string };

/** Runs the search and shapes the result into plain JSON the model can read. */
async function webSearchOutput(
  baseUrl: string,
  fullQuery: string,
  options: { maxResults?: number; language?: string },
): Promise<WebSearchOutput> {
  const result = await searchWithSearxng(baseUrl, fullQuery, options);
  return Result.match(result, {
    ok: (results): WebSearchOutput =>
      results.length === 0
        ? { results: [], hint: "No results. Try a broader or differently-worded query." }
        : { results },
    err: (error): WebSearchOutput => ({ error: error._tag, hint: error.message }),
  });
}

export interface WebSearchOptions {
  /** Overrides the tool description — use this to steer a specific agent's phrasing. */
  readonly description?: string;
  /** Max results returned. Default 5. */
  readonly maxResults?: number;
  /** SearXNG base URL. Defaults to `SEARXNG_URL`, read lazily, falling back to localhost. */
  readonly baseUrl?: string;
  /** SearXNG result language. Default "en". */
  readonly language?: string;
}

/**
 * Builds a web-search tool backed by a self-hosted SearXNG instance. Reusable across
 * agents: pass a `description` to frame it for a specific one (e.g. docs-only search).
 */
export function createWebSearchTool(options: WebSearchOptions = {}) {
  return tool({
    description: options.description ?? GENERIC_DESCRIPTION,
    inputSchema: z.object({
      query: z.string().min(1).describe("A specific, narrow search query."),
      site: z
        .string()
        .optional()
        .describe("Restrict results to this domain, e.g. 'docs.typesafe.ai'."),
    }),
    execute: async ({ query, site }) => {
      const fullQuery = site ? `site:${site} ${query}` : query;
      const baseUrl = options.baseUrl ?? process.env.SEARXNG_URL ?? "http://localhost:8080";
      return webSearchOutput(baseUrl, fullQuery, {
        maxResults: options.maxResults,
        language: options.language,
      });
    },
  });
}

/** Ready-to-use web-search tool with the generic description and default settings. */
export const webSearch = createWebSearchTool();

export type { SearchResult } from "./types.ts";
