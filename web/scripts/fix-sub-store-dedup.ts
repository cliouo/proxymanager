/**
 * One-time fix: the sub-store node source is wired up twice —
 *   1. Subscription "123" (resource model) injects its nodes into top-level
 *      `proxies:`, and
 *   2. base.yaml still carries a legacy `proxy-providers: sub-store` block
 *      pointing at the *same* URL.
 *
 * The migrated groups use `include-all-providers` (pull from the provider).
 * Post resource-model that's redundant: the same nodes already live in
 * top-level `proxies:`. This script commits to the resource model —
 *
 *   1. flip every group's `include-all-providers: true` → `include-all-proxies: true`
 *      (drop the providers flag) so they source the injected top-level nodes,
 *   2. remove the now-unused `proxy-providers:` block from base.yaml
 *      (line-based, so the rest of the skeleton is untouched byte-for-byte;
 *      the `&p` anchor becomes a defined-but-unused no-op — harmless).
 *
 * Node set is unchanged (same upstream URL), only the supply route changes.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/fix-sub-store-dedup.ts
 *   Commit:             tsx --env-file=.env.local scripts/fix-sub-store-dedup.ts --commit
 *
 * Commit is one atomic Redis transaction and backs up everything it touches:
 *   base:content:backup:<ts> · base:meta:backup:<ts> · proxy-groups:iap-fix:backup:<ts>
 */

import { parseDocument } from 'yaml';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase, type BaseMeta } from '@/lib/repos/baseRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { computeEtag } from '@/lib/services/baseService';
import type { ProxyGroup } from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Remove the top-level `proxy-providers:` block by line, consuming its
 * indented body + the single trailing blank line. Returns null if absent.
 */
function removeProxyProvidersBlock(
  content: string,
): { next: string; removed: string[] } | null {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^proxy-providers:\s*$/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1;
  const removed = lines.slice(start, end);
  lines.splice(start, end - start);
  return { next: lines.join('\n'), removed };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== fix-sub-store-dedup (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const base = await getBase();
  if (!base) throw new Error('base:content 不存在。');
  const oldContent = base.content;
  const oldMeta: BaseMeta = {
    etag: base.etag,
    anchors: base.anchors,
    policies: base.policies,
    updated_at: base.updated_at,
  };

  // 1) Groups to flip: include-all-providers → include-all-proxies.
  const groups = await listProxyGroups();
  const toFlip = groups.filter((g) => g['include-all-providers'] === true && g['include-all'] !== true);
  const modified: ProxyGroup[] = toFlip.map((g) => {
    const next = { ...g, 'include-all-proxies': true, updated_at: nowSeconds() } as Record<string, unknown>;
    delete next['include-all-providers'];
    return next as ProxyGroup;
  });

  console.log(`— 待改组 (${toFlip.length}) include-all-providers → include-all-proxies —`);
  for (const g of toFlip) {
    console.log(`  ${g.name.padEnd(14)} kind=${g.kind.padEnd(16)} filter=${g.filter ?? '(无)'}`);
  }

  // 2) Remove the proxy-providers block from base.yaml.
  const edit = removeProxyProvidersBlock(oldContent);
  console.log('\n— base.yaml proxy-providers 块 —');
  if (!edit) {
    console.log('  (未找到 proxy-providers: 块,base 不变)');
  } else {
    console.log(`  将删除 ${edit.removed.length} 行:`);
    for (const l of edit.removed) console.log(`    | ${l}`);
    console.log(`  base.content: ${oldContent.length} → ${edit.next.length} 字节`);
  }
  const newContent = edit ? edit.next : oldContent;

  // Validate the rewritten YAML before anything else.
  const doc = parseDocument(newContent);
  if (doc.errors.length > 0) {
    throw new Error(`改后 base.yaml 解析失败: ${doc.errors.map((e) => e.message).join('; ')}`);
  }

  if (!commit) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --commit 执行。\n');
    return;
  }

  if (toFlip.length === 0 && !edit) {
    console.log('\n无可改项,退出。\n');
    return;
  }

  const redis = getRedis();
  const live = await redis.get<string>(REDIS_KEYS.base.content);
  if (live !== oldContent) {
    throw new Error('base:content 在本次运行期间被其他写入修改,已中止。请重新 dry-run。');
  }

  const ts = Date.now();
  const newMeta: BaseMeta = {
    etag: computeEtag(newContent),
    anchors: oldMeta.anchors,
    policies: oldMeta.policies,
    updated_at: nowSeconds(),
  };
  const groupBackup: Record<string, ProxyGroup> = {};
  for (const g of toFlip) groupBackup[g.id] = g;
  const groupPayload: Record<string, ProxyGroup> = {};
  for (const g of modified) groupPayload[g.id] = g;

  const tx = redis.multi();
  tx.set(`base:content:backup:${ts}`, oldContent);
  tx.set(`base:meta:backup:${ts}`, oldMeta);
  if (modified.length > 0) {
    tx.set(`proxy-groups:iap-fix:backup:${ts}`, JSON.stringify(groupBackup));
    tx.hset(REDIS_KEYS.proxyGroups, groupPayload);
  }
  tx.set(REDIS_KEYS.base.content, newContent);
  tx.set(REDIS_KEYS.base.meta, newMeta);
  await tx.exec();
  await invalidateResolvedSnapshot().catch(() => undefined);

  console.log('\n✓ COMMIT 完成(原子事务):');
  console.log(`  改组         : ${modified.length} 个`);
  console.log(`  base.content : ${oldContent.length} → ${newContent.length} 字节`);
  console.log(`  base.etag    : ${oldMeta.etag} → ${newMeta.etag}`);
  console.log('  备份键:');
  console.log(`    base:content:backup:${ts}`);
  console.log(`    base:meta:backup:${ts}`);
  if (modified.length > 0) console.log(`    proxy-groups:iap-fix:backup:${ts}`);
  console.log('\n撤销:用 base:content:backup 还原 base;用 proxy-groups:iap-fix:backup 里的 {id:group} hset 回去。\n');
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
