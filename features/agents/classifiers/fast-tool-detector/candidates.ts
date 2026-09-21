/** Most candidates handed to the model; more only dilutes the choice. */
export const MAX_LOCATION_CANDIDATES = 6;

/** Longest place name, in words, taken after a preposition ("rio de janeiro" is three). */
const MAX_PLACE_WORDS = 4;

/** Lowercase words that introduce a place in French and English. */
const PLACE_PREPOSITIONS: ReadonlySet<string> = new Set([
  "à",
  "au",
  "aux",
  "en",
  "de",
  "du",
  "pour",
  "dans",
  "in",
  "at",
  "for",
  "near",
  "around",
]);

/** Lowercase words that may sit between two capitalized words of one name ("Rio de Janeiro"). */
const NAME_CONNECTORS: ReadonlySet<string> = new Set([
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "of",
  "on",
  "upon",
  "sur",
  "sous",
  "el",
  "al",
  "del",
  "di",
  "da",
  "van",
  "von",
]);

/**
 * Words that are never (the start of) a place: function words, greetings, question words,
 * and time/weather vocabulary. Also what keeps a capitalized sentence opener ("Quelle",
 * "What's") from being offered as a place. Compared lowercase, with `’` folded to `'`.
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  `
  le la les l un une des du de d au aux à a en dans sur sous pour par avec sans et ou mais donc
  que qui quoi quel quelle quels quelles comment est-ce est est-il sont fait fais fait-il va vont
  être y ne il ils elle elles on je tu nous vous me te se ce cet cette ces mon ma mes ton ta tes
  son sa ses notre votre leur pas plus très bien s'il svp stp plaît dis dites moi donne donnez
  peux peux-tu peut pourrais juste indique indiquez dire bonjour bonsoir salut coucou heure
  heures temps météo meteo température temperature pluie soleil neige aujourd'hui aujourdhui
  demain maintenant actuellement moment actuel actuelle soir matin date jour semaine weekend
  week-end prévisions previsions hier avant-hier après-demain apres-demain prochain prochaine
  dernier dernière derniere

  the an of in at on for to from with without and or but what what's whats which who how is are
  was be it it's its i i'm you your we my tell give please just hello hi hey good morning
  evening afternoon time weather forecast rain sun today tomorrow tonight now currently right
  current day week near around like do does can could would will there here yesterday next
  last this that were
  `
    .trim()
    .split(/\s+/),
);

const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const CAPITALIZED = /^\p{Lu}/u;
const ONLY_SPACE = /^\s+$/;

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function normalize(word: string): string {
  return word.toLowerCase().replaceAll("’", "'");
}

function isStopword(token: Token): boolean {
  return STOPWORDS.has(normalize(token.text));
}

function tokenize(prompt: string): Token[] {
  return [...prompt.matchAll(WORD)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** True when only whitespace separates the two tokens — a comma or a dash breaks a name. */
function adjacent(prompt: string, left: Token, right: Token): boolean {
  return ONLY_SPACE.test(prompt.slice(left.end, right.start));
}

/** The prompt text spanning `tokens`, with leading and trailing stopwords trimmed away. */
function span(prompt: string, tokens: readonly Token[]): string | undefined {
  let from = 0;
  let to = tokens.length - 1;
  while (from <= to && isStopword(tokens[from]!)) from++;
  while (to >= from && isStopword(tokens[to]!)) to--;
  if (from > to) return undefined;
  return prompt.slice(tokens[from]!.start, tokens[to]!.end);
}

/** Runs of capitalized words ("New York", "Rio de Janeiro"), wherever they appear. */
function capitalizedRuns(prompt: string, tokens: readonly Token[]): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    if (!CAPITALIZED.test(tokens[index]!.text)) {
      index++;
      continue;
    }

    let end = index;
    for (;;) {
      const current = tokens[end]!;
      const next = tokens[end + 1];
      const afterNext = tokens[end + 2];
      if (next && adjacent(prompt, current, next) && CAPITALIZED.test(next.text)) {
        end += 1;
      } else if (
        next &&
        afterNext &&
        NAME_CONNECTORS.has(normalize(next.text)) &&
        adjacent(prompt, current, next) &&
        adjacent(prompt, next, afterNext) &&
        CAPITALIZED.test(afterNext.text)
      ) {
        end += 2;
      } else {
        break;
      }
    }

    const text = span(prompt, tokens.slice(index, end + 1));
    if (text) found.push(text);
    index = end + 1;
  }
  return found;
}

/** The few words right after "à", "in", "pour"…, for names typed in lowercase. */
function afterPrepositions(prompt: string, tokens: readonly Token[]): string[] {
  const found: string[] = [];
  tokens.forEach((token, position) => {
    if (!PLACE_PREPOSITIONS.has(normalize(token.text))) return;

    const words: Token[] = [];
    let previous = token;
    let cursor = position + 1;
    while (words.length < MAX_PLACE_WORDS) {
      const next = tokens[cursor];
      if (!next || !adjacent(prompt, previous, next)) break;

      if (!isStopword(next)) {
        words.push(next);
        previous = next;
        cursor += 1;
        continue;
      }

      // A connector continues a name ("rio de janeiro") only when a real word follows it, so
      // the span never ends on a connector.
      const afterNext = tokens[cursor + 1];
      const bridges =
        words.length > 0 &&
        NAME_CONNECTORS.has(normalize(next.text)) &&
        afterNext !== undefined &&
        adjacent(prompt, next, afterNext) &&
        !isStopword(afterNext);
      if (!bridges) break;

      words.push(next, afterNext);
      previous = afterNext;
      cursor += 2;
    }

    const first = words[0];
    const last = words.at(-1);
    if (first && last) found.push(prompt.slice(first.start, last.end));
  });
  return found;
}

/**
 * Finds the substrings of `prompt` that could name a place, in prompt order. Pure code, no
 * model: the classifier then only *selects* among these, so a chosen place is always a literal
 * piece of what the user typed. Recall over precision — a false candidate costs nothing because
 * the model may answer "none of them", but a missing one can never be chosen.
 */
export function extractLocationCandidates(prompt: string): string[] {
  const tokens = tokenize(prompt);
  const all = [...capitalizedRuns(prompt, tokens), ...afterPrepositions(prompt, tokens)];

  const unique = [...new Map(all.map((text) => [normalize(text), text])).values()];
  // "Rio" is redundant next to "Rio de Janeiro": keep only the longest of nested candidates.
  const outermost = unique.filter(
    (text) => !unique.some((other) => other !== text && normalize(other).includes(normalize(text))),
  );

  return outermost
    .sort((left, right) => prompt.indexOf(left) - prompt.indexOf(right))
    .slice(0, MAX_LOCATION_CANDIDATES);
}
