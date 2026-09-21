import { TaggedError } from "better-result";

/** The SearXNG instance could not be reached at all (down, wrong URL, DNS, timeout, ...). */
export class SearxngUnreachable extends TaggedError("SearxngUnreachable")<{
  baseUrl: string;
  cause: unknown;
  message: string;
}> {
  constructor(args: { baseUrl: string; cause: unknown }) {
    super({
      ...args,
      message: `Could not reach SearXNG at ${args.baseUrl}. Is it running? Try: pnpm searxng:up`,
    });
  }
}

/** SearXNG responded but rejected the request (most commonly a 403 on `format=json`). */
export class SearxngRejected extends TaggedError("SearxngRejected")<{
  baseUrl: string;
  status: number;
  message: string;
}> {
  constructor(args: { baseUrl: string; status: number }) {
    const message =
      args.status === 403
        ? `SearXNG at ${args.baseUrl} returned 403 for the JSON API. Check that ` +
          'search.formats includes "json" in infra/searxng/settings.yml.'
        : `SearXNG at ${args.baseUrl} responded with HTTP ${args.status}.`;
    super({ ...args, message });
  }
}

/** SearXNG's response body was not the JSON shape we expect. */
export class SearxngMalformed extends TaggedError("SearxngMalformed")<{
  baseUrl: string;
  cause: unknown;
  message: string;
}> {
  constructor(args: { baseUrl: string; cause: unknown }) {
    super({ ...args, message: `SearXNG at ${args.baseUrl} returned an unexpected response body.` });
  }
}

/** Every way the SearXNG client can fail. */
export type SearxngError = SearxngUnreachable | SearxngRejected | SearxngMalformed;
