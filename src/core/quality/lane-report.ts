import type { RuntimeConfig } from "@core/config";
import { VerdictStore } from "@core/infra/verdict-store";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { judgeLanes, resolveGrader, type Judgement } from "./lane-grader";
import { readRollup, type RollupRow } from "./lane-rollup";
import { countedErrors, fetchLaneStats } from "./lane-stats";

const pct = (n: number, d: number) => `${d ? Math.round((n / d) * 100) : 0}%`;

export interface LaneReport {
  mode: "live" | "rollup";
  day?: string;
  flagged?: Judgement[];
  worst?: RollupRow[];
}

/** The grader's judgement of the current window, without acting on it. */
export async function liveLaneReport(
  config: RuntimeConfig,
  all = false,
): Promise<LaneReport> {
  if (!config.targetDb || !config.laneGrader)
    throw new Error(t("CORE.LANE_GRADER.REPORT_NEEDS_CONFIG"));
  const scoped = resolveGrader(config.laneGrader);
  const g = all ? { ...scoped, providers: ["*"] } : scoped;
  const target = new NewApiClient(config.target, "target");
  const now = Date.now() / 1000;
  const [channels, stats] = await Promise.all([
    target.listChannels(),
    fetchLaneStats(config.targetDb.url, now - g.windowHours * 3600, now),
  ]);
  return { mode: "live", flagged: judgeLanes(stats, channels, g) };
}

/** A day's rollup, worst lanes in the grader's scope first. */
export async function rollupLaneReport(
  config: RuntimeConfig,
  day: string,
  limit: number,
  all = false,
): Promise<LaneReport> {
  const store = config.verdictStore
    ? new VerdictStore(config.verdictStore)
    : null;
  const rows = await readRollup(day, store);
  if (!rows) return { mode: "rollup", day, worst: [] };
  const providers = all ? ["*"] : (config.laneGrader?.providers ?? ["*"]);
  const bad = (r: RollupRow) =>
    (r.emptyOk + r.shortOk + countedErrors(r)) / Math.max(1, r.requests);
  const worst = rows
    .filter(
      (r) =>
        r.requests >= 20 &&
        (providers.includes("*") || providers.includes(r.provider ?? "")),
    )
    .sort((a, b) => bad(b) - bad(a))
    .slice(0, limit);
  return { mode: "rollup", day, worst };
}

export function printLaneReport(report: LaneReport): void {
  if (report.mode === "live") {
    for (const j of report.flagged ?? [])
      console.log(
        `${j.channel.name.padEnd(48)} n=${String(j.stat.requests).padStart(5)} users=${String(j.stat.users).padStart(3)}  ${j.reasons.join(", ")}`,
      );
    console.log(`${report.flagged?.length ?? 0} flagged`);
    return;
  }
  if (!report.worst?.length) {
    console.log(t("CORE.LANE_GRADER.REPORT_NONE", { day: report.day ?? "" }));
    return;
  }
  for (const r of report.worst)
    console.log(
      `${(r.name ?? `#${r.channelId}`).padEnd(48)} n=${String(r.requests).padStart(5)} users=${String(r.users).padStart(3)} empty ${pct(r.emptyOk, r.requests)} short ${pct(r.shortOk, r.requests)} errors ${pct(countedErrors(r), r.requests)} 429 ${pct(r.errors429, r.requests)}${r.quarantined ? "  [quarantined]" : ""}`,
    );
}
