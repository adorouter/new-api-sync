import { describe, expect, test } from "bun:test";
import type { A7ProviderConfig } from "@core/validations/config";
import { costShareOfList, selectMerchants, type Listing } from "./marketplace";

// AdoRouter: m1 lanes sell at 2x the merchant's cost and at most 80% of list,
// on input and output both.
const provider = {
  type: "a7",
  name: "m1",
  profitMultiple: 2,
  maxSellFraction: 0.8,
} as unknown as A7ProviderConfig;

const list = { inputUsd: 1, outputUsd: 4 };

const listing = (id: number, inUsd: number, outUsd: number): Listing => ({
  channel_id: id,
  listing_id: id,
  supplier_name: "",
  channel_name: "",
  description: "",
  smart_routing_labels: [],
  model_name: "m",
  charge_type: "per_token",
  listing_availability: 1,
  supplier_channel_disabled: false,
  user_channel_disabled: false,
  authenticity_guaranteed: false,
  input_price_micros: inUsd * 1e6,
  output_price_micros: outUsd * 1e6,
  recent_success_rate: 10000,
  sample_count: 0,
});

describe("costShareOfList", () => {
  test("takes the dearer side", () => {
    expect(costShareOfList(listing(1, 0.05, 1.6), list)).toBeCloseTo(0.4);
    expect(costShareOfList(listing(1, 0.3, 0.4), list)).toBeCloseTo(0.3);
  });
});

describe("selectMerchants", () => {
  test("caps input and output at 80% of list after the 2x", () => {
    const ids = selectMerchants(
      "m",
      [
        listing(1, 0.1, 0.4), // 10% on both sides: kept
        listing(2, 0.05, 1.7), // cheap input, output at 42.5%: sells above 80%
        listing(3, 0.45, 0.4), // output fine, input at 45%: sells above 80%
      ],
      provider,
      list,
    ).map((l) => l.channel_id);
    expect(ids).toEqual([1]);
  });

  test("ranks merchants on the dearer side, not on input alone", () => {
    const ids = selectMerchants(
      "m",
      [
        listing(1, 0.01, 1.2), // input 1%, output 30%
        listing(2, 0.2, 0.8), // 20% on both sides
      ],
      provider,
      list,
    ).map((l) => l.channel_id);
    expect(ids).toEqual([2, 1]);
  });

  test("without a list price, keeps every merchant cheapest input first", () => {
    const ids = selectMerchants(
      "m",
      [listing(1, 0.3, 9), listing(2, 0.1, 9)],
      provider,
      undefined,
    ).map((l) => l.channel_id);
    expect(ids).toEqual([2, 1]);
  });
});
