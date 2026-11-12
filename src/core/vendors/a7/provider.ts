import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { resolvePerModel } from "@core/pricing";
import { inferModelType } from "@core/catalog/constants/inference";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { resolveMedianPricing } from "@core/pricing/resolver";
import { CURATED_PRICING } from "@core/pricing/sources/curated";
import { resolveCanonicalByVote } from "@core/pricing/vote";
import { testAndFilterModels } from "@core/testing/runner";
import { isAuthenticityBlacklisted } from "@core/testing/authenticity";
import { runNumberFingerprints } from "@core/testing/number-fingerprint";
import {
  REASONING_FAIL_REASON,
  clearTestFail,
  getVerdict,
  isTestFailFresh,
} from "@core/testing/verdict-cache";
import { evictLaneKey, laneKeyStats } from "@core/infra/lane-keys";
import { parseDisableReason } from "@core/vendors/newapi/disable-reason";
import type { MergedGroup, ProviderReport } from "@core/types";
import type { A7ProviderConfig } from "@core/validations/config";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import { consola } from "consola";
import pLimit from "p-limit";
import { t } from "@server/i18n";
import { SupplierStrikes, supplierKeyOf } from "./supplier-strikes";
import { WalkOrder } from "./walk-order";
import {
  DEFAULT_MAX_SELL_FRACTION,
  DEFAULT_PROFIT_MULTIPLE,
  costShareOfList,
  fetchListingsByModel,
  fetchA7Quota,
  fetchMarketplaceModelNames,
  resolveMarketplaceModels,
  selectMerchants,
  usdPerMillion,
  type Listing,
  type ListPrice,
} from "./marketplace";
import {
  channelLane,
  cleanupStaleLaneTokens,
  ensureLaneTokens,
  ensurePins,
  laneNameFromChannel,
  laneTokenName,
  type MerchantLane,
} from "./pins";

// new-api stores price as a ratio, not USD: ratio 1 is $2 per 1M tokens.
const USD_PER_M_PER_RATIO = 2;
// Share of the walk's lanes that may lose their key to a 429 before the run
// counts as failed rather than partial.
const THROTTLE_FAIL_RATIO = 0.2;
// The full run's Job is killed at 3 hours and its apply takes a few minutes, so
// no model starts after this; one not reached keeps its lanes and tokens, exactly
// like a model the marketplace could not describe this run.
const WALK_BUDGET_MS = 150 * 60_000;
const A7_MODEL_PARALLEL = 3;
// AdoRouter: lanes a model may send to the upstream before the walk moves on,
// keeping whatever passed. Candidates the verdict cache already rejects cost
// nothing and do not count. hy4-preview probed 42 fakes for an hour on
// 2026-11-08 and minimax-m3.1-flash 19, which left 69 models unwalked.
const A7_MAX_PROBES_PER_MODEL = 12;

interface ModelCandidates {
  model: string;
  candidates: Listing[];
  wanted: number;
  canonicalListUsd?: number;
  list?: ListPrice;
}

// Vote on the mapped (canonical) name: the marketplace spelling
// (claude-opus-4-6) may miss the sources that know claude-opus-4.6.
function canonicalVote(
  model: string,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): { modelRatio: number; completionRatio?: number } | undefined {
  const exposedName = (config.modelMapping?.[model] ?? model).toLowerCase();
  // AdoRouter: a hand-checked rate card beats the vote here too, as it does in
  // the canonical map the emitted lanes are priced against. Without this the
  // sell ceiling and the live-lane sweep divided by the voted list while
  // ModelRatio published the pinned one.
  const pinned = CURATED_PRICING[exposedName];
  if (pinned)
    return {
      modelRatio: pinned.modelRatio,
      completionRatio: pinned.completionRatio,
    };
  const cluster = resolveCanonicalByVote(
    exposedName,
    ctx.pricingSources,
    ctx.reverseMapping,
  ).cluster;
  if (cluster) return cluster;
  // Same fallback as compute's sticker: a failed vote left this undefined, so
  // the sell ceiling never applied and a merchant repricing itself to 32x list
  // sailed through at cost x profitMultiple.
  const hit = resolveMedianPricing(
    exposedName,
    ctx.pricingSources,
    ctx.reverseMapping,
  );
  return hit
    ? { modelRatio: hit.modelRatio, completionRatio: hit.completionRatio }
    : undefined;
}

function canonicalListFor(
  model: string,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): ListPrice | undefined {
  const cluster = canonicalVote(model, config, ctx);
  if (!cluster) return undefined;
  const inputUsd = cluster.modelRatio * USD_PER_M_PER_RATIO;
  return { inputUsd, outputUsd: inputUsd * (cluster.completionRatio ?? 1) };
}

// Retail multiple for one lane. minSellFraction is a floor, not a merchant
// cut: a lane whose cost x profitMultiple lands under list x minSellFraction
// sells at the floor (the cheap merchant stays, the margin grows). The sell
// ceiling still wins.
function laneMultiple(
  provider: A7ProviderConfig,
  model: string,
  channelId: number,
  outputUsd: number,
  canonicalListUsd: number | undefined,
): number {
  const profitMultiple = resolvePerModel(
    provider.profitMultiple,
    model,
    DEFAULT_PROFIT_MULTIPLE,
  );
  const minSell = resolvePerModel(provider.minSellFraction, model, 0);
  if (minSell <= 0 || canonicalListUsd === undefined || outputUsd <= 0)
    return profitMultiple;
  const maxSell = resolvePerModel(
    provider.maxSellFraction,
    model,
    DEFAULT_MAX_SELL_FRACTION,
  );
  const floor = (canonicalListUsd * minSell) / outputUsd;
  const ceiling = (canonicalListUsd * maxSell) / outputUsd;
  const multiple = Math.min(
    Math.max(profitMultiple, floor),
    Math.max(ceiling, profitMultiple),
  );
  if (multiple !== profitMultiple)
    consola.info(
      `[${provider.name}] floor ${model} -> ${channelId}: ${profitMultiple}x -> ${multiple.toFixed(2)}x (${minSell} of list $${canonicalListUsd.toFixed(2)}/M out)`,
    );
  return multiple;
}

// Live lanes this run did not re-select keep serving at whatever ratio they
// were created with; recompute them from the current listing so a multiplier
// or floor change reaches every lane, not only the top N.
function sweepLiveLanes(
  provider: A7ProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
  byModel: Map<string, Listing[]>,
): MergedGroup[] {
  const out: MergedGroup[] = [];
  const marketByExposed = new Map<string, string>();
  for (const model of byModel.keys())
    marketByExposed.set(
      (config.modelMapping?.[model] ?? model).toLowerCase(),
      model,
    );
  for (const ch of ctx.liveChannels ?? []) {
    if (ch.tag !== provider.name || !ch.group) continue;
    const exposed = ch.models.split(",")[0]?.trim().toLowerCase();
    const market = exposed ? marketByExposed.get(exposed) : undefined;
    if (!exposed || !market) continue;
    const suffix = `-${sanitizeGroupName(exposed)}`;
    if (!ch.group.endsWith(suffix)) continue;
    const id = /(\d+)$/.exec(ch.group.slice(0, -suffix.length))?.[1];
    const listing = id
      ? byModel.get(market)?.find((l) => l.channel_id === Number(id))
      : undefined;
    if (!listing) {
      // Merchant gone from the listings but the lane is live (the gateway
      // re-enables lanes on its own retest); no cost to price from, so hold
      // the floor until the full run culls it.
      const minSell = resolvePerModel(provider.minSellFraction, market, 0);
      if (minSell > 0)
        out.push({
          name: ch.group,
          ratio: minSell,
          description: `${market} via ${provider.name} merchant #${id} (unlisted, floor)`,
          provider: provider.name,
        });
      continue;
    }
    const cluster = canonicalVote(market, config, ctx);
    if (!cluster || cluster.modelRatio <= 0) continue;
    // The emitted path resolves offer.groupRatio through cost / sticker in
    // compute; here that is done directly. The sticker is the canonical list,
    // so the final ratio is the fraction of list and the floor/ceiling clamp
    // applies to it as-is.
    const listUsd =
      cluster.modelRatio * USD_PER_M_PER_RATIO * (cluster.completionRatio ?? 1);
    const multiple = laneMultiple(
      provider,
      market,
      listing.channel_id,
      usdPerMillion(listing.output_price_micros),
      listUsd,
    );
    // AdoRouter: priced on the dearer side, as compute prices the emitted lanes.
    const costShare = costShareOfList(listing, {
      inputUsd: cluster.modelRatio * USD_PER_M_PER_RATIO,
      outputUsd: listUsd,
    });
    const minSell = resolvePerModel(provider.minSellFraction, market, 0);
    const maxSell = resolvePerModel(
      provider.maxSellFraction,
      market,
      DEFAULT_MAX_SELL_FRACTION,
    );
    const ratio = Math.min(
      Math.max(multiple * costShare, minSell),
      Math.max(maxSell, minSell),
    );
    out.push({
      name: ch.group,
      ratio: Math.round(ratio * 10000) / 10000,
      description: `${market} via ${provider.name} merchant #${listing.channel_id}`,
      provider: provider.name,
    });
  }
  return out;
}

function collectCandidates(
  provider: A7ProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
  byModel: Map<string, Listing[]>,
  strikes: SupplierStrikes,
): {
  models: ModelCandidates[];
  skippedModels: string[];
  struckCandidates: number;
} {
  const models: ModelCandidates[] = [];
  const skippedModels: string[] = [];
  let struckCandidates = 0;

  // Every key of byModel already passed the blacklist, enabled and --models
  // cuts in resolveMarketplaceModels.
  for (const [model, rows] of byModel) {
    // Cap cut: reject a merchant whose cost * profitMultiple breaches 1x list.
    // The vote's modelRatio is the input price in ratio units.
    const list = canonicalListFor(model, config, ctx);
    const canonicalListUsd = list?.outputUsd;

    const wanted = resolvePerModel(provider.hostsPerModel, model, 1);
    const viable = selectMerchants(
      model,
      rows,
      provider,
      list,
      config.blacklist,
    );
    const candidates = viable.filter((l) => !strikes.isStruck(l));
    struckCandidates += viable.length - candidates.length;
    if (candidates.length === 0) {
      skippedModels.push(model);
      continue;
    }
    models.push({ model, candidates, wanted, canonicalListUsd, list });
  }
  // Two marketplace names mapped to one published model (a lapsed promo name
  // beside the live one) list the same merchants; a merchant kept under both
  // would emit one channel name twice. First model wins the merchant.
  const seen = new Map<string, Set<number>>();
  for (const mc of models) {
    const exposed = (config.modelMapping?.[mc.model] ?? mc.model).toLowerCase();
    let taken = seen.get(exposed);
    if (!taken) seen.set(exposed, (taken = new Set()));
    mc.candidates = mc.candidates.filter((l) => {
      if (taken.has(l.channel_id)) return false;
      taken.add(l.channel_id);
      return true;
    });
  }
  return {
    models: models.filter((mc) => mc.candidates.length > 0),
    skippedModels,
    struckCandidates,
  };
}

export async function processA7Provider(
  provider: A7ProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const name = provider.name;
  const report: ProviderReport = {
    name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  let extraGroups: MergedGroup[] = [];
  const dryRun = ctx.dryRun ?? false;

  try {
    // An empty wallet fails every probe with a quota answer, and the walk would
    // then delete every lane and its pinned token. The lanes are fine; wait for
    // the top-up instead.
    const quota = dryRun ? null : await fetchA7Quota(provider);
    if (quota !== null && quota <= 0) {
      report.deletesWithheld = true;
      report.error = t("CORE.ERROR.WALLET_EMPTY_SKIPPED", { name });
      consola.warn(`[${name}] ${report.error}`);
      return {
        report,
        offers,
        endpointMetadata: { endpointPaths: new Map() },
        extraGroups,
      };
    }
    const marketNames = await fetchMarketplaceModelNames(provider);
    const wantedModels = marketNames
      ? resolveMarketplaceModels(provider, config, marketNames)
      : [];
    const { byModel, failed: unreachable } =
      wantedModels.length > 0
        ? await fetchListingsByModel(provider, wantedModels)
        : { byModel: new Map<string, Listing[]>(), failed: [] };
    if (byModel.size === 0) {
      report.error = "marketplace returned no listings";
      return {
        report,
        offers,
        endpointMetadata: { endpointPaths: new Map() },
        extraGroups,
      };
    }
    // A model the marketplace could not describe this run is unknown, not
    // empty: its lanes and tokens are kept as they are until a run can see it.
    const unverifiedMarket = new Set(unreachable);
    report.unverifiedModels = unreachable.map((m) =>
      (config.modelMapping?.[m] ?? m).toLowerCase(),
    );
    if (unreachable.length > 0)
      consola.warn(
        `[${name}] ${unreachable.length} model(s) unreachable at the marketplace this run, their lanes are kept: ${unreachable.join(", ")}`,
      );

    // Fresh severe fails already in the verdict cache strike their supplier
    // before the walk, so its other channels are never keyed or probed.
    const strikes = new SupplierStrikes(
      name,
      provider.banStruckSuppliers === true,
    );
    for (const [model, rows] of byModel)
      for (const row of rows) strikes.noteVerdict(row, model);
    const { models, skippedModels, struckCandidates } = collectCandidates(
      provider,
      config,
      ctx,
      byModel,
      strikes,
    );
    const candidateTotal = models.reduce((n, m) => n + m.candidates.length, 0);
    consola.info(
      `[${name}] ${models.length} model(s), ${candidateTotal} candidate merchant(s), ${skippedModels.length} model(s) without a qualifying merchant, ${struckCandidates} listing(s) of struck suppliers skipped`,
    );
    if (models.length === 0) {
      report.error = "no model had a merchant meeting the price/health rules";
      return {
        report,
        offers,
        endpointMetadata: { endpointPaths: new Map() },
        extraGroups,
      };
    }

    const skipCleanup =
      (config.modelFilter?.length ?? 0) > 0 ||
      (config.modelTypeFilter?.length ?? 0) > 0;

    // A lane the gateway switched off serves nothing until its own retest
    // revives it: a passing probe holds it but does not count toward `wanted`.
    // Keyed by merchant and exposed name, since the market may list a model
    // under two spellings.
    const offLanes = new Set<string>();
    const laneKey = (channelId: number, exposed: string) =>
      `${channelId}|${exposed.toLowerCase()}`;
    if (!dryRun) {
      const marketByExposed = new Map<string, string>();
      for (const model of byModel.keys())
        marketByExposed.set(
          (config.modelMapping?.[model] ?? model).toLowerCase(),
          model,
        );
      for (const ch of ctx.liveChannels ?? []) {
        if (ch.tag !== name || ch.status === 1 || !ch.group) continue;
        const lane = channelLane(ch);
        if (!lane) continue;
        offLanes.add(laneKey(lane.channelId, lane.exposed));
        if (ch.status !== 3) continue;
        // A credential fault means the cached key stopped working; drop it so
        // this walk reveals it afresh.
        const reason = parseDisableReason(ch.other_info);
        if (!reason.credential) continue;
        const laneName = laneNameFromChannel(ch, marketByExposed);
        if (laneName && evictLaneKey(name, { name: laneName }, "gateway"))
          consola.info(
            `[${name}] cached key for ${laneName} evicted: gateway disabled it (${reason.reason.slice(0, 80)})`,
          );
      }
    }

    // Bare base: the test runner and new-api channel types append /v1/... themselves.
    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const keptLanes: MerchantLane[] = [];
    const probedLanes: MerchantLane[] = [];
    let pinsCreated = 0;
    let pinsRepinned = 0;
    let throttled = 0;

    const walkOrder = new WalkOrder(name);
    models.splice(0, models.length, ...walkOrder.sort(models));
    // A candidate whose rejection is still cached would only be keyed and
    // pinned to replay that rejection, so it is passed over. Its token stays
    // (probedLanes), like any rejected candidate's.
    const rejectedFromCache = (lane: MerchantLane): boolean => {
      const key = `${name}:${lane.listing.channel_id}|${lane.model}`;
      const verdict = getVerdict(key);
      if (verdict?.authenticityReason === REASONING_FAIL_REASON) return false;
      return isAuthenticityBlacklisted(key) || isTestFailFresh(verdict);
    };

    const loopStart = Date.now();
    const elapsed = () => `${Math.round((Date.now() - loopStart) / 1000)}s`;
    const deferredAt: number[] = [];
    const walkModel = async (
      mc: (typeof models)[number],
      modelIdx: number,
    ): Promise<void> => {
      if (Date.now() - loopStart >= WALK_BUDGET_MS) {
        deferredAt.push(modelIdx);
        return;
      }
      const modelStart = Date.now();
      if (!dryRun) walkOrder.markWalked(mc.model);
      // Walk the cheap-sorted candidates until `wanted` merchants pass their
      // probe: a faker/dead pick is REPLACED by the next candidate instead of
      // shrinking the lane set (opus-5 hit zero lanes that way: the cheapest 6
      // were all blacklisted fakers, and nothing behind them was ever tried).
      // Cached verdicts (a fresh pass, a fail inside TEST_FAIL_TTL_HOURS, an
      // authenticity fail) skip without an upstream request, so the walk only
      // pays for merchants nobody has probed lately.
      consola.info(
        `[${name}] ${modelIdx}/${models.length} ${mc.model}: ${mc.candidates.length} candidate(s), want ${mc.wanted} (${elapsed()} in)`,
      );
      const kept: {
        lane: MerchantLane;
        key: string;
        rateLimited: boolean;
        tools: boolean | null;
        serving: boolean;
      }[] = [];
      let serving = 0;
      let idx = 0;
      let probed = 0;
      let cachedRejects = 0;
      // A lane that fails the tool test still serves plain chat, and the
      // gateway sends tool requests only to lanes that passed it. When every
      // serving lane failed it (2026-11-09: five models, one merchant on all
      // its Gemini lanes), the walk keeps looking, one lane at a time inside
      // the probe cap, and a lane that passes replaces the dearest one that
      // failed.
      const needsToolLane = () =>
        !kept.some((k) => k.serving && k.tools === true) &&
        kept.some((k) => k.serving && k.tools === false);
      while (
        (serving < mc.wanted || needsToolLane()) &&
        idx < mc.candidates.length &&
        probed < A7_MAX_PROBES_PER_MODEL
      ) {
        const room = serving < mc.wanted ? mc.wanted - serving : 1;
        // A supplier struck on another model since the walk began is passed over.
        const batch: MerchantLane[] = [];
        while (
          batch.length < Math.min(room, A7_MAX_PROBES_PER_MODEL - probed) &&
          idx < mc.candidates.length
        ) {
          const listing = mc.candidates[idx++]!;
          if (strikes.isStruck(listing)) continue;
          const lane = { model: mc.model, listing };
          if (rejectedFromCache(lane)) {
            cachedRejects++;
            probedLanes.push(lane);
            continue;
          }
          batch.push(lane);
        }
        if (batch.length === 0) break;
        consola.info(
          `[${name}] ${mc.model}: keying ${batch.length} lane(s) (${batch.map((l) => l.listing.channel_id).join(", ")})`,
        );
        const keyStart = Date.now();
        const tokens = await ensureLaneTokens(provider, batch, { dryRun });
        consola.info(
          `[${name}] ${mc.model}: keyed ${tokens.size}/${batch.length} in ${Math.round((Date.now() - keyStart) / 1000)}s, pinning`,
        );
        const pinStart = Date.now();
        const pins = await ensurePins(provider, batch, tokens, dryRun);
        pinsCreated += pins.created;
        pinsRepinned += pins.repinned;
        throttled += pins.throttled;

        const probes: { lane: MerchantLane; key: string }[] = [];
        for (const lane of batch) {
          const token = tokens.get(laneTokenName(lane));
          // A missing key is a7 refusing the reveal (rate limit), never a
          // merchant verdict.
          if (!token) {
            throttled++;
            continue;
          }
          // No pin = the probe would hit smart routing (an arbitrary merchant
          // at an arbitrary price), not this lane's merchant. Never keep it.
          if (!pins.pinned.has(laneTokenName(lane))) continue;
          probes.push({ lane, key: token.key });
        }
        probed += probes.length;
        probedLanes.push(...probes.map((p) => p.lane));
        consola.info(
          `[${name}] ${mc.model}: pinned ${pins.pinned.size} in ${Math.round((Date.now() - pinStart) / 1000)}s (${pins.throttled} throttled), probing ${probes.length} lane(s)`,
        );
        // Probes run through the per-upstream gate; one lane per call, so
        // awaiting them in sequence made a 170-lane night take an hour.
        const probeLane = (lane: MerchantLane, key: string) =>
          testAndFilterModels({
            allModels: [lane.model],
            baseUrl,
            apiKey: key,
            channelType: CHANNEL_TYPES.OPENAI,
            // Per-merchant label: the verdict cache is keyed provider|model,
            // so a shared label would reuse one merchant's probe result (and
            // authenticity blacklist) for every merchant of the model.
            providerLabel: `${name}:${lane.listing.channel_id}`,
            testableModelTypes: new Set(["text"]),
            acceptRateLimited: provider.acceptRateLimited,
          });
        const rejectedStatus = (
          verdict: Awaited<ReturnType<typeof probeLane>>,
          model: string,
        ) => {
          const status = verdict.details?.find(
            (d) => d.model === model,
          )?.httpStatus;
          return status === 401 || status === 403;
        };
        const verdicts = await Promise.all(
          probes.map(async (probe) => {
            let verdict = await probeLane(probe.lane, probe.key);
            let key = probe.key;
            const laneName = laneTokenName(probe.lane);
            const token = tokens.get(laneName);
            // A 401 on a cached key is the cache being stale, not the merchant:
            // drop the key and the fail it just recorded, reveal, probe again.
            if (
              token?.cached &&
              verdict.workingModels.length === 0 &&
              rejectedStatus(verdict, probe.lane.model)
            ) {
              evictLaneKey(name, { name: laneName }, "probe");
              clearTestFail(
                `${name}:${probe.lane.listing.channel_id}|${probe.lane.model}`,
              );
              consola.warn(
                `[${name}] cached key for ${laneName} evicted: probe answered ${verdict.details?.[0]?.httpStatus}`,
              );
              const fresh = await ensureLaneTokens(provider, [probe.lane], {
                dryRun,
                forceReveal: new Set([laneName]),
              });
              const reKeyed = fresh.get(laneName);
              if (reKeyed) {
                key = reKeyed.key;
                probed++;
                verdict = await probeLane(probe.lane, key);
              }
            }
            if (
              verdict.workingModels.length === 0 &&
              rejectedStatus(verdict, probe.lane.model)
            )
              laneKeyStats(name).rejected++;
            return { probe: { lane: probe.lane, key }, verdict };
          }),
        );
        for (const { probe, verdict } of verdicts) {
          if (verdict.workingModels.length === 0) {
            if (strikes.noteVerdict(probe.lane.listing, probe.lane.model))
              consola.warn(
                `[${name}] supplier ${supplierKeyOf(probe.lane.listing)} struck on ${probe.lane.model} (#${probe.lane.listing.channel_id}): its other channels are dropped from this run`,
              );
            continue;
          }
          const tools =
            verdict.details?.find((d) => d.model === probe.lane.model)
              ?.toolCallSuccess ?? null;
          const exposed =
            config.modelMapping?.[probe.lane.model] ?? probe.lane.model;
          const isServing = !offLanes.has(
            laneKey(probe.lane.listing.channel_id, exposed),
          );
          // Past `wanted` only the tool search probes, so only a lane that
          // passes the tool test is worth a slot.
          if (isServing && serving >= mc.wanted) {
            if (tools !== true) continue;
            const failed = kept.findLastIndex(
              (k) => k.serving && k.tools === false,
            );
            if (failed < 0) continue;
            consola.info(
              `[${name}] ${mc.model}: ${probe.lane.listing.channel_id} passed the tool test, replacing ${kept[failed]!.lane.listing.channel_id}`,
            );
            kept.splice(failed, 1);
            serving--;
          }
          kept.push({
            lane: probe.lane,
            key: probe.key,
            rateLimited: verdict.rateLimitedModels.includes(probe.lane.model),
            tools,
            serving: isServing,
          });
          if (isServing) serving++;
        }
        const held = kept.length - serving;
        consola.info(
          `[${name}] ${mc.model}: kept ${serving}/${mc.wanted}${held > 0 ? ` (+${held} held, gateway disabled)` : ""}, probed ${probed}, ${mc.candidates.length - idx} candidate(s) left`,
        );
      }
      if (
        serving < mc.wanted &&
        probed >= A7_MAX_PROBES_PER_MODEL &&
        idx < mc.candidates.length
      )
        consola.warn(
          `[${name}] ${mc.model}: probe cap of ${A7_MAX_PROBES_PER_MODEL} reached with ${serving}/${mc.wanted} serving, ${mc.candidates.length - idx} candidate(s) left for the next run`,
        );
      if (needsToolLane())
        consola.warn(
          `[${name}] ${mc.model}: no lane passed the tool test, so tool requests to it fail`,
        );
      const toolLanes = kept.filter((k) => k.tools === true).length;
      consola.info(
        `[${name}] ${mc.model} done: ${kept.length} lane(s) (${toolLanes} with tools) in ${Math.round((Date.now() - modelStart) / 1000)}s, ${cachedRejects} cached reject(s) skipped, ${models.length - modelIdx} model(s) left`,
      );
      if (kept.length > 0) keptByModel.push({ mc, kept });
    };
    // Models walk side by side; every probe still passes the per-upstream gate,
    // so the load on a7 stays capped while one slow merchant no longer idles the rest.
    const keptByModel: {
      mc: (typeof models)[number];
      kept: { lane: MerchantLane; key: string; rateLimited: boolean }[];
    }[] = [];
    const walkLimit = pLimit(A7_MODEL_PARALLEL);
    await Promise.all(
      models.map((mc, i) => walkLimit(() => walkModel(mc, i + 1))),
    );
    if (!dryRun) walkOrder.save();

    // A supplier struck on a later model loses the lanes it passed earlier in
    // the walk too. Offers are built only now, from what is left.
    let struckLanes = 0;
    const finalKept: { lane: MerchantLane; key: string }[] = [];
    for (const { mc, kept: all } of keptByModel) {
      const kept = all.filter((k) => !strikes.isStruck(k.lane.listing));
      finalKept.push(...kept);
      for (const k of all)
        if (strikes.isStruck(k.lane.listing))
          consola.warn(
            `[${name}] ${k.lane.model}: dropped #${k.lane.listing.channel_id}, supplier ${supplierKeyOf(k.lane.listing)} struck on ${strikes
              .strikesFor(k.lane.listing)
              .map((s) => s.model)
              .join(", ")}`,
          );
      struckLanes += all.length - kept.length;
      if (kept.length === 0) continue;
      keptLanes.push(...kept.map((k) => k.lane));

      // Cheapest KEPT lane per model gets the plain channel; the rest are
      // failover duplicates so capAbove1x does not delete them as pricier copies.
      // AdoRouter: cheapest by cost share of list on the dearer side, which is
      // what the lane is priced on.
      const costOf = (l: Listing) =>
        mc.list ? costShareOfList(l, mc.list) : l.input_price_micros;
      const cheapest = Math.min(...kept.map((k) => costOf(k.lane.listing)));
      for (const k of kept)
        offers.push(
          buildLaneOffer(
            provider,
            config,
            baseUrl,
            k.lane,
            k.key,
            k.rateLimited,
            costOf(k.lane.listing) === cheapest,
            mc.canonicalListUsd,
          ),
        );
    }
    const newStrikes = strikes.newStrikes();
    if (strikes.enabled)
      consola.info(
        `[${name}] supplier strikes: ${newStrikes.length} new, ${struckLanes} passing lane(s) dropped`,
      );
    if (!dryRun && newStrikes.length > 0) strikes.save();
    // After the walk, on its own budget, so it never delays a model's probes.
    if (!dryRun && provider.numberFingerprint)
      await runNumberFingerprints(
        name,
        finalKept.map((k) => ({
          key: `${name}:${k.lane.listing.channel_id}|${k.lane.model}`,
          model: k.lane.model,
          baseUrl,
          apiKey: k.key,
        })),
        provider.numberFingerprint,
      );
    if (deferredAt.length > 0) {
      const deferred = deferredAt
        .sort((a, b) => a - b)
        .map((i) => models[i - 1]!.model);
      for (const m of deferred) {
        unverifiedMarket.add(m);
        (report.unverifiedModels ??= []).push(
          (config.modelMapping?.[m] ?? m).toLowerCase(),
        );
      }
      consola.warn(
        t("CORE.A7.WALK_BUDGET", {
          provider: name,
          elapsed: elapsed(),
          count: deferred.length,
          models: deferred.join(", "),
        }),
      );
    }

    consola.info(`[${name}] pins: +${pinsCreated} ~${pinsRepinned}`);
    const keys = laneKeyStats(name);
    report.laneKeys = { ...keys };
    consola.info(
      `[${name}] keys: ${keys.cached} cached, ${keys.revealed} revealed, ${keys.evictedProbe} evicted (probe), ${keys.evictedGateway} evicted (gateway), ${keys.rejected} rejected`,
    );
    extraGroups = sweepLiveLanes(provider, config, ctx, byModel);
    report.groups = offers.length;
    report.models = new Set(keptLanes.map((l) => l.model)).size;
    // A throttled full run must not delete: every skipped lane is absent from
    // desired, so apply would remove healthy channels and their tokens. The
    // provider drops out of the delete set and the stale-token cleanup is
    // withheld; a handful of lanes losing their key is ordinary a7 pacing, so
    // only a walk that lost most of them is reported as a failed run.
    if (throttled > 0 && !skipCleanup && !dryRun) {
      report.deletesWithheld = true;
      report.error = `a7 throttled: ${throttled} lane(s) skipped on key reveal or pin (429); deletes and token cleanup withheld`;
      consola.warn(`[${name}] ${report.error}`);
      report.success =
        keptLanes.length > 0 &&
        throttled <= (keptLanes.length + throttled) * THROTTLE_FAIL_RATIO;
      return {
        report,
        offers,
        endpointMetadata: { endpointPaths: new Map() },
        extraGroups,
      };
    }
    if (!dryRun && !skipCleanup)
      await cleanupStaleLaneTokens(
        provider,
        keptLanes,
        probedLanes,
        unverifiedMarket,
      );
    report.success = true;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }

  return {
    report,
    offers,
    endpointMetadata: { endpointPaths: new Map() },
    extraGroups,
  };
}

function buildLaneOffer(
  provider: A7ProviderConfig,
  config: RuntimeConfig,
  baseUrl: string,
  lane: MerchantLane,
  apiKey: string,
  rateLimited: boolean,
  isCheapest: boolean,
  canonicalListUsd?: number,
): UpstreamOffer {
  const name = provider.name;
  const input = usdPerMillion(lane.listing.input_price_micros);
  const output = usdPerMillion(lane.listing.output_price_micros);
  const upstreamRatio = input / USD_PER_M_PER_RATIO;
  const model: OfferModel = {
    exposed: (config.modelMapping?.[lane.model] ?? lane.model).toLowerCase(),
    upstream: lane.model,
    modelType: inferModelType(lane.model),
    upstreamRatio,
    upstreamCompletionRatio: input > 0 ? output / input : 1,
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(isCheapest ? {} : { failoverDuplicate: true }),
  };

  // Same shape as openrouter's per-host lanes: bake profitMultiple into
  // groupRatio and resolve adj to 0, so retail = upstreamRatio *
  // profitMultiple per lane WITHOUT the markup-override path. A per-model
  // positive adj would make this lane own the shared model sticker
  // (ModelRatio), which for a multi-source model (open1/pol also serve
  // kimi-k3) collapses everyone's sticker to a7's cheapest merchant cost.
  const multiple = laneMultiple(
    provider,
    lane.model,
    lane.listing.channel_id,
    output,
    canonicalListUsd,
  );

  // AdoRouter: lanes are named <provider>-<listing id>-<model>, for example
  // m1-1234-gemini-4-argon. Group and channel names are public, so the
  // merchant's name stays out of them; the channel remark keeps it for admins.
  const laneId = `${lane.listing.channel_id}`;
  const vendor = inferVendorFromModelName(lane.model) ?? "unknown";
  return {
    provider: name,
    providerKind: "a7",
    group: `${vendor}-${laneId}`,
    sanitizedBase: sanitizeGroupName(`${name}-${laneId}`),
    vendor,
    channelType: CHANNEL_TYPES.OPENAI,
    baseUrl,
    apiKey,
    groupRatio: multiple,
    channelRemark: [
      `${lane.model} via ${name} merchant ${lane.listing.supplier_name} (#${lane.listing.channel_id})`,
      lane.listing.channel_name,
      lane.listing.description,
      lane.listing.smart_routing_labels?.join("/"),
    ]
      .filter(Boolean)
      .join(" | "),
    models: [model],
    priceAdjustment: { default: 0 },
    defaultAdjustment: 0,
  };
}
