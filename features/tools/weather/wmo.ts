export type WeatherLanguage = "fr" | "en";

interface Label {
  readonly fr: string;
  readonly en: string;
}

/** WMO weather interpretation codes, as returned in Open-Meteo's `weather_code`. */
const WMO_LABELS: Readonly<Record<number, Label>> = {
  0: { fr: "ciel dégagé", en: "clear sky" },
  1: { fr: "plutôt dégagé", en: "mainly clear" },
  2: { fr: "partiellement nuageux", en: "partly cloudy" },
  3: { fr: "couvert", en: "overcast" },
  45: { fr: "brouillard", en: "fog" },
  48: { fr: "brouillard givrant", en: "depositing rime fog" },
  51: { fr: "bruine légère", en: "light drizzle" },
  53: { fr: "bruine modérée", en: "moderate drizzle" },
  55: { fr: "bruine dense", en: "dense drizzle" },
  56: { fr: "bruine verglaçante légère", en: "light freezing drizzle" },
  57: { fr: "bruine verglaçante dense", en: "dense freezing drizzle" },
  61: { fr: "pluie faible", en: "slight rain" },
  63: { fr: "pluie modérée", en: "moderate rain" },
  65: { fr: "pluie forte", en: "heavy rain" },
  66: { fr: "pluie verglaçante légère", en: "light freezing rain" },
  67: { fr: "pluie verglaçante forte", en: "heavy freezing rain" },
  71: { fr: "neige faible", en: "slight snow" },
  73: { fr: "neige modérée", en: "moderate snow" },
  75: { fr: "neige forte", en: "heavy snow" },
  77: { fr: "grains de neige", en: "snow grains" },
  80: { fr: "averses faibles", en: "slight rain showers" },
  81: { fr: "averses modérées", en: "moderate rain showers" },
  82: { fr: "averses violentes", en: "violent rain showers" },
  85: { fr: "averses de neige faibles", en: "slight snow showers" },
  86: { fr: "averses de neige fortes", en: "heavy snow showers" },
  95: { fr: "orage", en: "thunderstorm" },
  96: { fr: "orage avec grêle légère", en: "thunderstorm with slight hail" },
  99: { fr: "orage avec forte grêle", en: "thunderstorm with heavy hail" },
};

/** A short lowercase description of a WMO weather code in `language`. */
export function describeWeatherCode(code: number, language: WeatherLanguage): string {
  const label = WMO_LABELS[code];
  if (label) return label[language];
  return language === "fr" ? "conditions inconnues" : "unknown conditions";
}
