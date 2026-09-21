import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Result } from "better-result";
import {
  BadRedirect,
  BlockedHost,
  DnsFailure,
  type FetchError,
  InvalidUrl,
  NetworkError,
  ResponseTooLarge,
  TooManyRedirects,
  UnsupportedScheme,
} from "./errors.ts";

const USER_AGENT = "test-typesafe-ai/1.0 (+https://github.com/mchegdali)";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FetchSuccess {
  readonly response: Response;
  readonly finalUrl: string;
}

/**
 * Extra behaviour for `safeFetch`. `allowPrivateHost` is only for
 * operator-configured URLs (e.g. a local SearXNG instance) — never set it for
 * a URL an agent supplied, or the SSRF guard below does nothing.
 */
export interface SafeFetchOptions {
  readonly allowPrivateHost?: boolean;
}

function isPrivateIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    if (a === undefined || b === undefined) return true;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")
    );
  }
  // Not an IP literal (a bare hostname) — treated as unresolved, checked via DNS below.
  return false;
}

async function assertPublicHost(hostname: string): Promise<Result<void, BlockedHost | DnsFailure>> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return Result.err(new BlockedHost({ hostname, reason: "local_hostname" }));
  }
  if (isIP(lower) && isPrivateIp(lower)) {
    return Result.err(new BlockedHost({ hostname, reason: "private_ip" }));
  }

  const lookupResult = await Result.tryPromise({
    try: () => lookup(hostname, { all: true }),
    catch: (cause) => new DnsFailure({ hostname, cause }),
  });

  return lookupResult.andThen((records) =>
    records.some((record) => isPrivateIp(record.address))
      ? Result.err(new BlockedHost({ hostname, reason: "resolves_private" }))
      : Result.ok(undefined),
  );
}

/**
 * A fetch with the guards a tool exposed to an agent needs: scheme allow-list,
 * SSRF protection (including DNS-rebinding checks on redirect hops), a timeout,
 * a response-size cap, and a bounded redirect count.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Result<FetchSuccess, FetchError>> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return Result.err(new InvalidUrl({ url: current }));
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return Result.err(new UnsupportedScheme({ url: current, scheme: parsed.protocol }));
    }

    if (!options.allowPrivateHost) {
      const hostCheck = await assertPublicHost(parsed.hostname);
      if (hostCheck.isErr()) return hostCheck;
    }

    const fetchResult = await Result.tryPromise(
      {
        try: ({ signal }) =>
          fetch(parsed, {
            ...init,
            redirect: "manual",
            signal,
            headers: { "User-Agent": USER_AGENT, ...init.headers },
          }),
        catch: (cause) => new NetworkError({ url: current, cause }),
      },
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (fetchResult.isErr()) return fetchResult;
    const response = fetchResult.value;

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return Result.err(new BadRedirect({ url: current }));
      current = new URL(location, parsed).toString();
      continue;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      return Result.err(new ResponseTooLarge({ url: current, limitBytes: MAX_RESPONSE_BYTES }));
    }

    return Result.ok({ response, finalUrl: parsed.toString() });
  }
  return Result.err(new TooManyRedirects({ url, maxRedirects: MAX_REDIRECTS }));
}

/** Reads a response body as text, enforcing the same size cap as `safeFetch`. */
export async function readTextCapped(
  response: Response,
  url: string,
): Promise<Result<string, ResponseTooLarge>> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    return Result.err(new ResponseTooLarge({ url, limitBytes: MAX_RESPONSE_BYTES }));
  }
  return Result.ok(new TextDecoder().decode(buffer));
}
