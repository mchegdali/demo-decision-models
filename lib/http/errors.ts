import { TaggedError } from "better-result";

/** `new URL(...)` rejected the string outright. */
export class InvalidUrl extends TaggedError("InvalidUrl")<{
  url: string;
  message: string;
}> {
  constructor(args: { url: string }) {
    super({ ...args, message: `"${args.url}" is not a valid URL.` });
  }
}

/** Anything but `http:`/`https:`. */
export class UnsupportedScheme extends TaggedError("UnsupportedScheme")<{
  url: string;
  scheme: string;
  message: string;
}> {
  constructor(args: { url: string; scheme: string }) {
    super({ ...args, message: "Only http(s) URLs are supported." });
  }
}

/** SSRF guard: localhost, a private/loopback IP literal, or a hostname that resolves to one. */
export class BlockedHost extends TaggedError("BlockedHost")<{
  hostname: string;
  reason: "local_hostname" | "private_ip" | "resolves_private";
  message: string;
}> {
  constructor(args: {
    hostname: string;
    reason: "local_hostname" | "private_ip" | "resolves_private";
  }) {
    const message =
      args.reason === "resolves_private"
        ? `Hostname "${args.hostname}" resolves to a private/loopback IP address.`
        : `Refusing to fetch local/internal hostname "${args.hostname}".`;
    super({ ...args, message });
  }
}

/** `dns.lookup` failed for the hostname. */
export class DnsFailure extends TaggedError("DnsFailure")<{
  hostname: string;
  cause: unknown;
  message: string;
}> {
  constructor(args: { hostname: string; cause: unknown }) {
    super({ ...args, message: `Could not resolve host "${args.hostname}".` });
  }
}

/** The underlying `fetch()` call threw. */
export class NetworkError extends TaggedError("NetworkError")<{
  url: string;
  cause: unknown;
  message: string;
}> {
  constructor(args: { url: string; cause: unknown }) {
    const message = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({ ...args, message });
  }
}

/** A 3xx response carried no `Location` header. */
export class BadRedirect extends TaggedError("BadRedirect")<{
  url: string;
  message: string;
}> {
  constructor(args: { url: string }) {
    super({ ...args, message: "Redirect had no Location header." });
  }
}

/** `Content-Length`, or the body itself, exceeded the size cap. */
export class ResponseTooLarge extends TaggedError("ResponseTooLarge")<{
  url: string;
  limitBytes: number;
  message: string;
}> {
  constructor(args: { url: string; limitBytes: number }) {
    super({ ...args, message: `Response exceeds ${args.limitBytes} bytes.` });
  }
}

/** More redirect hops than the bound allows. */
export class TooManyRedirects extends TaggedError("TooManyRedirects")<{
  url: string;
  maxRedirects: number;
  message: string;
}> {
  constructor(args: { url: string; maxRedirects: number }) {
    super({ ...args, message: `Exceeded ${args.maxRedirects} redirects.` });
  }
}

/** Every way `safeFetch`/`readTextCapped` can fail. */
export type FetchError =
  | InvalidUrl
  | UnsupportedScheme
  | BlockedHost
  | DnsFailure
  | NetworkError
  | BadRedirect
  | ResponseTooLarge
  | TooManyRedirects;
