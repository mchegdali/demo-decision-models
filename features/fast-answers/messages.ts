import type { ReplyLanguage } from "../agents/classifiers/language-detector/index.ts";

export interface TimeFacts {
  /** "Tokyo, Japan", or `undefined` for the machine's own timezone. */
  readonly place: string | undefined;
  /** Already formatted, e.g. "14:32". */
  readonly time: string;
  /** Already formatted, e.g. "mardi 21 septembre 2026". */
  readonly date: string;
}

export interface WeatherNowFacts {
  readonly place: string;
  readonly conditions: string;
  readonly temperatureC: number;
  readonly apparentTemperatureC: number;
  readonly windSpeedKmh: number;
}

export interface WeatherDayFacts {
  readonly place: string;
  readonly day: "today" | "tomorrow";
  readonly conditions: string;
  readonly minC: number;
  readonly maxC: number;
}

interface Messages {
  greeting(): string;
  time(facts: TimeFacts): string;
  weatherNow(facts: WeatherNowFacts): string;
  weatherDay(facts: WeatherDayFacts): string;
  askCity(): string;
  /** A named place that geocoding does not know. */
  placeNotFound(place: string): string;
  /** A lookup (geocoding or forecast) that failed for a reason worth showing. */
  lookupFailed(place: string, reason: string): string;
}

const round = Math.round;

const fr: Messages = {
  greeting: () => "Bonjour ! Comment puis-je vous aider ?",
  time: ({ place, time, date }) =>
    place ? `Il est ${time} à ${place} (${date}).` : `Il est ${time} (${date}).`,
  weatherNow: (f) =>
    `Météo à ${f.place} : ${f.conditions}, ${round(f.temperatureC)} °C ` +
    `(ressenti ${round(f.apparentTemperatureC)} °C), vent ${round(f.windSpeedKmh)} km/h.`,
  weatherDay: (f) =>
    `Météo ${f.day === "today" ? "aujourd'hui" : "demain"} à ${f.place} : ${f.conditions}, ` +
    `de ${round(f.minC)} à ${round(f.maxC)} °C.`,
  askCity: () => "Pour quelle ville souhaitez-vous la météo ?",
  placeNotFound: (place) => `Je ne trouve aucun lieu nommé « ${place} ».`,
  lookupFailed: (place, reason) => `Je n'ai pas pu chercher « ${place} » : ${reason}`,
};

const en: Messages = {
  greeting: () => "Hello! How can I help you?",
  time: ({ place, time, date }) =>
    place ? `It is ${time} in ${place} (${date}).` : `It is ${time} (${date}).`,
  weatherNow: (f) =>
    `Weather in ${f.place}: ${f.conditions}, ${round(f.temperatureC)}°C ` +
    `(feels like ${round(f.apparentTemperatureC)}°C), wind ${round(f.windSpeedKmh)} km/h.`,
  weatherDay: (f) =>
    `Weather ${f.day} in ${f.place}: ${f.conditions}, ` + `${round(f.minC)} to ${round(f.maxC)}°C.`,
  askCity: () => "Which city do you want the weather for?",
  placeNotFound: (place) => `I couldn't find a place named "${place}".`,
  lookupFailed: (place, reason) => `I couldn't look up "${place}": ${reason}`,
};

/** Reply templates by language. Plain functions, no model: the whole fast path is code. */
export const MESSAGES: Readonly<Record<ReplyLanguage, Messages>> = { fr, en };
