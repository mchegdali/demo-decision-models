export interface FetchedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly markdown: string;
  readonly truncated: boolean;
}

/** Per-process cache so an agent never pays to fetch the same URL twice. */
export const pageCache = new Map<string, FetchedPage>();
