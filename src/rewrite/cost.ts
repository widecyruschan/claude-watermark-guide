const INPUT_COST_TENTHS_OF_MICROUSD = 6n;
const OUTPUT_COST_TENTHS_OF_MICROUSD = 36n;
const TENTHS_PER_MICROUSD = 10n;

export function calculateEbondAiCostMicrousd(inputTokens: number, outputTokens: number): number {
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    throw new Error('INVALID_TOKEN_USAGE');
  }

  const costTenths =
    BigInt(inputTokens) * INPUT_COST_TENTHS_OF_MICROUSD +
    BigInt(outputTokens) * OUTPUT_COST_TENTHS_OF_MICROUSD;
  const roundedCost = (costTenths + TENTHS_PER_MICROUSD / 2n) / TENTHS_PER_MICROUSD;

  if (roundedCost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('INVALID_TOKEN_USAGE');
  }

  return Number(roundedCost);
}
