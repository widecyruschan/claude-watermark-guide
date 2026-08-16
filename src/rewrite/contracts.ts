import { z } from 'zod';

export const REWRITE_MAX_CHARACTERS = 20_000;
export const REWRITE_MAX_BODY_BYTES = 100 * 1024;
export const REWRITE_TONES = ['neutral', 'professional', 'friendly', 'concise'] as const;
export const REWRITE_FORMALITY_LEVELS = ['low', 'medium', 'high'] as const;
export const REWRITE_STRENGTH_LEVELS = ['low', 'medium', 'high'] as const;

export type RewriteTone = (typeof REWRITE_TONES)[number];
export type RewriteFormalityLevel = (typeof REWRITE_FORMALITY_LEVELS)[number];
export type RewriteStrengthLevel = (typeof REWRITE_STRENGTH_LEVELS)[number];

export interface RewriteOptions {
  formality: RewriteFormalityLevel;
  strength: RewriteStrengthLevel;
  tone: RewriteTone;
}

export const DEFAULT_REWRITE_OPTIONS: RewriteOptions = {
  formality: 'medium',
  strength: 'medium',
  tone: 'neutral',
};

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

const rewriteOptionsSchema = z
  .object({
    formality: z.enum(REWRITE_FORMALITY_LEVELS),
    strength: z.enum(REWRITE_STRENGTH_LEVELS),
    tone: z.enum(REWRITE_TONES),
  })
  .strict();

export const rewriteInputSchema = z
  .object({
    options: rewriteOptionsSchema.default(DEFAULT_REWRITE_OPTIONS),
    text: rewriteTextSchema,
  })
  .strict();

export type RewriteInput = z.infer<typeof rewriteInputSchema>;

export interface RewriteProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
