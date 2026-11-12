import { describe, expect, test } from "bun:test";
import {
  confidentOther,
  fingerprintReject,
  type NumberFingerprintRecord,
} from "./number-fingerprint";

const DAY = 86_400_000;

const reading = (
  over: Partial<NumberFingerprintRecord> & { complete?: number },
): NumberFingerprintRecord => {
  const complete = over.complete ?? 3;
  return {
    at: "2026-11-09T09:00:00.000Z",
    model: "claude-opus-4-8",
    claimed: "claude-opus-4.8",
    claimedFamily: "claude",
    verdict: "family-match",
    decision: "scored",
    prediction: "claude-haiku-4.5",
    family: "claude",
    probability: 1,
    top: [],
    effort: "low",
    samples: [0, 1, 2].map((i) => ({
      state: i < complete ? ("complete" as const) : ("truncated" as const),
      count: 300,
      expected: 300,
      responseModel: null,
      responseId: null,
      error: null,
    })),
    error: null,
    bank: "",
    ...over,
  };
};

const later = (r: NumberFingerprintRecord, days = 7) =>
  new Date(Date.parse(r.at) + days * DAY).toISOString();

describe("confidentOther", () => {
  test("a Claude lane reading as a lower tier counts", () => {
    expect(confidentOther(reading({}))).toBe("claude-haiku-4.5");
  });

  test("another version of the same Claude tier does not", () => {
    const r = reading({
      model: "claude-sonnet-5",
      claimed: "claude-sonnet-5",
      prediction: "claude-sonnet-4.6",
      probability: 0.98,
    });
    expect(confidentOther(r)).toBeNull();
  });

  test("another family counts for Claude too", () => {
    const r = reading({ prediction: "mimo-v2.5", family: "mimo" });
    expect(confidentOther(r)).toBe("mimo-v2.5");
  });

  test("a sibling counts for other makers", () => {
    const r = reading({
      model: "gpt-5.6-terra",
      claimed: "gpt-5.6-terra",
      claimedFamily: "gpt",
      prediction: "gpt-5.6-luna",
      family: "gpt",
    });
    expect(confidentOther(r)).toBe("gpt-5.6-luna");
  });

  test("weak, partial, short or unbanked readings never count", () => {
    expect(confidentOther(reading({ probability: 0.94 }))).toBeNull();
    expect(confidentOther(reading({ decision: "partial" }))).toBeNull();
    expect(confidentOther(reading({ complete: 1 }))).toBeNull();
    expect(confidentOther(reading({ claimed: null }))).toBeNull();
    expect(
      confidentOther(reading({ prediction: "claude-opus-4.8" })),
    ).toBeNull();
  });
});

describe("fingerprintReject", () => {
  test("rejects when two runs agree", () => {
    const first = reading({});
    const second = reading({ at: later(first) });
    expect(fingerprintReject(second, first)).toStartWith("number-fingerprint:");
  });

  test("one reading is never enough", () => {
    expect(fingerprintReject(reading({}), undefined)).toBeNull();
  });

  test("a clean earlier reading clears it", () => {
    const first = reading({ prediction: "claude-opus-4.8", verdict: "match" });
    expect(fingerprintReject(reading({ at: later(first) }), first)).toBeNull();
  });

  test("readings from the same run do not count twice", () => {
    const first = reading({});
    expect(
      fingerprintReject(reading({ at: later(first, 0.1) }), first),
    ).toBeNull();
  });

  test("two runs pointing at different families do not agree", () => {
    const first = reading({ prediction: "kimi-k3", family: "kimi" });
    const second = reading({ at: later(first) });
    expect(fingerprintReject(second, first)).toBeNull();
  });
});
