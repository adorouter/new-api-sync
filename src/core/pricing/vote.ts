import { lookup } from "@core/catalog/metadata";
import type { PricingSourceName } from "@core/types";
import type { PricingSource } from "./sources/types";

/** Per-source result, serialised into the testing log for debug. */
interface PricingVoteCandidate {
  source: PricingSourceName;
  matchedKey?: string;
  modelRatio?: number;
  completionRatio?: number;
  /** The source carries this exact name, not a fuzzy neighbour. */
  exact?: boolean;
}

interface PricingVoteCluster {
  members: PricingSourceName[];
  modelRatio: number;
  /** Mean across cluster members (sources can disagree on output:input). */
  completionRatio: number;
  /** Relative price spread the members were allowed (0 = identical). */
  tolerance: number;
  /** Fuzzy name matches were needed to reach agreement. */
  fuzzy: boolean;
}

export interface PricingVoteResult {
  candidates: PricingVoteCandidate[];
  /** Largest cluster size ≥ 2, or null. */
  cluster: PricingVoteCluster | null;
  decision: "voted" | "no-majority" | "no-matches";
}

type Matched = PricingVoteCandidate & { modelRatio: number };

// Strict to loose: exact names at an identical price first, then a widening price
// spread, and only then the fuzzy name neighbours (aipricing's deepseek-v3 answering
// for deepseek-v3.2) through the same steps.
const TOLERANCES = [0, 0.05, 0.1, 0.25];
const OUTVOTE_TOLERANCE = 0.25;

// Round to 4 decimals: collapses float artifacts (0.1 vs 0.09999...) without absorbing real disagreement.
const round = (r: number) => Math.round(r * 10000) / 10000;
const within = (a: number, b: number, tolerance: number) =>
  tolerance === 0
    ? round(a) === round(b)
    : Math.abs(a - b) <= tolerance * Math.max(a, b);

/** Largest group around any one member; ties keep the higher-priority anchor. */
function largestGroup(pool: Matched[], tolerance: number): Matched[] {
  let best: Matched[] = [];
  for (const anchor of pool) {
    const group = pool.filter((c) =>
      within(c.modelRatio, anchor.modelRatio, tolerance),
    );
    if (group.length > best.length) best = group;
  }
  return best;
}

function agreeAt(pool: Matched[], tolerance: number): Matched[] | undefined {
  const group = largestGroup(pool, tolerance);
  if (group.length < 2) return undefined;
  // Two sources quoting the same cloud host's price outvoted three that agree on
  // the maker's within a few percent (deepseek-r1-0528 at $3 against $0.50 to
  // $0.66): a larger loose group at another price voids this one.
  const loose = largestGroup(pool, OUTVOTE_TOLERANCE);
  const anchor = group[0]!.modelRatio;
  if (
    loose.length > group.length &&
    !within(loose[0]!.modelRatio, anchor, OUTVOTE_TOLERANCE)
  )
    return undefined;
  return group;
}

/**
 * Agreement between pricing sources, tried strict to loose (see TOLERANCES).
 * No agreement at any step → no-majority, and the caller falls back to the
 * median source rather than trusting any single, possibly promo-distorted one.
 */
export function resolveCanonicalByVote(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): PricingVoteResult {
  const candidates: PricingVoteCandidate[] = [];

  for (const source of sources) {
    const hit = lookup(modelName, source.pricing, reverseMapping);
    if (hit) {
      candidates.push({
        source: source.name,
        matchedKey: hit.key,
        modelRatio: hit.value.modelRatio,
        completionRatio: hit.value.completionRatio,
        exact: hit.exact,
      });
    } else {
      candidates.push({ source: source.name });
    }
  }

  const matched = candidates.filter(
    (c): c is Matched => c.modelRatio !== undefined,
  );
  if (matched.length === 0) {
    return { candidates, cluster: null, decision: "no-matches" };
  }

  const exactPool = matched.filter((c) => c.exact);
  for (const fuzzy of [false, true]) {
    const pool = fuzzy ? matched : exactPool;
    if (fuzzy && pool.length === exactPool.length) break;
    for (const tolerance of TOLERANCES) {
      const members = agreeAt(pool, tolerance);
      if (!members) continue;
      const ratios = members.map((m) => m.modelRatio).sort((a, b) => a - b);
      const completionRatios = members
        .map((m) => m.completionRatio)
        .filter((x): x is number => x !== undefined);
      return {
        candidates,
        cluster: {
          members: members.map((m) => m.source),
          // A quoted price, never a blend: the cheaper middle member.
          modelRatio: round(ratios[Math.floor((ratios.length - 1) / 2)]!),
          completionRatio:
            completionRatios.length > 0
              ? completionRatios.reduce((a, b) => a + b, 0) /
                completionRatios.length
              : 1,
          tolerance,
          fuzzy,
        },
        decision: "voted",
      };
    }
  }
  return { candidates, cluster: null, decision: "no-majority" };
}
