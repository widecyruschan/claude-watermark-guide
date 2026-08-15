import { describe, expect, it } from 'vitest';

import { calculateEbondAiCostMicrousd } from '../../src/rewrite/cost';

describe('EBond usage cost', () => {
  it('calculates input and output cost in whole micro-US dollars', () => {
    expect(calculateEbondAiCostMicrousd(1_000_000, 1_000_000)).toBe(4_200_000);
    expect(calculateEbondAiCostMicrousd(250, 125)).toBe(600);
    expect(calculateEbondAiCostMicrousd(1, 1)).toBe(4);
  });

  it('rejects invalid token usage', () => {
    expect(() => calculateEbondAiCostMicrousd(-1, 1)).toThrow('INVALID_TOKEN_USAGE');
    expect(() => calculateEbondAiCostMicrousd(1.5, 1)).toThrow('INVALID_TOKEN_USAGE');
  });
});
