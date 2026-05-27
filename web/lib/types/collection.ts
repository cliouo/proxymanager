/**
 * Convenience re-export. The Zod-derived Collection type in `@/schemas`
 * is the single source of truth; this file stays as a stable import path
 * for the UI (was here before the Zod schema landed).
 */
export type { Collection, CollectionGroupType } from '@/schemas';
