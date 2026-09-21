import { Result } from "better-result";
import { readTextCapped, safeFetch } from "../../../lib/http/index.ts";
import {
  SearxngMalformed,
  SearxngRejected,
  SearxngUnreachable,
  type SearxngError,
} from "./errors.ts";
import type { SearchResult } from "./types.ts";

interface SearxngResponseItem {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
}

interface SearxngResponse {
  readonly results?: readonly SearxngResponseItem[];
}

export interface SearxngSearchOptions {
  readonly maxResults?: number;
  readonly language?: string;
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_LANGUAGE = "en";

/** Internal marker so a 5xx response can flow through `Result.tryPromise`'s retry. */
class RetryableStatus {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

/**
 * Fetches the SearXNG response, retrying transient failures (network errors, 5xx)
 * with exponential backoff. A 4xx is a configuration problem, not a blip — it is
 * returned immediately, never retried.
 */
async function fetchSearxngResponse(
  baseUrl: string,
  url: string,
): Promise<Result<Response, SearxngError>> {
  return Result.tryPromise(
    {
      try: async ({ signal }) => {
        const fetched = await safeFetch(url, { signal }, { allowPrivateHost: true });
        if (fetched.isErr()) throw fetched.error;
        const { response } = fetched.value;
        if (response.status >= 500) throw new RetryableStatus(response.status);
        return response;
      },
      catch: (cause): SearxngError =>
        cause instanceof RetryableStatus
          ? new SearxngRejected({ baseUrl, status: cause.status })
          : new SearxngUnreachable({ baseUrl, cause }),
    },
    {
      retry: {
        times: 2,
        delayMs: 200,
        backoff: "exponential",
        shouldRetry: (error) =>
          error._tag === "SearxngUnreachable" || error._tag === "SearxngRejected",
      },
    },
  );
}

/** Queries a self-hosted SearXNG instance (open-source metasearch, no API key). */
export async function searchWithSearxng(
  baseUrl: string,
  query: string,
  options: SearxngSearchOptions = {},
): Promise<Result<SearchResult[], SearxngError>> {
  const { maxResults = DEFAULT_MAX_RESULTS, language = DEFAULT_LANGUAGE } = options;
  const endpoint = new URL("/search", baseUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("language", language);
  const url = endpoint.toString();

  return Result.gen(async function* () {
    const response = yield* Result.await(fetchSearxngResponse(baseUrl, url));
    if (!response.ok) {
      return Result.err(new SearxngRejected({ baseUrl, status: response.status }));
    }

    const bodyResult = (await readTextCapped(response, url)).mapError(
      (tooLarge) => new SearxngMalformed({ baseUrl, cause: tooLarge }),
    );
    const body = yield* bodyResult;

    const parsed = yield* Result.try({
      try: () => JSON.parse(body) as SearxngResponse,
      catch: (cause) => new SearxngMalformed({ baseUrl, cause }),
    });

    const results = (parsed.results ?? [])
      .filter((item): item is Required<SearxngResponseItem> => Boolean(item.title && item.url))
      .slice(0, maxResults)
      .map((item) => ({ title: item.title, url: item.url, snippet: (item.content ?? "").trim() }));

    return Result.ok(results);
  });
}
