// A resold Kiro seat runs the model inside Kiro: it bills Kiro's system prompt
// (about 9,600 tokens) on every request and introduces itself as Kiro, which
// tells the customer where the lane comes from. Other wrapped lanes are allowed.

export const KIRO_FAIL_PREFIX = "kiro-wrapper";

const KIRO = /(?<![a-z0-9])kiro(?![a-z0-9])/;

/** The fail reason when a self description names Kiro, else undefined. */
export function kiroRejectReason(
  selfDescriptions: readonly (string | null | undefined)[],
): string | undefined {
  return selfDescriptions.some((a) => KIRO.test((a ?? "").toLowerCase()))
    ? `${KIRO_FAIL_PREFIX}: answers as Kiro`
    : undefined;
}
