import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const evaluationToken = process.env.REWRITE_EVALUATION_TOKEN;
const evaluationUrl =
  process.env.REWRITE_EVALUATION_URL ?? 'https://watermarklens.com/api/v1/rewrite';
const requiredPassRate = 0.95;

if (!evaluationToken) {
  throw new Error('REWRITE_EVALUATION_TOKEN is required.');
}

const fixturePath = resolve(import.meta.dirname, '../tests/fixtures/rewrite-evaluation.json');
const evaluationCases = JSON.parse(await readFile(fixturePath, 'utf8'));
const failedIds = [];

for (const evaluationCase of evaluationCases) {
  const response = await fetch(evaluationUrl, {
    body: JSON.stringify({ text: evaluationCase.text }),
    headers: {
      authorization: `Bearer ${evaluationToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    method: 'POST',
    signal: AbortSignal.timeout(45_000),
  });
  const responseBody = await response.json().catch(() => null);
  const rewrittenText = responseBody?.data?.text;
  const preservedAnchors =
    response.ok &&
    typeof rewrittenText === 'string' &&
    evaluationCase.anchors.every((anchor) => rewrittenText.includes(anchor));

  if (!preservedAnchors) {
    failedIds.push(evaluationCase.id);
  }
}

const passedCases = evaluationCases.length - failedIds.length;
const passRate = passedCases / evaluationCases.length;

console.log(
  JSON.stringify({
    failedIds,
    passRate,
    passedCases,
    requiredPassRate,
    totalCases: evaluationCases.length,
  }),
);

if (passRate < requiredPassRate) {
  process.exitCode = 1;
}
