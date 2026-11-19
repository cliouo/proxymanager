import type { DeviceLinkVariant } from './model';

export const SHADOWROCKET_HINT = '在 Shadowrocket 的「配置」页下载并使用';

export function SubscriptionPurpose({
  value,
  onChange,
}: {
  value: DeviceLinkVariant;
  onChange: (value: DeviceLinkVariant) => void;
}) {
  return (
    <select
      aria-label="订阅用途"
      value={value}
      onChange={(event) => onChange(event.target.value as DeviceLinkVariant)}
      className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink"
    >
      <option value="clash">Clash / Mihomo 完整配置</option>
      <option value="shadowrocket">Shadowrocket 完整配置</option>
      <option value="base64">通用 Base64（仅节点）</option>
    </select>
  );
}
