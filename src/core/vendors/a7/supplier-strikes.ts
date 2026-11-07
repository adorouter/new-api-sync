// AdoRouter: a supplier caught selling one model as another, or making up its
// token counts, loses every lane it sells. The probes judge one model at a time,
// and on 2026-11-07 suppliers caught on one Claude model still kept lanes on
// others: the probes simply did not catch them twice. A supplier runs several
// marketplace channels (one id per listing group), so the strike is held per
// supplier and applies to all of its channels.

import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import {
  getVerdict,
  isAuthenticityFailFresh,
} from "@core/testing/verdict-cache";
import { join } from "path";
import type { Listing } from "./marketplace";

// Long enough that a supplier is not back on the next walk, short enough that a
// marketplace channel id reused by someone else is not banned forever.
export const SUPPLIER_STRIKE_TTL_DAYS = 30;

// Reasons that mean the lane is not the model sold, or that its usage, and so
// its bill, is invented. A platform refusal (fake-200), a canned notice or a
// thinking model run without thinking is a bad lane, not proof the supplier
// cheats on its other models.
const SEVERE_RULES = [
  "substituted",
  "served-model-mismatch",
  "censored-history",
  "tokenizer-family",
  "masked-identity",
] as const;

// A preview or alias answered by its own dated build is the same model.
const sameBase = (asked: string, served: string): boolean => {
  const base = (m: string) =>
    m
      .toLowerCase()
      .replace(/^.*\//, "")
      .replace(/-(preview|latest|exp)$/, "")
      .replace(/-\d{4,8}$/, "");
  return base(asked) === base(served);
};

export function isSevereReason(reason: string, model: string): boolean {
  const rule = SEVERE_RULES.find((r) => reason.startsWith(r));
  if (!rule) return false;
  if (rule === "substituted") {
    const served = reason.slice("substituted:".length).trim();
    return served !== "" && !sameBase(model, served);
  }
  return true;
}

/** The marketplace's supplier id when the listing carries one, else the channel. */
export function supplierKeyOf(listing: Listing): string {
  return typeof listing.supplier_id === "number" && listing.supplier_id > 0
    ? `s${listing.supplier_id}`
    : `c${listing.channel_id}`;
}

export interface SupplierStrike {
  channelId: number;
  model: string;
  reason: string;
  at: string;
}

type Ledger = Record<string, SupplierStrike[]>;

const ledgerPath = (provider: string) =>
  join(logsDir(), `supplier-strikes-${provider}.json`);

const fresh = (s: SupplierStrike) =>
  Date.now() - Date.parse(s.at) < SUPPLIER_STRIKE_TTL_DAYS * 86_400_000;

export class SupplierStrikes {
  private readonly ledger: Ledger;
  private readonly added: { key: string; strike: SupplierStrike }[] = [];

  constructor(private readonly provider: string) {
    const raw = readJson<Ledger>(ledgerPath(provider)) ?? {};
    this.ledger = {};
    for (const [key, strikes] of Object.entries(raw)) {
      const kept = (strikes ?? []).filter(fresh);
      if (kept.length > 0) this.ledger[key] = kept;
    }
  }

  isStruck(listing: Listing): boolean {
    return (this.ledger[supplierKeyOf(listing)]?.length ?? 0) > 0;
  }

  strikesFor(listing: Listing): SupplierStrike[] {
    return this.ledger[supplierKeyOf(listing)] ?? [];
  }

  /**
   * Records a strike when the lane's verdict is a fresh authenticity fail for a
   * severe reason. Returns true when this call struck a supplier that was clean.
   */
  noteVerdict(listing: Listing, model: string): boolean {
    const entry = getVerdict(`${this.provider}:${listing.channel_id}|${model}`);
    if (!entry || !isAuthenticityFailFresh(entry)) return false;
    const reason = entry.authenticityReason ?? "";
    if (!isSevereReason(reason, model)) return false;
    const key = supplierKeyOf(listing);
    const list = (this.ledger[key] ??= []);
    const wasClean = list.length === 0;
    if (
      list.some((s) => s.channelId === listing.channel_id && s.model === model)
    )
      return false;
    const strike: SupplierStrike = {
      channelId: listing.channel_id,
      model,
      reason: reason.slice(0, 200),
      at: entry.authFailedAt ?? new Date().toISOString(),
    };
    list.push(strike);
    this.added.push({ key, strike });
    return wasClean;
  }

  /** Strikes recorded since load, for the run log. */
  newStrikes(): readonly { key: string; strike: SupplierStrike }[] {
    return this.added;
  }

  save(): void {
    writeJsonAtomic(ledgerPath(this.provider), this.ledger, { pretty: true });
  }
}
