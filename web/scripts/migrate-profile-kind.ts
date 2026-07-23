/**
 * One-time migration for Phase T (模版类型): 给存量的模版系列 profile 打上
 * `kind: 'template'`。
 *
 * 名单规则（与 DEVICE-LAYER-DESIGN.md §8.2 一致）：`name` 以 `simple` 或
 * `general` 开头的 profile → 模版；其余一律不动。ProfileSchema 给 `kind` 定了
 * `.default('normal')`，所以**不打标的记录无需回填**（parse-forward 即可）——
 * 这个脚本只负责把「本来就是模版」的那几份标出来。
 *
 * 打了标之后，那几份 profile：
 *   - `/api/sub/{token}/{name}` 一律 404（模版不对外分发）；
 *   - 在列表页 / 切换器里单列「模版」一节并加徽章；
 *   - 新建配置文件时被置顶为「从模版新建」。
 * 其余语义（可编辑、可预览、可激活）完全不变。
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-profile-kind.ts
 *   Apply:              tsx --env-file=.env.local scripts/migrate-profile-kind.ts --apply
 *
 * Apply is one atomic transaction:
 *   - backup the prior profiles hash (JSON) → backup:migrate-profile-kind:<ts>
 *   - HSET the rewritten profile records (kind 打标)
 *   - INCR config:version
 *
 * 注：改 `kind` 不影响任何渲染产物（kind 只管分发闸门与 UI），INCR 纯粹是为了
 * 与其它 profiles hash 写路径保持同一套失效语义，不留「写了但版本没动」的先例。
 */

import { TEMPLATE_NAME_PREFIXES, matchesTemplateNameConvention } from '@/lib/profiles/kind';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

interface RawProfile {
  id?: string;
  name?: string;
  kind?: unknown;
  [k: string]: unknown;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`\n=== migrate-profile-kind (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  console.log(`名单规则 : name 以 ${TEMPLATE_NAME_PREFIXES.join(' / ')} 开头 → kind=template\n`);

  const redis = getRedis();
  const profiles = (await redis.hgetall<Record<string, RawProfile>>(REDIS_KEYS.profiles)) ?? {};
  const entries = Object.entries(profiles);
  console.log(`profiles 总数 : ${entries.length}\n`);

  const writes: Record<string, RawProfile> = {};
  for (const [id, raw] of entries) {
    const name = typeof raw.name === 'string' ? raw.name : '(无名)';
    // 存量记录多半没有 kind 字段 —— 读出来的 undefined 与 schema 默认值 'normal'
    // 是同一个意思，前后对照里统一显示成 normal，避免「(空) → normal」这种噪音。
    const before = raw.kind === 'template' ? 'template' : 'normal';
    const after = matchesTemplateNameConvention(name) ? 'template' : 'normal';

    if (before === after) {
      console.log(`· ${name.padEnd(16)} ${before.padEnd(8)} → ${after.padEnd(8)} (不变, 跳过)`);
      continue;
    }
    writes[id] = { ...raw, kind: after, updated_at: nowSeconds() };
    console.log(`· ${name.padEnd(16)} ${before.padEnd(8)} → ${after.padEnd(8)} ✎`);
  }

  console.log(`\n— 待写入 (${Object.keys(writes).length} / ${entries.length}) —`);

  if (!apply) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --apply 执行。\n');
    return;
  }
  if (Object.keys(writes).length === 0) {
    console.log('\n无可改项,退出。\n');
    return;
  }

  const ts = Date.now();
  const backupKey = `backup:migrate-profile-kind:${ts}`;
  const tx = redis.multi();
  tx.set(backupKey, JSON.stringify(profiles));
  tx.hset(REDIS_KEYS.profiles, writes);
  tx.incr(REDIS_KEYS.configVersion);
  await tx.exec();

  console.log('\n✓ APPLY 完成:');
  console.log(`  打标为模版的 profiles : ${Object.keys(writes).length}`);
  console.log(`  备份键                : ${backupKey}`);
  console.log('\n撤销: 从备份键还原 profiles hash:');
  console.log(`  GET ${backupKey} → 逐条 hset ${REDIS_KEYS.profiles} <id> <json>\n`);
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
