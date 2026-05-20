import { z } from 'zod';

export const SettingsSchema = z.object({
  /** ProxyManager backend origin, e.g. https://proxymanager.vercel.app */
  backendUrl: z.string().url().or(z.literal('')),
  /** ADMIN_KEY bearer token */
  adminKey: z.string(),
  /** Clash External Controller URL, e.g. http://localhost:9090 */
  clashUrl: z.string().url().or(z.literal('')),
  /** Clash controller secret (Authorization: Bearer …) — optional */
  clashSecret: z.string(),
  /** proxy-group names to compare during speedtest */
  candidateGroups: z.array(z.string()),
  /** default anchor for written rules */
  defaultAnchor: z.string(),
  /** default rule type for write */
  defaultRuleType: z.enum(['DOMAIN', 'DOMAIN-SUFFIX']),
  /** Per-probe timeout in ms — applied to each (domain × group) delay test */
  speedtestTimeoutMs: z.number().int().positive(),
  /**
   * After a successful rule write, automatically PUT /configs?force=true so
   * the new rule takes effect without a separate user action. Reload failures
   * are surfaced but don't mark the write itself as failed.
   */
  autoReloadClash: z.boolean(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: '',
  adminKey: '',
  clashUrl: 'http://localhost:9090',
  clashSecret: '',
  candidateGroups: [],
  defaultAnchor: 'manual',
  defaultRuleType: 'DOMAIN-SUFFIX',
  speedtestTimeoutMs: 5000,
  autoReloadClash: true,
};

const KEY = 'proxymanager.settings';

export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(KEY);
  const raw = result[KEY];
  if (!raw) return DEFAULT_SETTINGS;
  const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...raw });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}
