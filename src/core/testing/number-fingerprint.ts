// AdoRouter: an outside reference for what model a lane really serves. The
// answer fingerprints judge a lane against the maker's official route, and
// AdoRouter has none, so they fall back to the largest cluster of marketplace
// lanes, which may be the fakes. lm-detector (MIT, github.com/Ikaleio/lm-detector)
// asks for about 300 first-instinct integers three times and ranks the answers
// against a bank collected from official routes. It is right about 9 times in
// 10 on its own held-out set and always names a closest model, so it only
// logs: nothing here rejects a lane.

import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
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
const DATA_VERSION = "0.0.1793708131735";
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
};

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
  // the field is measured once more without it.
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
      (s) => s.state === "failed" && /\b400\b/.test(s.error ?? ""),
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
        `${where}: number fingerprint says ${says}, claimed family ${r.claimedFamily}, observed only`,
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

/**
 * Measures the lanes whose last measurement is older than `retestDays`, never
 * measured first, until `budgetMinutes` is spent. Every result goes to the
 * ledger and to `number-fingerprint-<day>.jsonl`; a failure to load the bank
 * skips the pass and never fails the run.
 */
export async function runNumberFingerprints(
  provider: string,
  lanes: NumberFingerprintLane[],
  opts: NumberFingerprintOptions,
): Promise<void> {
  const ledger =
    readJson<Record<string, NumberFingerprintRecord>>(ledgerPath(provider)) ??
    {};
  const retestMs = (opts.retestDays ?? 7) * 86_400_000;
  const due = lanes
    .filter((l) => {
      const at = ledger[l.key]?.at;
      return !at || Date.now() - Date.parse(at) >= retestMs;
    })
    .sort(
      (a, b) =>
        (Date.parse(ledger[a.key]?.at ?? "") || 0) -
        (Date.parse(ledger[b.key]?.at ?? "") || 0),
    );
  if (due.length === 0) {
    consola.info(
      `[${provider}] number fingerprints: all ${lanes.length} lane(s) measured lately`,
    );
    return;
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
    return;
  }

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
        if (record.verdict !== "unscored") {
          ledger[lane.key] = record;
          writeJsonAtomic(ledgerPath(provider), ledger, { pretty: true });
        }
        report(provider, lane, record);
      }),
    ),
  );
  const summary = Object.entries(counts)
    .map(([v, n]) => `${n} ${v}`)
    .join(", ");
  consola.info(
    `[${provider}] number fingerprints: ${summary || "none measured"} in ${Math.round((Date.now() - start) / 1000)}s${skipped > 0 ? `, ${skipped} lane(s) left for the next run` : ""}`,
  );
}
