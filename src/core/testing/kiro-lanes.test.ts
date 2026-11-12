import { describe, expect, test } from "bun:test";
import { kiroRejectReason } from "./kiro-lanes";
import { isAuthenticityFailFresh } from "./verdict-cache";

describe("kiroRejectReason", () => {
  test("a lane that introduces itself as Kiro", () => {
    expect(
      kiroRejectReason([
        "anthropic",
        "Hey. I'm Kiro, your AI development environment.",
      ]),
    ).toBe("kiro-wrapper: answers as Kiro");
  });

  test("other lanes pass, wrapped or not", () => {
    expect(
      kiroRejectReason([
        "anthropic",
        "claude-opus-5-5",
        "none",
        "you are claude code, anthropic's official cli",
        "i am gemini, answering through antigravity",
        "kirov, kirosene",
      ]),
    ).toBeUndefined();
  });

  test("the fail keeps the lane out for 30 days", () => {
    const entry = {
      key: "m1:1|model",
      authenticity: "fail" as const,
      authenticityReason: "kiro-wrapper: answers as Kiro",
      authFailedAt: new Date(Date.now() - 29 * 24 * 3_600_000).toISOString(),
      since: "2026-11-01",
    };
    expect(isAuthenticityFailFresh(entry)).toBe(true);
  });
});
