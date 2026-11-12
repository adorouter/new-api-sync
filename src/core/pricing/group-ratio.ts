// AdoRouter: a group ratio is published with 4 decimals, rounded up. Rounding
// to the nearest sold a lane under 0.00005 for free (gpt-4o-mini at ratio 0)
// and every other lane slightly under its computed price.
export function publishedGroupRatio(ratio: number): number {
  if (!(ratio > 0)) return Math.round(ratio * 10000) / 10000;
  // The tolerance keeps float noise (0.0154 * 10000 = 154.00000000000003)
  // from adding a step.
  return Math.ceil(ratio * 10000 - 1e-6) / 10000;
}
