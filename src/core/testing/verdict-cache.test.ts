import { describe, expect, test } from "bun:test";
import { isAuthenticityFailFresh, type VerdictEntry } from "./verdict-cache";

const HOUR = 3_600_000;

const failedAgo = (reason: string, hours: number): VerdictEntry => ({
  key: "m1:1|model",
  authenticity: "fail",
  authenticityReason: reason,
  authFailedAt: new Date(Date.now() - hours * HOUR).toISOString(),
  since: "2026-11-01",
});

describe("isAuthenticityFailFresh", () => {
  test("hard evidence keeps a lane out for 30 days", () => {
    for (const reason of [
      "substituted:glm-5",
      "served-model-mismatch: requested claude-opus-5, response model claude-haiku-4-5",
      "tokenizer-family: billed 101/61/101/120, the deepseek vocabulary",
      "masked-identity: told to hide its backend",
      "number-fingerprint: sold as claude-opus-4.8, answers like claude-haiku-4.5",
    ]) {
      expect(isAuthenticityFailFresh(failedAgo(reason, 29 * 24))).toBe(true);
      expect(isAuthenticityFailFresh(failedAgo(reason, 31 * 24))).toBe(false);
    }
  });

  test("other fails still expire after a day", () => {
    for (const reason of [
      "fake-200: platform refusal sent as the reply",
      "thinking-ignored: asked for high effort",
      'canned reply: "orcaterm"',
    ]) {
      expect(isAuthenticityFailFresh(failedAgo(reason, 23))).toBe(true);
      expect(isAuthenticityFailFresh(failedAgo(reason, 25))).toBe(false);
    }
  });
});
