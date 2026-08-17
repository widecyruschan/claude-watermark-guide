import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Regression: ISSUE-002 — Free Checker calculated results but kept the result container hidden
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-watermarklens-com-2026-08-15.md
describe('Free Checker browser script', () => {
  it('reveals result and validation states after the check button is clicked', async () => {
    const script = await readFile(new URL('../js/checker.js', import.meta.url), 'utf8');
    const input = { value: 'Normal sample text' };
    const result = { className: 'result', hidden: true, innerHTML: '', textContent: '' };
    let clickHandler: (() => void) | undefined;
    const checkButton = {
      addEventListener: (_event: string, handler: () => void) => {
        clickHandler = handler;
      },
    };
    const elements = new Map<string, unknown>([
      ['checkBtn', checkButton],
      ['input', input],
      ['result', result],
    ]);
    const document = {
      addEventListener: (_event: string, handler: () => void) => handler(),
      getElementById: (id: string) => elements.get(id),
    };

    runInNewContext(script, { document, Set });
    expect(clickHandler).toBeTypeOf('function');

    clickHandler?.();
    expect(result.hidden).toBe(false);
    expect(result.className).toBe('result not');
    expect(result.innerHTML).toContain('No inspected artifacts found');

    input.value = '   ';
    clickHandler?.();
    expect(result.hidden).toBe(false);
    expect(result.className).toBe('result error');
    expect(result.textContent).toContain('please paste some text');
  });
});
