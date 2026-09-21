import { createFetchPageTool } from "../../tools/fetch-page/index.ts";
import { createWebSearchTool } from "../../tools/web-search/index.ts";

const DOCS_SEARCH_DESCRIPTION =
  "Search the public web for documentation pages. Returns titles, URLs, and short snippets — " +
  "not full page content. Use `site` to narrow results to a single documentation domain once you " +
  "know it (e.g. 'ai-sdk.dev'). Prefer a narrow query naming the exact product and symbol.";

const DOCS_FETCH_DESCRIPTION =
  "Fetch one documentation page and return it as clean Markdown (navigation, ads, and boilerplate " +
  "stripped). Costs real tokens and time — search first, and only fetch pages that look canonical. " +
  "Never fetch the same URL twice; a truncated page means you should search for the specific section " +
  "instead of re-fetching.";

export const docsExplorerTools = {
  searchDocs: createWebSearchTool({ description: DOCS_SEARCH_DESCRIPTION, maxResults: 5 }),
  fetchPage: createFetchPageTool({ description: DOCS_FETCH_DESCRIPTION }),
};
