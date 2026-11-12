// AdoRouter: an outside reference for what model a lane really serves. The
// answer fingerprints judge a lane against the maker's official route, and
// AdoRouter has none, so they fall back to the largest cluster of marketplace
// lanes, which may be the fakes. lm-detector (MIT, github.com/Ikaleio/lm-detector)
// asks for about 300 first-instinct integers three times and ranks the answers
// against a bank collected from official routes. It is right about 9 times in
// 10 on its own held-out set and always names a closest model, so one reading
// never decides anything. With `enforce` on, a lane is rejected only when two
// readings from separate runs both name another model with confidence
// (fingerprintReject); every other result only logs. Lanes whose model is in
// the bank are measured first, since only they can be judged.

import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import {
  NUMBER_FINGERPRINT_FAIL_PREFIX,
  setAuthenticityVerdict,
} from "@core/testing/verdict-cache";
import { consola } from "consola";
import { appendFileSync, mkdirSync } from "fs";
import {
  loadDetector,
  type Analysis,
  type Detector,
  type Sample,
} from "lmfpd-sdk";
import pLimit from "p-limit";
import { join } from "path";

// Pinned: a new bank changes every verdict, so it is taken on deliberately.
// 2026-11-11 build, 69 models (adds claude-fable-5.2, gemini-4-carbon and
// muse-ember to the 2026-11-03 one).
const DATA_VERSION = "0.0.1794360871947";
const DATA_URL = `https://cdn.jsdelivr.net/npm/lmfpd-data@${DATA_VERSION}/`;

export type NumberFingerprintVerdict =
  | "match"
  | "family-match"
  | "family-mismatch"
  | "unknown-family"
  | "not-model"
  | "unscored";

export type NumberFingerprintRecord = {
  at: string;
  model: string;
  /** The bank's id for the model the lane claims, when the bank has it. */
  claimed: string | null;
  claimedFamily: string | null;
  verdict: NumberFingerprintVerdict;
  decision: Analysis["decision"] | null;
  prediction: string | null;
  family: string | null;
  probability: number | null;
  top: { model: string; probability: number | null }[];
  effort: string;
  samples: {
    state: Sample["state"];
    count: number;
    expected: number;
    responseModel: string | null;
    responseId: string | null;
    error: string | null;
  }[];
  error: string | null;
  bank: string;
};

export type NumberFingerprintLane = {
  /** Verdict-cache key, `<provider>:<channel>|<model>`. */
  key: string;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type NumberFingerprintOptions = {
  budgetMinutes?: number;
  retestDays?: number;
  lanesInParallel?: number;
  /** Reject lanes that fingerprintReject convicts; off, they are only logged. */
  enforce?: boolean;
};

// A reading counts against a lane only when the bank knows the claimed model,
// all three replies were scored, at least two came back complete, and the
// closest model is another one at this probability or more. The first pass
// (2026-11-09) gave 98 to 100% on every tier downgrade it found, and 30 to 40%
// on the readings that looked like noise.
export const REJECT_PROBABILITY = 0.95;
const MIN_COMPLETE_SAMPLES = 2;
// Readings this far apart come from separate runs.
const MIN_READING_GAP_MS = 20 * 60 * 60 * 1000;

// The bank's older Claude references came through resellers, so a Claude lane
// read as another version of its own tier proves nothing. A lower tier does
// (an Opus lane answering like Haiku), and so does another family.
const CLAUDE_TIERS = ["haiku", "sonnet", "opus", "fable", "mythos"];
const claudeTier = (id: string) =>
  CLAUDE_TIERS.findIndex((t) => id.toLowerCase().includes(`claude-${t}`));

/** The model one reading says the lane really serves, or null when it says nothing firm. */
export function confidentOther(r: NumberFingerprintRecord): string | null {
  if (!r.claimed || r.decision !== "scored") return null;
  if (!r.prediction || r.prediction === r.claimed) return null;
  if ((r.probability ?? 0) < REJECT_PROBABILITY) return null;
  const complete = r.samples.filter((s) => s.state === "complete").length;
  if (complete < MIN_COMPLETE_SAMPLES) return null;
  if (r.claimedFamily === "claude" && r.family === "claude") {
    const want = claudeTier(r.claimed);
    const got = claudeTier(r.prediction);
    if (want < 0 || got < 0 || got >= want) return null;
  }
  return r.prediction;
}

/**
 * The fail reason when this reading and the lane's previous one, from an earlier
 * run, both name another model of the same family; otherwise null.
 */
export function fingerprintReject(
  current: NumberFingerprintRecord,
  previous: NumberFingerprintRecord | undefined,
): string | null {
  const now = confidentOther(current);
  if (!now || !previous) return null;
  const before = confidentOther(previous);
  if (!before) return null;
  if (previous.claimed !== current.claimed) return null;
  if (previous.family !== current.family) return null;
  if (Date.parse(current.at) - Date.parse(previous.at) < MIN_READING_GAP_MS)
    return null;
  const reads =
    before === now
      ? now
      : `${before} on ${previous.at.slice(0, 10)}, then ${now}`;
  return `${NUMBER_FINGERPRINT_FAIL_PREFIX}: sold as ${current.claimed}, answers like ${reads} (${pct(current.probability)}) on two runs`;
}

const ledgerPath = (provider: string) =>
  join(logsDir(), `number-fingerprints-${provider}.json`);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Effort and date suffixes name the same weights: gemini-3.5-flash-high is
// gemini-3.5-flash, claude-haiku-4-5-20251001 is claude-haiku-4.5.
const bareName = (model: string) =>
  model
    .toLowerCase()
    .replace(/-\d{8}$/, "")
    .replace(/-(extra-low|minimal|low|medium|high|none)$/, "");

const FAMILY_ALIASES: Record<string, string> = { hy: "hunyuan" };

function claimOf(
  model: string,
  results: Analysis["results"],
): { claimed: string | null; claimedFamily: string | null } {
  const bare = norm(bareName(model));
  const hit = results.find((r) => norm(r.model) === bare);
  if (hit) return { claimed: hit.model, claimedFamily: hit.family };
  const families = [...new Set(results.map((r) => r.family))];
  const lead = model.toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
  const family =
    families.find((f) => f === (FAMILY_ALIASES[lead] ?? lead)) ??
    families.find((f) => model.toLowerCase().startsWith(f)) ??
    null;
  return { claimed: null, claimedFamily: family };
}

function verdictOf(
  analysis: Analysis | null,
  claimed: string | null,
  claimedFamily: string | null,
): NumberFingerprintVerdict {
  if (!analysis) return "unscored";
  if (analysis.decision === "not_model") return "not-model";
  if (analysis.decision !== "scored" && analysis.decision !== "partial")
    return "unscored";
  if (claimed && analysis.prediction === claimed) return "match";
  if (!claimedFamily) return "unknown-family";
  return analysis.family_prediction === claimedFamily
    ? "family-match"
    : "family-mismatch";
}

async function measure(
  detector: Detector,
  lane: NumberFingerprintLane,
): Promise<NumberFingerprintRecord> {
  // The bank was collected at low or no reasoning effort; a lane that refuses
  // the field is measured once more without it. The marketplace refuses an
  // unsupported field with 400 or with 404 ("does not match this request").
  let effort = "low";
  const round = (e: string) =>
    detector.detect({
      baseUrl: lane.baseUrl,
      apiKey: lane.apiKey,
      model: lane.model,
      api: "chat_completions",
      effort: e,
      timeout: 120,
    });
  let result = await round(effort);
  if (
    !result.analysis &&
    result.samples.every(
      (s) => s.state === "failed" && /\b40[04]\b/.test(s.error ?? ""),
    )
  ) {
    effort = "";
    result = await round(effort);
  }
  const analysis = result.analysis;
  const { claimed, claimedFamily } = claimOf(
    lane.model,
    analysis?.results ?? [],
  );
  return {
    at: new Date().toISOString(),
    model: lane.model,
    claimed,
    claimedFamily,
    verdict: verdictOf(analysis, claimed, claimedFamily),
    decision: analysis?.decision ?? null,
    prediction: analysis?.prediction || null,
    family: analysis?.family_prediction || null,
    probability: analysis?.probability ?? null,
    top: (analysis?.results ?? [])
      .slice(0, 3)
      .map((r) => ({ model: r.model, probability: r.probability })),
    effort,
    samples: result.samples.map((s) => ({
      state: s.state,
      count: s.count,
      expected: s.expected_count,
      responseModel: s.response_model,
      responseId: s.response_id,
      error: s.error,
    })),
    error: result.error,
    bank: detector.builtAt,
  };
}

const pct = (p: number | null) =>
  p === null ? "no confidence" : `${Math.round(p * 100)}%`;

function report(
  provider: string,
  lane: NumberFingerprintLane,
  r: NumberFingerprintRecord,
) {
  const where = `[${provider}] ${lane.key.split("|")[0]!.split(":")[1]} ${lane.model}`;
  const says = `${r.prediction} (${r.family}, ${pct(r.probability)})`;
  switch (r.verdict) {
    case "match":
      consola.info(
        `${where}: number fingerprint matches, ${pct(r.probability)}`,
      );
      return;
    case "family-match":
      consola.info(`${where}: number fingerprint says ${says}, same family`);
      return;
    case "unknown-family":
      consola.info(
        `${where}: number fingerprint says ${says}, model not in its bank`,
      );
      return;
    case "family-mismatch":
      consola.warn(
        `${where}: number fingerprint says ${says}, claimed family ${r.claimedFamily}`,
      );
      return;
    case "not-model":
      consola.warn(
        `${where}: number fingerprint says the answers do not look like a language model, observed only`,
      );
      return;
    default:
      consola.info(
        `${where}: number fingerprint unscored (${r.error ?? r.decision ?? "no answers"})`,
      );
  }
}

// The bank's model ids, read by scoring a made-up reply offline: a partial
// ranking lists every candidate. Empty when that ever stops working, which only
// loses the ordering.
function bankModels(detector: Detector): Set<string> {
  const text = Array.from({ length: 300 }, (_, i) => ((i * 37) % 355) + 1).join(
    ", ",
  );
  try {
    const a = detector.analyze([{ text, expected_count: 300 }]);
    return new Set(a.results.map((r) => norm(r.model)));
  } catch {
    return new Set();
  }
}

/**
 * Measures the lanes whose last measurement is older than `retestDays` until
 * `budgetMinutes` is spent: lanes whose model is in the bank first (a lane with
 * one confident reading of another model before the rest), then the others,
 * never measured before long ago. Every result goes to the ledger and to
 * `number-fingerprint-<day>.jsonl`; a failure to load the bank skips the pass
 * and never fails the run. Returns the keys of the lanes rejected this run.
 */
export async function runNumberFingerprints(
  provider: string,
  lanes: NumberFingerprintLane[],
  opts: NumberFingerprintOptions,
): Promise<Set<string>> {
  const rejected = new Set<string>();
  const ledger =
    readJson<Record<string, NumberFingerprintRecord>>(ledgerPath(provider)) ??
    {};
  const retestMs = (opts.retestDays ?? 7) * 86_400_000;
  const due = lanes.filter((l) => {
    const at = ledger[l.key]?.at;
    return !at || Date.now() - Date.parse(at) >= retestMs;
  });
  if (due.length === 0) {
    consola.info(
      `[${provider}] number fingerprints: all ${lanes.length} lane(s) measured lately`,
    );
    return rejected;
  }

  let detector: Detector;
  try {
    detector = await loadDetector({
      source: [DATA_URL],
      cache: join(logsDir(), "lmfpd-data.bin"),
      ttl: 30 * 86_400,
    });
  } catch (err) {
    consola.warn(
      `[${provider}] number fingerprints skipped: reference bank did not load (${err instanceof Error ? err.message : String(err)})`,
    );
    return rejected;
  }

  const bank = bankModels(detector);
  const rank = (l: NumberFingerprintLane) => {
    if (bank.size > 0 && !bank.has(norm(bareName(l.model)))) return 2;
    const last = ledger[l.key];
    return last && confidentOther(last) ? 0 : 1;
  };
  due.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (Date.parse(ledger[a.key]?.at ?? "") || 0) -
        (Date.parse(ledger[b.key]?.at ?? "") || 0),
  );
  const inBank = due.filter((l) => rank(l) < 2).length;
  consola.info(
    `[${provider}] number fingerprints: ${due.length} lane(s) due, ${inBank} with their model in the bank${opts.enforce ? "" : ", observe only"}`,
  );

  const start = Date.now();
  const budgetMs = (opts.budgetMinutes ?? 30) * 60_000;
  const day = new Date().toISOString().slice(0, 10);
  const logPath = join(logsDir(), `number-fingerprint-${day}.jsonl`);
  mkdirSync(logsDir(), { recursive: true });
  const counts: Partial<Record<NumberFingerprintVerdict, number>> = {};
  let skipped = 0;
  const limit = pLimit(opts.lanesInParallel ?? 2);
  await Promise.all(
    due.map((lane) =>
      limit(async () => {
        if (Date.now() - start >= budgetMs) {
          skipped++;
          return;
        }
        let record: NumberFingerprintRecord;
        try {
          record = await measure(detector, lane);
        } catch (err) {
          consola.warn(
            `[${provider}] ${lane.model}: number fingerprint failed (${err instanceof Error ? err.message : String(err)})`,
          );
          return;
        }
        counts[record.verdict] = (counts[record.verdict] ?? 0) + 1;
        appendFileSync(
          logPath,
          JSON.stringify({ key: lane.key, ...record }) + "\n",
        );
        // An unscored lane (busy, refused, cut off) is measured again next run.
        const previous = ledger[lane.key];
        if (record.verdict !== "unscored") {
          ledger[lane.key] = record;
          writeJsonAtomic(ledgerPath(provider), ledger, { pretty: true });
        }
        report(provider, lane, record);
        const reason = fingerprintReject(record, previous);
        if (!reason) return;
        if (opts.enforce) {
          rejected.add(lane.key);
          setAuthenticityVerdict(lane.key, "fail", reason);
          consola.warn(`[${provider}] ${lane.key}: rejected, ${reason}`);
        } else
          consola.warn(`[${provider}] ${lane.key}: would reject, ${reason}`);
      }),
    ),
  );
  const summary = Object.entries(counts)
    .map(([v, n]) => `${n} ${v}`)
    .join(", ");
  consola.info(
    `[${provider}] number fingerprints: ${summary || "none measured"} in ${Math.round((Date.now() - start) / 1000)}s${skipped > 0 ? `, ${skipped} lane(s) left for the next run` : ""}${rejected.size > 0 ? `, ${rejected.size} rejected` : ""}`,
  );
  return rejected;
}
