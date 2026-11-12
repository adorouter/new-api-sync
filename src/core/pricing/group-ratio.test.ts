import { describe, expect, test } from "bun:test";
import { publishedGroupRatio } from "./group-ratio";

describe("publishedGroupRatio", () => {
  test("a positive ratio never publishes as free", () => {
    expect(publishedGroupRatio(0.00004)).toBe(0.0001);
    expect(publishedGroupRatio(1e-9)).toBe(0.0001);
  });

  test("rounds up to 4 decimals, never under the computed price", () => {
    expect(publishedGroupRatio(0.01534)).toBe(0.0154);
    expect(publishedGroupRatio(0.0258)).toBe(0.0258);
    expect(publishedGroupRatio(0.0154)).toBe(0.0154);
    expect(publishedGroupRatio(0.1 + 0.2)).toBe(0.3);
    expect(publishedGroupRatio(1.25)).toBe(1.25);
  });

  test("zero stays zero", () => {
    expect(publishedGroupRatio(0)).toBe(0);
  });
});
