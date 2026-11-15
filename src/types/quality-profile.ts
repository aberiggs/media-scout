import { z } from 'zod';

interface QualityItem {
  name?: string | null; allowed?: boolean; quality?: { name?: string | null } | null; items?: QualityItem[];
}
const item: z.ZodType<QualityItem> = z.lazy(() => z.object({
  name: z.string().nullable().optional(), allowed: z.boolean().optional(),
  quality: z.object({ name: z.string().nullable().optional() }).nullable().optional(), items: z.array(item).optional(),
}));
export const qualityProfileSchema = z.object({
  id: z.number().int(), name: z.string().nullable(), items: z.array(item).optional(),
  quality: z.object({ name: z.string().optional() }).optional(),
  formatItems: z.array(z.object({ name: z.string().nullable().optional(), score: z.number().optional() })).optional(),
});
export type QualityProfile = z.infer<typeof qualityProfileSchema>;
export const qualityProfileListSchema = z.array(qualityProfileSchema);

export function summarizeProfile(value: unknown): { qualities?: string[]; customFormats?: string[]; unknown: boolean } {
  const parsed = qualityProfileSchema.partial({ id: true, name: true }).safeParse(value);
  if (!parsed.success) return { unknown: true };
  const names = (items: QualityItem[]): string[] => items.flatMap(i => i.allowed === false ? [] : i.items?.length ? names(i.items) : i.quality?.name ? [i.quality.name] : []);
  const qualities = names(parsed.data.items ?? []);
  if (parsed.data.quality?.name) qualities.push(parsed.data.quality.name);
  const customFormats = (parsed.data.formatItems ?? []).flatMap(item => item.name ? [`${item.name}${item.score === undefined ? '' : ` (${item.score})`}`] : []);
  return { ...(qualities.length ? { qualities } : {}), ...(customFormats.length ? { customFormats } : {}), unknown: !qualities.length && !customFormats.length };
}
