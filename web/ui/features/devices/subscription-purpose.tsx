import { Select } from '@/ui/primitives';
import type { DeviceLinkVariant } from './model';

export const SHADOWROCKET_HINT = '在 Shadowrocket 的「配置」页下载并使用';

const PURPOSE_OPTIONS: { value: DeviceLinkVariant; label: string }[] = [
  { value: 'clash', label: 'Clash / Mihomo 完整配置' },
  { value: 'shadowrocket', label: 'Shadowrocket 完整配置' },
  { value: 'base64', label: '通用 Base64（仅节点）' },
];

export function SubscriptionPurpose({
  value,
  onChange,
}: {
  value: DeviceLinkVariant;
  onChange: (value: DeviceLinkVariant) => void;
}) {
  return (
    <Select
      label="订阅用途"
      value={value}
      onValueChange={(next) => onChange(next as DeviceLinkVariant)}
      options={PURPOSE_OPTIONS}
    />
  );
}
