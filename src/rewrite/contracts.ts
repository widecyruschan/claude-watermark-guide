import { z } from 'zod';

export const REWRITE_MAX_CHARACTERS = 20_000;
export const REWRITE_MAX_BODY_BYTES = 100 * 1024;

export function countUnicodeCharacters(text: string): number {
  return [...text].length;
}

const rewriteTextSchema = z
  .string()
  .transform((text) => text.trim())
  .pipe(
    z
      .string()
      .min(1)
      .refine((text) => countUnicodeCharacters(text) <= REWRITE_MAX_CHARACTERS),
  );

export const rewriteInputSchema = z
  .object({
    text: rewriteTextSchema,
  })
  .strict();

export type RewriteInput = z.infer<typeof rewriteInputSchema>;

export interface RewriteProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
