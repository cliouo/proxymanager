/**
 * Move one unambiguous legacy shared Tailscale setup into one existing device.
 *
 * Dry-run is the default. Both selectors are mandatory and exact:
 *   npm run migrate:tailscale-device -- --profile home --device macbook
 *   npm run migrate:tailscale-device -- --profile home --device macbook --apply
 *
 * The auth key is used internally to build the device record but never printed.
 * Apply is one config-version CAS transaction over base, device, group and
 * rules, with a timestamped Redis backup written in that same transaction.
 */

import {
  executeTailscaleDeviceMigration,
  planTailscaleDeviceMigration,
} from '@/lib/services/tailscaleDeviceMigrationService';

function valueAfter(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    throw new Error(`必须提供 ${flag} <name>。`);
  }
  return value;
}

async function main(): Promise<void> {
  const profile = valueAfter('--profile');
  const device = valueAfter('--device');
  const apply = process.argv.includes('--apply');
  console.log(`\n=== migrate-tailscale-device (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const plan = await planTailscaleDeviceMigration(profile, device);
  const { summary } = plan;
  console.log(`配置文件 : ${summary.profile.name}`);
  console.log(`目标设备 : ${summary.device.name}`);
  console.log(`旧节点   : ${summary.nodeName}`);
  console.log(`旧策略组 : ${summary.groupName}`);
  console.log(`Hostname : ${summary.hostname}`);
  console.log(`Auth key : ${summary.hasAuthKey ? '已设置（内容不显示）' : '未设置'}`);
  console.log(`迁移规则 : ${summary.ruleCount} 条`);
  console.log(`额外 CIDR: ${summary.extraCidrs.length ? summary.extraCidrs.join('、') : '无'}`);

  if (!apply) {
    console.log('\nDRY-RUN 完成，未写入。确认目标正确后加 --apply 执行。\n');
    return;
  }

  const result = await executeTailscaleDeviceMigration(plan);
  console.log('\n✓ APPLY 完成');
  console.log(`  设备 Tailscale 已启用 : ${summary.device.name}`);
  console.log(`  旧共享节点/组/规则已移除`);
  console.log(`  备份键                 : ${result.backupKey}\n`);
  if (!result.auditRecorded) {
    console.warn('  警告：迁移已提交，但审计事件写入失败；请检查审计存储。\n');
  }
}

main().catch((error) => {
  console.error('\n✗ 迁移失败:', error instanceof Error ? error.message : '未知错误');
  process.exit(1);
});
