/**
 * Exercise search matching.
 *
 * Searches name, shortName, descriptionHow, and descriptionWhy fields
 * for natural synonym coverage. A small alias map handles spelling
 * variations that descriptions won't cover (pullup vs pull-up, etc.).
 */

/** Spelling variations and common abbreviation ↔ full-name mappings. */
const ALIAS_GROUPS: string[][] = [
  // Spelling / abbreviation variations
  ["pullup", "pull-up", "pull up"],
  ["pushup", "push-up", "push up"],
  ["lat pulldown", "lat pull-down", "lat pull down"],
  ["tricep", "triceps"],
  ["bicep", "biceps"],
  ["fly", "flye"],
  ["ohp", "overhead press"],
  ["sldl", "stiff leg deadlift", "stiff-leg deadlift"],
  ["db", "dumbbell"],
  ["bb", "barbell"],
  ["lat raise", "lateral raise"],
  ["side raise", "lateral raise"],

  // Common gym names → Tonal-specific names
  ["face pull", "standing face pull"],
  ["rear delt fly", "reverse fly"],
  ["rear delt raise", "reverse fly"],
  ["bent over fly", "reverse fly"],
  ["bent over raise", "reverse fly"],
  ["lying tricep extension", "skull crusher"],
  ["french press", "overhead triceps extension"],
  ["cable crunch", "seated cable crunch"],
  ["cable curl", "biceps curl"],
  ["chest fly", "bench chest fly", "middle chest fly", "incline chest fly", "decline chest fly"],
  ["cable fly", "bench chest fly"],
  ["hip thrust", "barbell hip thrust", "resisted glute bridge"],
  ["glute bridge", "resisted glute bridge", "elevated glute bridge", "barbell lying glute bridge"],
  ["deadlift", "neutral grip deadlift", "barbell deadlift", "suitcase deadlift"],
  ["rdl", "romanian deadlift", "barbell rdl", "single leg rdl"],
  ["squat", "goblet squat", "barbell front squat", "racked squat", "bodyweight squat"],
  ["lunge", "goblet reverse lunge", "racked reverse lunge", "resisted alternating lunge"],
  ["row", "bent over row", "seated row", "standing single arm row"],
  ["press", "bench press", "standing chest press", "standing overhead press"],
  ["curl", "biceps curl", "hammer curl", "barbell biceps curl"],
  [
    "extension",
    "triceps extension",
    "overhead triceps extension",
    "reverse grip triceps extension",
  ],
  ["pulldown", "neutral lat pulldown", "seated lat pulldown", "straight arm pulldown"],
  ["shoulder press", "standing overhead press", "seated overhead press"],
  ["military press", "standing barbell overhead press"],
  ["sumo deadlift", "barbell sumo deadlift"],
  ["calf raise", "resisted calf raise", "bent knee calf raise"],
  ["leg extension", "standing leg extension"],
  ["hamstring curl", "prone bench hamstring curl", "standing single leg hamstring curl"],
  ["leg curl", "prone bench hamstring curl"],
  ["hip abduction", "standing hip abduction"],
  ["donkey kick", "standing donkey kick", "quadruped donkey kick"],
  ["plank", "pillar bridge", "incline pillar bridge"],
  ["crunch", "pullover crunch", "seated cable crunch"],
  ["kickback", "triceps kickback", "standing diagonal glute kickback"],
];

/** Map from any alias to all alternatives in its group. */
const ALIAS_LOOKUP: Map<string, string[]> = buildAliasLookup();

function buildAliasLookup(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of ALIAS_GROUPS) {
    for (const term of group) {
      const others = group.filter((t) => t !== term);
      const existing = map.get(term);
      map.set(term, existing ? [...existing, ...others] : others);
    }
  }
  return map;
}

export interface SearchableMovement {
  name: string;
  shortName: string;
  descriptionHow?: string;
  descriptionWhy?: string;
}

export interface MovementSearchFields {
  nameSearchText: string;
  muscleGroupsSearchText: string;
  trainingTypesSearchText: string;
}

/** Build denormalized text fields used by Convex search indexes. */
export function buildMovementSearchFields(
  movement: SearchableMovement & {
    muscleGroups?: readonly string[];
    trainingTypes?: readonly string[];
  },
): MovementSearchFields {
  return {
    nameSearchText: buildMovementNameSearchText(movement),
    muscleGroupsSearchText: buildListSearchText(movement.muscleGroups),
    trainingTypesSearchText: buildListSearchText(movement.trainingTypes),
  };
}

/** Build searchable name text, including aliases that must match pre-filtering. */
export function buildMovementNameSearchText(movement: SearchableMovement): string {
  const fields = [
    movement.name,
    movement.shortName,
    movement.descriptionHow,
    movement.descriptionWhy,
  ];
  const searchableTerms = new Set<string>();

  for (const field of fields) {
    if (field) addSearchTerm(searchableTerms, field);
  }

  const baseText = [...searchableTerms].join(" ");
  const paddedBaseText = ` ${baseText} `;
  for (const group of ALIAS_GROUPS) {
    if (group.some((term) => paddedBaseText.includes(` ${normalizeSearchText(term)} `))) {
      for (const term of group) addSearchTerm(searchableTerms, term);
    }
  }

  return [...searchableTerms].join(" ");
}

/** Build searchable list text for fields that are arrays in the source catalog. */
export function buildListSearchText(values: readonly string[] | undefined): string {
  if (!values) return "";
  const searchableTerms = new Set<string>();
  for (const value of values) addSearchTerm(searchableTerms, value);
  return [...searchableTerms].join(" ");
}

/** Returns true if the movement matches the search query. */
export function matchesNameSearch(movement: SearchableMovement, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;

  const fields = [
    movement.name.toLowerCase(),
    movement.shortName.toLowerCase(),
    movement.descriptionHow?.toLowerCase() ?? "",
    movement.descriptionWhy?.toLowerCase() ?? "",
  ];

  // Direct substring match on any field
  if (fields.some((f) => f.includes(q))) return true;

  // Word-level: any word (>= 3 chars) from query appears in any field
  const queryWords = q.split(/[\s\-]+/).filter((w) => w.length >= 3);
  if (queryWords.some((w) => fields.some((f) => f.includes(w)))) return true;

  // Alias expansion: check full query, individual words, and multi-word subphrases
  const termsToExpand = [q, ...queryWords, ...buildSubphrases(queryWords)];
  for (const term of termsToExpand) {
    const aliases = ALIAS_LOOKUP.get(term);
    if (aliases?.some((a) => fields.some((f) => f.includes(a)))) return true;
  }

  return false;
}

/**
 * Strict name-only matcher. Identical to matchesNameSearch except descriptions
 * are excluded — name and shortName only. Aliases still expand. Use when callers
 * want a low-false-positive search (e.g. LLM tools picking a specific movement).
 */
export function matchesNameSearchStrict(movement: SearchableMovement, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;

  const fields = [movement.name.toLowerCase(), movement.shortName.toLowerCase()];

  if (fields.some((f) => f.includes(q))) return true;

  const queryWords = q.split(/[\s\-]+/).filter((w) => w.length >= 3);
  if (queryWords.some((w) => fields.some((f) => f.includes(w)))) return true;

  const termsToExpand = [q, ...queryWords, ...buildSubphrases(queryWords)];
  for (const term of termsToExpand) {
    const aliases = ALIAS_LOOKUP.get(term);
    if (aliases?.some((a) => fields.some((f) => f.includes(a)))) return true;
  }

  return false;
}

/** Name-match relevance tiers, strongest to weakest. Kept well-separated so the
 *  sub-tier tie-break below never bridges two tiers. */
const SCORE_EXACT = 100;
const SCORE_PREFIX = 80;
const SCORE_CONTAINED_PHRASE = 70;
const SCORE_ALL_WORDS = 50;
const SCORE_PARTIAL_BASE = 30;
const SCORE_PARTIAL_SPAN = 15;
const SCORE_SUBSTRING_FALLBACK = 10;
/** Tie-break: shave a sliver per name word so shorter, more canonical names edge
 *  out longer ones within the same tier (capped so it stays sub-tier). */
const TIEBREAK_MAX_WORDS = 10;
const TIEBREAK_WORD_PENALTY = 0.1;

/**
 * Score how well a movement's name matches a query, for ranking search results
 * and resolution candidates. The boolean matchers above decide *if* a movement
 * matches; this decides *how well*, so the canonical exercise ("Bench Press")
 * ranks above long incidental matches ("Triceps Bench Dip"). Name and shortName
 * only — descriptions never affect ranking. Higher is better; 0 means no name
 * match. Ties favor shorter, more canonical names.
 */
export function scoreNameMatch(movement: SearchableMovement, query: string): number {
  const q = normalizeSearchText(query);
  if (!q) return 0;

  const name = normalizeSearchText(movement.name);
  const short = normalizeSearchText(movement.shortName);
  const phraseQueries = fullQueryPhrases(q);
  const queryWords = q.split(" ").filter((w) => w.length > 0);

  let best = 0;
  for (const field of [name, short]) {
    if (field) best = Math.max(best, scoreField(field, phraseQueries, queryWords));
  }
  if (best <= 0) return 0;

  // Tie-break within a tier toward shorter, more canonical names.
  const nameWordCount = name.split(" ").filter((w) => w.length > 0).length;
  return best - Math.min(nameWordCount, TIEBREAK_MAX_WORDS) * TIEBREAK_WORD_PENALTY;
}

/** Tiered name-match score for a single field (name or shortName). */
function scoreField(field: string, phraseQueries: string[], queryWords: string[]): number {
  for (const pq of phraseQueries) if (field === pq) return SCORE_EXACT;
  for (const pq of phraseQueries) if (field.startsWith(`${pq} `)) return SCORE_PREFIX;
  const padded = ` ${field} `;
  for (const pq of phraseQueries) if (padded.includes(` ${pq} `)) return SCORE_CONTAINED_PHRASE;

  const fieldWords = new Set(field.split(" "));
  const matched = queryWords.filter(
    (w) => fieldWords.has(w) || aliasWordMatches(w, fieldWords),
  ).length;
  if (queryWords.length > 0 && matched === queryWords.length) return SCORE_ALL_WORDS;
  if (matched > 0) return SCORE_PARTIAL_BASE + SCORE_PARTIAL_SPAN * (matched / queryWords.length);

  // Substring fallback keeps results the boolean matcher accepted above 0.
  if (queryWords.some((w) => w.length >= 3 && field.includes(w))) return SCORE_SUBSTRING_FALLBACK;
  return 0;
}

/** The query plus any whole-query alias phrases, for exact/prefix/phrase scoring. */
function fullQueryPhrases(q: string): string[] {
  const phrases = new Set<string>([q]);
  const aliases = ALIAS_LOOKUP.get(q);
  if (aliases) for (const a of aliases) phrases.add(normalizeSearchText(a));
  return [...phrases];
}

/** True if a query word resolves, via the alias map, to word(s) present in the field. */
function aliasWordMatches(word: string, fieldWords: Set<string>): boolean {
  const aliases = ALIAS_LOOKUP.get(word);
  if (!aliases) return false;
  return aliases.some((alias) =>
    normalizeSearchText(alias)
      .split(" ")
      .every((part) => fieldWords.has(part)),
  );
}

function addSearchTerm(terms: Set<string>, value: string) {
  const normalized = normalizeSearchText(value);
  if (normalized) terms.add(normalized);
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds contiguous multi-word subphrases (2+ words) from query words.
 * E.g. ["rear", "delt", "fly"] → ["rear delt", "delt fly", "rear delt fly"]
 */
function buildSubphrases(words: string[]): string[] {
  if (words.length < 2) return [];
  const phrases: string[] = [];
  for (let len = 2; len <= words.length; len++) {
    for (let start = 0; start <= words.length - len; start++) {
      phrases.push(words.slice(start, start + len).join(" "));
    }
  }
  return phrases;
}
