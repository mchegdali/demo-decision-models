import type { HandledVerdict } from "../agents/classifiers/fast-tool-detector/index.ts";
import type { ReplyLanguage } from "../agents/classifiers/language-detector/index.ts";
import {
  describeWeatherCode,
  fetchWeather,
  geocodePlace,
  type GeocodedPlace,
  type WeatherError,
} from "../tools/weather/index.ts";
import { MESSAGES } from "./messages.ts";

const LOCALES: Readonly<Record<ReplyLanguage, string>> = { fr: "fr-FR", en: "en-US" };

/** "Tokyo, Japan" — the name plus its country, when the API returned one. */
function placeLabel(place: GeocodedPlace): string {
  return place.country ? `${place.name}, ${place.country}` : place.name;
}

/** Explains a failed lookup in `language`, without falling back to a model. */
function describeFailure(language: ReplyLanguage, place: string, error: WeatherError): string {
  const messages = MESSAGES[language];
  if (error._tag === "LocationNotFound") return messages.placeNotFound(place);

  // The request errors' own message already names the place; the template does too, so show
  // only the underlying cause ("fetch failed", "HTTP 503") to avoid saying it twice.
  const reason =
    error._tag === "GeocodingFailed" || error._tag === "ForecastFailed"
      ? error.cause.message
      : error.message;
  return messages.lookupFailed(place, reason);
}

function answerTime(
  language: ReplyLanguage,
  timeZone: string | undefined,
  place: string | undefined,
  now: Date,
): string {
  const locale = LOCALES[language];
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  return MESSAGES[language].time({ place, time, date });
}

async function answerTimeQuestion(
  verdict: HandledVerdict,
  language: ReplyLanguage,
  now: Date,
): Promise<string> {
  // No place named: the machine's own timezone is the sensible reading of "what time is it".
  if (!verdict.location) return answerTime(language, undefined, undefined, now);

  const geocoded = await geocodePlace(verdict.location, language);
  if (geocoded.isErr()) return describeFailure(language, verdict.location, geocoded.error);

  const place = geocoded.value;
  if (!place.timezone) {
    return MESSAGES[language].lookupFailed(verdict.location, "no timezone for this place");
  }
  return answerTime(language, place.timezone, placeLabel(place), now);
}

async function answerWeatherQuestion(
  verdict: HandledVerdict,
  language: ReplyLanguage,
): Promise<string> {
  const messages = MESSAGES[language];
  if (!verdict.location) return messages.askCity();

  const geocoded = await geocodePlace(verdict.location, language);
  if (geocoded.isErr()) return describeFailure(language, verdict.location, geocoded.error);

  const report = await fetchWeather(geocoded.value);
  if (report.isErr()) return describeFailure(language, verdict.location, report.error);

  const { place, current, days } = report.value;
  const label = placeLabel(place);

  // `later` and `earlier` never reach here: the policy defers weather outside today/tomorrow.
  if (verdict.when === "today" || verdict.when === "tomorrow") {
    const day = days[verdict.when === "today" ? 0 : 1];
    if (!day) return messages.lookupFailed(verdict.location, "no forecast data for that day");
    return messages.weatherDay({
      place: label,
      day: verdict.when,
      conditions: describeWeatherCode(day.weatherCode, language),
      minC: day.minC,
      maxC: day.maxC,
    });
  }

  return messages.weatherNow({
    place: label,
    conditions: describeWeatherCode(current.weatherCode, language),
    temperatureC: current.temperatureC,
    apparentTemperatureC: current.apparentTemperatureC,
    windSpeedKmh: current.windSpeedKmh,
  });
}

/**
 * Composes the reply for a prompt the fast-tool detector judged answerable by code alone —
 * templates plus, for time in a named place and for weather, a keyless Open-Meteo lookup. Never
 * calls a language model, and never falls back to one: a failed lookup is reported as text.
 *
 * `now` is a parameter so the time answer can be tested against a fixed instant.
 */
export async function answerFast(
  verdict: HandledVerdict,
  language: ReplyLanguage,
  now: Date = new Date(),
): Promise<string> {
  switch (verdict.intent) {
    case "greeting":
      return MESSAGES[language].greeting();
    case "time":
      return answerTimeQuestion(verdict, language, now);
    case "weather":
      return answerWeatherQuestion(verdict, language);
  }
}
