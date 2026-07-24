import { redirect } from 'next/navigation';

/**
 * 兼容旧书签。Tailscale 是设备能力，入口统一收进设备卡片与设备详情，
 * 避免同一台设备同时存在两套管理路径。
 */
export default function TailscaleRedirect() {
  redirect('/devices');
}
