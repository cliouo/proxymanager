import { z } from '@/lib/openapi/zod';
import { ProxyGroupSchema } from './proxyGroup';
import { RuleSchema } from './rule';

export const NamingProfileChangeSchema = z.object({
  profileId: z.uuid(),
  groups: z.array(z.object({ before: ProxyGroupSchema, after: ProxyGroupSchema })).max(1000),
  createdGroups: z.array(ProxyGroupSchema).max(1000).optional(),
  removedGroups: z.array(ProxyGroupSchema).max(1000).optional(),
  rules: z.array(z.object({ before: RuleSchema, after: RuleSchema })).max(10000),
}).superRefine((change, ctx) => {
  const groupIds = [...change.groups.map((p) => p.before.id), ...(change.createdGroups ?? []).map((g) => g.id), ...(change.removedGroups ?? []).map((g) => g.id)];
  if (new Set(groupIds).size !== groupIds.length) ctx.addIssue({ code: 'custom', message: '命名生成的策略组 ID 重复。' });
  for (const pairs of [change.groups, change.rules]) {
    const ids = new Set<string>();
    for (const pair of pairs) {
      if (ids.has(pair.before.id) || pair.before.id !== pair.after.id) ctx.addIssue({ code: 'custom', message: '命名迁移记录 ID 不唯一或发生变化。' });
      ids.add(pair.before.id);
    }
  }
});

export const NamingProfileChangesSchema = z.array(NamingProfileChangeSchema).max(1000).superRefine((changes, ctx) => {
  if (new Set(changes.map((p) => p.profileId)).size !== changes.length) ctx.addIssue({ code: 'custom', message: '命名迁移配置文件 ID 重复。' });
});

export type NamingProfileChange = z.infer<typeof NamingProfileChangeSchema>;
