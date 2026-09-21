import { tool } from "ai";
import { Result, TaggedError } from "better-result";
import { z } from "zod";
import {
  type FetchError,
  type FetchSuccess,
  readTextCapped,
  safeFetch,
} from "../../../lib/http/index.ts";
import { type FetchedPage, pageCache } from "./cache.ts";
import { htmlToMarkdown } from "./html-to-markdown.ts";

const DEFAULT_MAX_CHARS = 12_000;

/** The server responded, but not with a 2xx. */
class HttpError extends TaggedError("HttpError")<{
  url: string;
  status: number;
  message: string;
}> {
  constructor(args: { url: string; status: number }) {
    super({ ...args, message: `Server responded with ${args.status}.` });
  }
}

type PageFetchError = FetchError | HttpError;

/** Ask servers for Markdown/plain text first — skips the HTML→Markdown round-trip. */
const TEXT_ACCEPT_INIT: RequestInit = {
  headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
};

function looksLikePlainText(url: string): boolean {
  const { pathname } = new URL(url);
  return (
    /\.(md|mdx|markdown|txt)$/i.test(pathname) ||
    url.endsWith("llms.txt") ||
    url.endsWith("llms-full.txt")
  );
}

function isTextResponse(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.startsWith("text/") || type.includes("markdown");
}

/** GitHub's HTML blob view is unusable noise; the raw file is exactly what we want. */
function rewriteGithubBlobUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") return url;
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(parsed.pathname);
  if (!match) return url;
  const [, owner, repo, ref, path] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

function deriveTitle(markdown: string, finalUrl: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  if (heading?.[1]) return heading[1].trim();
  const segments = new URL(finalUrl).pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? finalUrl;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** `safeFetch` plus turning a non-2xx status into a typed error. */
async function fetchOk(
  url: string,
  init: RequestInit = {},
): Promise<Result<FetchSuccess, PageFetchError>> {
  const fetched = await safeFetch(url, init);
  if (fetched.isErr()) return fetched;
  if (!fetched.value.response.ok) {
    return Result.err(new HttpError({ url, status: fetched.value.response.status }));
  }
  return fetched;
}

/** Tries the doc-site convention of serving raw Markdown at `<page>.md`/`<page>.mdx` (Mintlify et al.). */
async function tryMarkdownVariant(
  url: string,
): Promise<Result<{ finalUrl: string; text: string }, "not_found">> {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith(".md")) return Result.err("not_found");
  const base = parsed.pathname.replace(/\/$/, "");

  for (const ext of [".md", ".mdx"]) {
    const candidate = new URL(parsed);
    candidate.pathname = `${base}${ext}`;

    const fetched = await fetchOk(candidate.toString(), TEXT_ACCEPT_INIT);
    if (fetched.isErr() || !isTextResponse(fetched.value.response)) continue;

    const body = await readTextCapped(fetched.value.response, fetched.value.finalUrl);
    if (body.isErr()) continue;

    return Result.ok({ finalUrl: fetched.value.finalUrl, text: body.value });
  }
  return Result.err("not_found");
}

function buildPage(
  url: string,
  finalUrl: string,
  title: string,
  markdown: string,
  maxChars: number,
): FetchedPage {
  const { text, truncated } = truncate(markdown.trim(), maxChars);
  const page = { url, finalUrl, title, markdown: text, truncated };
  pageCache.set(url, page);
  return page;
}

/**
 * Resolution order: cache hit (checked by the caller) → a URL that already looks
 * like plain text/Markdown → the `<page>.md`/`<page>.mdx` convention → negotiated
 * fetch, using the raw body when the server actually returns text/Markdown, and
 * falling back to Readability + Turndown only for real HTML.
 */
async function resolvePage(
  url: string,
  maxChars: number,
): Promise<Result<FetchedPage, PageFetchError>> {
  const effectiveUrl = rewriteGithubBlobUrl(url);

  return Result.gen(async function* () {
    if (looksLikePlainText(effectiveUrl)) {
      const fetched = yield* Result.await(fetchOk(effectiveUrl, TEXT_ACCEPT_INIT));
      const body = yield* Result.await(readTextCapped(fetched.response, fetched.finalUrl));
      return Result.ok(
        buildPage(url, fetched.finalUrl, deriveTitle(body, fetched.finalUrl), body, maxChars),
      );
    }

    const markdownVariant = await tryMarkdownVariant(effectiveUrl);
    if (markdownVariant.isOk()) {
      const { finalUrl, text } = markdownVariant.value;
      return Result.ok(buildPage(url, finalUrl, deriveTitle(text, finalUrl), text, maxChars));
    }

    const fetched = yield* Result.await(fetchOk(effectiveUrl, TEXT_ACCEPT_INIT));
    if (isTextResponse(fetched.response)) {
      const body = yield* Result.await(readTextCapped(fetched.response, fetched.finalUrl));
      return Result.ok(
        buildPage(url, fetched.finalUrl, deriveTitle(body, fetched.finalUrl), body, maxChars),
      );
    }

    const html = yield* Result.await(readTextCapped(fetched.response, fetched.finalUrl));
    const converted = htmlToMarkdown(html, fetched.finalUrl);
    return Result.ok(
      buildPage(url, fetched.finalUrl, converted.title, converted.markdown, maxChars),
    );
  });
}

export interface FetchPageOptions {
  /** Overrides the tool description — use this to steer a specific agent's phrasing. */
  readonly description?: string;
  /** Default cap on returned Markdown length; the model may still override per-call. */
  readonly maxChars?: number;
}

const DEFAULT_DESCRIPTION =
  "Fetch one page and return it as clean Markdown (navigation, ads, and boilerplate " +
  "stripped). Costs real tokens and time — search first, and only fetch pages that " +
  "look canonical. Never fetch the same URL twice; a truncated page means you should " +
  "search for the specific section instead of re-fetching.";

type FetchPageOutput = FetchedPage | { error: string; hint: string };

/** Checks the cache, resolves the page, and shapes the result into plain JSON. */
async function fetchPageOutput(url: string, maxChars: number): Promise<FetchPageOutput> {
  const cached = pageCache.get(url);
  if (cached) return cached;

  const result = await resolvePage(url, maxChars);
  return Result.match(result, {
    ok: (page): FetchPageOutput => page,
    err: (error): FetchPageOutput => ({ error: error._tag, hint: error.message }),
  });
}

/** Builds a page-fetch tool. Reusable across agents: pass a `description` to steer it. */
export function createFetchPageTool(options: FetchPageOptions = {}) {
  const defaultMaxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  return tool({
    description: options.description ?? DEFAULT_DESCRIPTION,
    inputSchema: z.object({
      url: z.string().url().describe("The exact page URL to fetch."),
      maxChars: z.number().int().positive().max(40_000).optional(),
    }),
    execute: async ({ url, maxChars = defaultMaxChars }) => fetchPageOutput(url, maxChars),
  });
}

/** Ready-to-use page-fetch tool with the generic description and default settings. */
export const fetchPage = createFetchPageTool();

export type { FetchedPage } from "./cache.ts";
