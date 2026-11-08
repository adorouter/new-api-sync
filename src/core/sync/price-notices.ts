// AdoRouter: price-notice upkeep for marketplace lanes on its own, without
// `metadata`. A merchant price rise pauses our pin and the lane errors until the
// notice is accepted; upstream accepts on the 15-minute metadata cron, which
// also re-probes live lanes (paid) and rewrites the catalogue's prices. Here it
// runs alone on a timer, and a rise is accepted only while what the lane already
// sells for still covers the new cost plus MIN_MARKUP. A larger rise stays
// paused until the next full run reprices the lane.

import type { RuntimeConfig } from "@core/config";
import { OptionStore } from "@core/sync/option-store";
import { acceptPriceNotices, channelLane } from "@core/vendors/a7/pins";
import { NewApiClient } from "@core/vendors/newapi/client";
import { consola } from "consola";

// The site's margin rule: 25% over what a provider costs us.
export const MIN_MARKUP = 1.25;
// new-api ratio units: a model ratio of 1 is $2 per million input tokens.
const USD_PER_M_PER_RATIO = 2;

export interface PriceNoticeResult {
  provider: string;
  accepted: number;
  leftPaused: number;
}

/** Output price per million tokens each live lane sells at, by `<merchant>|<exposed model>`. */
export function laneSellOutUsd(
  provider: string,
  channels: { tag?: string; group?: string; models: string }[],
  options: Record<string, Record<string, unknown>>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const ch of channels) {
    if (ch.tag !== provider || !ch.group) continue;
    const lane = channelLane(ch);
    if (!lane) continue;
    const group = Number(options.GroupRatio?.[ch.group]);
    const model = Number(options.ModelRatio?.[lane.exposed]);
    const completion = Number(options.CompletionRatio?.[lane.exposed] ?? 1);
    if (!(group > 0 && model > 0 && completion > 0)) continue;
    out.set(
      `${lane.channelId}|${lane.exposed}`,
      group * model * completion * USD_PER_M_PER_RATIO,
    );
  }
  return out;
}

export function marginGuard(
  sellOut: Map<string, number>,
  modelMapping: Record<string, string> | undefined,
) {
  return (notice: {
    channelId: number;
    model: string;
    newOutMicros: number | undefined;
  }): string | undefined => {
    if (notice.newOutMicros === undefined) return "no new price on the notice";
    const exposed = (
      modelMapping?.[notice.model] ?? notice.model
    ).toLowerCase();
    const sell = sellOut.get(`${notice.channelId}|${exposed}`);
    if (sell === undefined) return "no live lane priced for it";
    const cost = notice.newOutMicros / 1e6;
    if (cost * MIN_MARKUP > sell)
      return `new cost $${cost.toFixed(3)}/M out leaves under 25% on our $${sell.toFixed(3)}/M; the next full run reprices it`;
    return undefined;
  };
}

export async function runPriceNotices(
  config: RuntimeConfig,
): Promise<PriceNoticeResult[]> {
  const target = new NewApiClient(config.target, "target");
  const [channels, store] = await Promise.all([
    target.listChannels(),
    OptionStore.load(target),
  ]);
  const options = {
    GroupRatio: store.object("GroupRatio"),
    ModelRatio: store.object("ModelRatio"),
    CompletionRatio: store.object("CompletionRatio"),
  };
  const results: PriceNoticeResult[] = [];
  for (const p of config.providers) {
    if (p.type !== "a7") continue;
    const sellOut = laneSellOutUsd(p.name, channels, options);
    const r = await acceptPriceNotices(p, {
      guard: marginGuard(sellOut, config.modelMapping),
    });
    consola.info(
      `[${p.name}] price changes accepted: ${r.accepted}, left paused: ${r.leftPaused} (${sellOut.size} live lane(s) priced)`,
    );
    results.push({ provider: p.name, ...r });
  }
  return results;
}
