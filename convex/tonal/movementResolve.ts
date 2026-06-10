import { matchesNameSearchStrict, type SearchableMovement } from "./movementSearch";
import { isWellKnownMovementId } from "./transforms";

/** A catalog row reduced to what name/id resolution needs. `Movement` is assignable. */
export interface ResolvableMovement extends SearchableMovement {
  id: string;
}

/** What the coach asked for: a real catalog ID, an exercise name, or (ideally) both. */
export interface MovementRef {
  movementId?: string;
  name?: string;
}

export interface MovementCandidate {
  movementId: string;
  name: string;
}

export type ResolveOutcome =
  | { status: "resolved"; movementId: string; via: "id" | "exact-name" }
  | { status: "not-found"; ref: MovementRef }
  | { status: "ambiguous"; ref: MovementRef; candidates: MovementCandidate[] };

const MAX_CANDIDATES = 5;

/**
 * Resolve a coach-supplied movement reference to a real Tonal catalog ID.
 *
 * The coach (an LLM) routinely fabricates plausible UUIDs instead of calling
 * search_exercises, and it also copies a real id from the wrong exercise while
 * giving the correct new name. So `name` is the source of truth: an exact
 * full-name match wins even over a supplied id. Only when the name gives no
 * unambiguous exact match do we trust a valid id (or a well-known synthetic like
 * Rest), then an exact shortName alias. A fuzzy match is never auto-substituted —
 * the strict matcher fires on a single shared word, so a lone match may be the
 * wrong exercise; we surface candidates / not-found for the model to correct.
 */
export function resolveMovement(ref: MovementRef, catalog: ResolvableMovement[]): ResolveOutcome {
  const name = ref.name?.trim();
  const lower = name?.toLowerCase();

  // Exact full-name match is the highest-confidence signal — prefer it over a
  // supplied movementId, which may be stale or copied from another exercise.
  if (lower) {
    const fullExact = catalog.filter((m) => m.name.toLowerCase() === lower);
    if (fullExact.length === 1) {
      return { status: "resolved", movementId: fullExact[0].id, via: "exact-name" };
    }
    if (fullExact.length > 1)
      return { status: "ambiguous", ref, candidates: toCandidates(fullExact) };
  }

  // A valid id (or well-known synthetic) is trustworthy once the name has failed
  // to produce an unambiguous full-name match.
  if (
    ref.movementId &&
    (isWellKnownMovementId(ref.movementId) || catalog.some((m) => m.id === ref.movementId))
  ) {
    return { status: "resolved", movementId: ref.movementId, via: "id" };
  }

  if (!lower || !name) return { status: "not-found", ref };

  // Exact shortName alias, only after full names and a supplied id are exhausted.
  const shortExact = catalog.filter((m) => m.shortName.toLowerCase() === lower);
  if (shortExact.length === 1) {
    return { status: "resolved", movementId: shortExact[0].id, via: "exact-name" };
  }
  if (shortExact.length > 1)
    return { status: "ambiguous", ref, candidates: toCandidates(shortExact) };

  // Fuzzy: never auto-substitute a lone match. Surface candidates instead.
  const matches = catalog.filter((m) => matchesNameSearchStrict(m, name));
  if (matches.length === 0) return { status: "not-found", ref };
  return { status: "ambiguous", ref, candidates: toCandidates(matches) };
}

function toCandidates(movements: ResolvableMovement[]): MovementCandidate[] {
  return movements.slice(0, MAX_CANDIDATES).map((m) => ({ movementId: m.id, name: m.name }));
}
