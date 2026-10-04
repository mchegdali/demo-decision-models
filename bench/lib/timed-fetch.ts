/** One HTTP round trip to /v1/systemone, as seen by the client. */
export interface Call {
  readonly ms: number;
  readonly status: number;
  /** `usage.input_tokens` from the response, when the server reports it. */
  readonly inputTokens: number | undefined;
  readonly questions: number;
}

/**
 * A `fetch` that times every request and records it into whichever list `track` is currently
 * collecting into. Only the network round trip is timed — not SDK validation — so the number is
 * what any client of the server would see. Cases run sequentially, so one active list suffices.
 */
export function createTimedFetch(): {
  readonly fetch: typeof globalThis.fetch;
  track<T>(run: () => Promise<T>): Promise<{ value: T | undefined; error: unknown; calls: Call[] }>;
} {
  let active: Call[] | undefined;

  const timedFetch: typeof globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    const questions = body
      ? Object.keys((JSON.parse(body) as { questions?: object }).questions ?? {}).length
      : 0;
    const started = performance.now();
    const response = await globalThis.fetch(input, init);
    const text = await response.text();
    const ms = performance.now() - started;

    let inputTokens: number | undefined;
    try {
      const usage = (JSON.parse(text) as { usage?: { input_tokens?: unknown } }).usage;
      inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
    } catch {
      inputTokens = undefined;
    }
    active?.push({ ms, status: response.status, inputTokens, questions });
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    fetch: timedFetch,
    async track(run) {
      const calls: Call[] = [];
      active = calls;
      try {
        return { value: await run(), error: undefined, calls };
      } catch (error) {
        return { value: undefined, error, calls };
      } finally {
        active = undefined;
      }
    },
  };
}
