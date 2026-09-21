import { Result } from "better-result";
import { z } from "zod";
import { readTextCapped, safeFetch } from "../../../lib/http/index.ts";
import {
  ForecastFailed,
  GeocodingFailed,
  LocationNotFound,
  WeatherMalformed,
  type WeatherError,
} from "./errors.ts";
import type { WeatherLanguage } from "./wmo.ts";

/** Open-Meteo is free without an API key for non-commercial use. */
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** Today and tomorrow — the most a fast answer promises. */
const FORECAST_DAYS = 2;

export interface GeocodedPlace {
  readonly name: string;
  readonly country: string | undefined;
  /** First-level administrative area (state, region), when the API returns one. */
  readonly region: string | undefined;
  readonly latitude: number;
  readonly longitude: number;
  /** IANA timezone id, e.g. `Asia/Tokyo`. */
  readonly timezone: string | undefined;
}

export interface CurrentWeather {
  /** Local observation time at the place, ISO 8601 without offset. */
  readonly time: string;
  readonly temperatureC: number;
  readonly apparentTemperatureC: number;
  readonly weatherCode: number;
  readonly windSpeedKmh: number;
}

export interface DayForecast {
  /** Local calendar date at the place, `YYYY-MM-DD`. */
  readonly date: string;
  readonly weatherCode: number;
  readonly minC: number;
  readonly maxC: number;
}

export interface WeatherReport {
  readonly place: GeocodedPlace;
  /** IANA timezone the report's local times are expressed in. */
  readonly timezone: string;
  readonly current: CurrentWeather;
  /** Index 0 is today at the place, index 1 is tomorrow. */
  readonly days: readonly DayForecast[];
}

const geocodingSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        admin1: z.string().optional(),
        timezone: z.string().optional(),
      }),
    )
    .optional(),
});

const forecastSchema = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
  }),
});

/** Internal marker so a 5xx response can flow through `Result.tryPromise`'s retry. */
class RetryableStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Network errors and 5xx are blips worth retrying; a blocked host or a 4xx is not. */
function isTransient(error: Error): boolean {
  return error instanceof RetryableStatus || ("_tag" in error && error._tag === "NetworkError");
}

async function fetchResponse(url: string): Promise<Result<Response, Error>> {
  return Result.tryPromise(
    {
      try: async ({ signal }) => {
        const fetched = await safeFetch(url, { signal });
        if (fetched.isErr()) throw fetched.error;
        const { response } = fetched.value;
        if (response.status >= 500) throw new RetryableStatus(response.status);
        return response;
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    },
    { retry: { times: 1, delayMs: 200, backoff: "exponential", shouldRetry: isTransient } },
  );
}

/** Pulls Open-Meteo's `{ error: true, reason }` explanation out of a failed response body. */
function failureReason(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
      return typeof parsed.reason === "string" ? parsed.reason : undefined;
    }
  } catch {
    // Not JSON: the status code alone will have to do.
  }
  return undefined;
}

/** GETs `url` and parses the body as JSON, with retries, a size cap, and the SSRF guard. */
async function getJson(url: string): Promise<Result<unknown, Error>> {
  return Result.gen(async function* () {
    const response = yield* Result.await(fetchResponse(url));
    const body = yield* await readTextCapped(response, url);

    if (!response.ok) {
      const reason = failureReason(body);
      return Result.err(new Error(`HTTP ${response.status}${reason ? `: ${reason}` : ""}`));
    }

    return Result.try({
      try: (): unknown => JSON.parse(body),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
  });
}

/** Resolves a place name to coordinates and a timezone. Results are localized to `language`. */
export async function geocodePlace(
  name: string,
  language: WeatherLanguage,
): Promise<Result<GeocodedPlace, WeatherError>> {
  const url = new URL(GEOCODING_URL);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", language);
  url.searchParams.set("format", "json");

  const json = (await getJson(url.toString())).mapError(
    (cause) => new GeocodingFailed({ place: name, cause }),
  );

  return json.andThen((payload): Result<GeocodedPlace, LocationNotFound | WeatherMalformed> => {
    const parsed = geocodingSchema.safeParse(payload);
    if (!parsed.success) {
      return Result.err(new WeatherMalformed({ endpoint: "geocoding", cause: parsed.error }));
    }

    // Open-Meteo omits `results` entirely when nothing matches.
    const first = parsed.data.results?.[0];
    if (!first) return Result.err(new LocationNotFound({ place: name }));

    return Result.ok({
      name: first.name,
      country: first.country,
      region: first.admin1,
      latitude: first.latitude,
      longitude: first.longitude,
      timezone: first.timezone,
    });
  });
}

/** Fetches the current conditions and a two-day forecast for `place`, in its own timezone. */
export async function fetchWeather(
  place: GeocodedPlace,
): Promise<Result<WeatherReport, WeatherError>> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
  );
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", String(FORECAST_DAYS));

  const json = (await getJson(url.toString())).mapError(
    (cause) => new ForecastFailed({ place: place.name, cause }),
  );

  return json.andThen((payload): Result<WeatherReport, WeatherMalformed> => {
    const parsed = forecastSchema.safeParse(payload);
    if (!parsed.success) {
      return Result.err(new WeatherMalformed({ endpoint: "forecast", cause: parsed.error }));
    }

    const { timezone, current, daily } = parsed.data;
    const dayCount = Math.min(
      daily.time.length,
      daily.weather_code.length,
      daily.temperature_2m_max.length,
      daily.temperature_2m_min.length,
    );
    const days: DayForecast[] = [];
    for (let index = 0; index < dayCount; index++) {
      days.push({
        date: daily.time[index]!,
        weatherCode: daily.weather_code[index]!,
        maxC: daily.temperature_2m_max[index]!,
        minC: daily.temperature_2m_min[index]!,
      });
    }

    return Result.ok({
      place,
      timezone,
      current: {
        time: current.time,
        temperatureC: current.temperature_2m,
        apparentTemperatureC: current.apparent_temperature,
        weatherCode: current.weather_code,
        windSpeedKmh: current.wind_speed_10m,
      },
      days,
    });
  });
}
