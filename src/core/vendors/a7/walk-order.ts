// AdoRouter: the walk reaches about 30 models inside its time budget, and the
// marketplace lists them in the same order every run, so the models behind the
// budget were never walked (2026-11-08: 69 of 99). Each run now starts with
// the models walked longest ago, and models never walked go first of all.

import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import { getVerdict } from "@core/testing/verdict-cache";
import { join } from "path";
import type { Listing } from "./marketplace";

type Ledger = Record<string, string>;

const ledgerPath = (provider: string) =>
  join(logsDir(), `walk-order-${provider}.json`);

const latest = (...stamps: (string | undefined)[]): number =>
  Math.max(-1, ...stamps.map((s) => (s ? Date.parse(s) || 0 : -1)));

export class WalkOrder {
  private readonly ledger: Ledger;

  constructor(private readonly provider: string) {
    this.ledger = readJson<Ledger>(ledgerPath(provider)) ?? {};
  }

  // A model missing from the ledger falls back to its newest probe verdict, so
  // the order is right from the first run that keeps a ledger.
  private walkedAt(model: string, candidates: Listing[]): number {
    const stamp = this.ledger[model];
    if (stamp) return Date.parse(stamp) || 0;
    let at = -1;
    for (const c of candidates) {
      const v = getVerdict(`${this.provider}:${c.channel_id}|${model}`);
      if (v)
        at = Math.max(
          at,
          latest(v.verifiedAt, v.authFailedAt, v.testedAt, v.failedAt),
        );
    }
    return at;
  }

  /** Never walked first, then oldest walk first; ties keep the market's order. */
  sort<T extends { model: string; candidates: Listing[] }>(models: T[]): T[] {
    return models
      .map((m, i) => ({ m, i, at: this.walkedAt(m.model, m.candidates) }))
      .sort((a, b) => a.at - b.at || a.i - b.i)
      .map((x) => x.m);
  }

  markWalked(model: string): void {
    this.ledger[model] = new Date().toISOString();
  }

  save(): void {
    writeJsonAtomic(ledgerPath(this.provider), this.ledger, { pretty: true });
  }
}
