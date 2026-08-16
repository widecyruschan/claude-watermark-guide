import { describe, expect, it } from 'vitest';

import { calculateWenwenCostMicrousd } from '../../src/rewrite/cost';

describe('Wenwen usage cost', () => {
  it('calculates input and output cost in whole micro-US dollars', () => {
    expect(calculateWenwenCostMicrousd(1_000_000, 1_000_000)).toBe(3_500_000);
    expect(calculateWenwenCostMicrousd(250, 125)).toBe(500);
    expect(calculateWenwenCostMicrousd(1, 1)).toBe(4);
  });

  it('rejects invalid token usage', () => {
    expect(() => calculateWenwenCostMicrousd(-1, 1)).toThrow('INVALID_TOKEN_USAGE');
    expect(() => calculateWenwenCostMicrousd(1.5, 1)).toThrow('INVALID_TOKEN_USAGE');
  });
});
