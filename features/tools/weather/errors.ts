import { TaggedError } from "better-result";

/** The geocoding request failed (network, timeout, HTTP error). */
export class GeocodingFailed extends TaggedError("GeocodingFailed")<{
  place: string;
  cause: Error;
  message: string;
}> {
  constructor(args: { place: string; cause: Error }) {
    super({
      ...args,
      message: `Could not look up "${args.place}" on Open-Meteo geocoding: ${args.cause.message}`,
    });
  }
}

/** Geocoding answered, but knows no place by that name. */
export class LocationNotFound extends TaggedError("LocationNotFound")<{
  place: string;
  message: string;
}> {
  constructor(args: { place: string }) {
    super({ ...args, message: `No place named "${args.place}" was found.` });
  }
}

/** The forecast request failed (network, timeout, HTTP error). */
export class ForecastFailed extends TaggedError("ForecastFailed")<{
  place: string;
  cause: Error;
  message: string;
}> {
  constructor(args: { place: string; cause: Error }) {
    super({
      ...args,
      message: `Could not fetch the forecast for "${args.place}" from Open-Meteo: ${args.cause.message}`,
    });
  }
}

/** Open-Meteo answered with a body that is not the JSON shape we expect. */
export class WeatherMalformed extends TaggedError("WeatherMalformed")<{
  endpoint: "geocoding" | "forecast";
  cause: unknown;
  message: string;
}> {
  constructor(args: { endpoint: "geocoding" | "forecast"; cause: unknown }) {
    super({
      ...args,
      message: `Open-Meteo ${args.endpoint} returned an unexpected response body.`,
    });
  }
}

/** Every way the weather client can fail. */
export type WeatherError = GeocodingFailed | LocationNotFound | ForecastFailed | WeatherMalformed;
