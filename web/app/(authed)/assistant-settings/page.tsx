'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input, Select } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';
import { loadAssistantConfig } from '@/lib/client/assistant-config';
import type { AssistantConfig } from '@/schemas';

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  thinking: 'enabled' as const,
  reasoningEffort: 'high' as const,
  maxTokens: 8192,
};

/**
 * 「AI 配置」 — the user's own DeepSeek credentials. The assistant runs its
 * agent loop in the browser and calls the model API directly, so the key set
 * here is what the browser uses. Stored in KV and cached to localStorage on
 * page load (see lib/client/assistant-config.ts).
 */
export default function AssistantSettingsPage() {
  const [baseUrl, setBaseUrl] = useState(DEFAULTS.baseUrl);
  const [model, setModel] = useState(DEFAULTS.model);
  const [apiKey, setApiKey] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [thinking, setThinking] = useState<AssistantConfig['thinking']>(DEFAULTS.thinking);
  const [reasoningEffort, setReasoningEffort] =
    useState<AssistantConfig['reasoningEffort']>(DEFAULTS.reasoningEffort);
  const [maxTokens, setMaxTokens] = useState<number>(DEFAULTS.maxTokens);

  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ data: AssistantConfig }>('/api/v1/assistant/config');
      const c = res.data;
      setBaseUrl(c.baseUrl);
      setModel(c.model);
      setThinking(c.thinking);
      setReasoningEffort(c.reasoningEffort);
      setMaxTokens(c.maxTokens);
      setHasStoredKey(Boolean(c.apiKey));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      // 404 = not configured yet; keep defaults.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave() {
    setBusy(true);
    setStatus(null);
    try {
      // Omit apiKey when left blank so we don't overwrite a stored key with "".
      const body: Record<string, unknown> = { baseUrl, model, thinking, reasoningEffort, maxTokens };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (!apiKey.trim() && !hasStoredKey) {
        setStatus({ kind: 'error', message: '请填写 API Key。' });
        setBusy(false);
        return;
      }
      await api('/api/v1/assistant/config', { method: 'PUT', body });
      await loadAssistantConfig(); // refresh the localStorage cache the assistant reads
      setApiKey('');
      setHasStoredKey(true);
      setStatus({ kind: 'success', message: '已保存' });
    } catch (err) {
      const detail = err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setStatus({ kind: 'error', message: detail });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[640px]">
      <header className="mb-6">
        <h1
          className="font-serif text-[24px] font-medium tracking-[-0.01em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
        >
          AI 配置
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
          配置助手在你的浏览器里直连模型 API 运行,凭证存于本服务、仅你可见。填入 DeepSeek(或任意
          OpenAI 兼容)的 Base URL、模型与 API Key 后即可使用。修改后刷新页面即同步到本地。
        </p>
      </header>

      {loaded && (
        <div className="flex flex-col gap-4">
          <FormField label="Base URL">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
            />
          </FormField>

          <FormField label="模型">
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-v4-pro"
              spellCheck={false}
            />
          </FormField>

          <FormField label={hasStoredKey ? 'API Key（已保存，留空则不变）' : 'API Key'}>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasStoredKey ? '••••••••（已保存）' : 'sk-…'}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          <div className="flex gap-4">
            <FormField label="思考模式">
              <Select
                value={thinking}
                onChange={(e) => setThinking(e.target.value as AssistantConfig['thinking'])}
              >
                <option value="enabled">开启（reasoner）</option>
                <option value="disabled">关闭（更快）</option>
              </Select>
            </FormField>

            <FormField label="推理强度">
              <Select
                value={reasoningEffort}
                onChange={(e) =>
                  setReasoningEffort(e.target.value as AssistantConfig['reasoningEffort'])
                }
                disabled={thinking === 'disabled'}
              >
                <option value="low">low（最快）</option>
                <option value="medium">medium</option>
                <option value="high">high（最深）</option>
              </Select>
            </FormField>

            <FormField label="max tokens">
              <Input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value) || DEFAULTS.maxTokens)}
                min={256}
                max={65536}
              />
            </FormField>
          </div>

          <div className="mt-1 flex items-center gap-3">
            <Button variant="primary" size="md" onClick={onSave} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
            {status && (
              <span
                className={`text-[13px] ${
                  status.kind === 'success'
                    ? 'text-[var(--color-primary)]'
                    : 'text-[var(--color-danger)]'
                }`}
              >
                {status.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
