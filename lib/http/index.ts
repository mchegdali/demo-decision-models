export type {
  BadRedirect,
  BlockedHost,
  DnsFailure,
  FetchError,
  InvalidUrl,
  NetworkError,
  ResponseTooLarge,
  TooManyRedirects,
  UnsupportedScheme,
} from "./errors.ts";
export type { FetchSuccess, SafeFetchOptions } from "./safe-fetch.ts";
export { readTextCapped, safeFetch } from "./safe-fetch.ts";
