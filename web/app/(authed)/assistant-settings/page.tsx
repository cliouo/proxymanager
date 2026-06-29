'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { loadAssistantConfig } from '@/lib/client/assistant-config';
import type { AssistantConfig } from '@/schemas';
import styles from './assistantSettings.module.css';

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  thinking: 'enabled' as const,
  reasoningEffort: 'high' as const,
  maxTokens: 8192,
};

const THINKING_OPTS: { value: AssistantConfig['thinking']; label: string }[] = [
  { value: 'enabled', label: 'enabled' },
  { value: 'disabled', label: 'disabled' },
];
const EFFORT_OPTS: { value: AssistantConfig['reasoningEffort']; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

/**
 * The assistant is organised as 4 Agent Skills (1 hub + 3 deep-dive spokes)
 * sitting on one `proxymanager` MCP server — see plugin/skills/*. Keep these
 * labels in sync with the SKILL.md frontmatter if the skill set changes.
 */
const SKILLS: { name: string; label: string; kind: string; desc: string }[] = [
  {
    name: 'managing-clash-config',
    label: '配置中枢',
    kind: 'hub',
    desc: '常驻入口：分流规则 / 规则集库 / dns·sniffer·tun 等骨架 / 节点真相，并把复合任务路由到下面三个深水区技能。',
  },
  {
    name: 'synthesizing-proxy-groups',
    label: '策略组合成',
    kind: 'spoke',
    desc: '设计策略组成员与 filter（地区组 / select·url-test·fallback…），写入前先对真实节点试算，避免组吃错节点。',
  },
  {
    name: 'editing-node-operators',
    label: '节点处理',
    kind: 'spoke',
    desc: '订阅源 / 聚合订阅的算子管线：过滤 / 改名 / 去重 / 排序 / 加旗 / 类型·地区过滤，以及所有节点改名（含本地源）。',
  },
  {
    name: 'optimizing-whole-config',
    label: '整体优化',
    kind: 'spoke',
    desc: '通盘审查与清理：死规则 / 无用规则集 / 悬空引用 / 缺兜底，给出编号改动清单后逐条落地（单点小改不触发）。',
  },
];

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
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [thinking, setThinking] = useState<AssistantConfig['thinking']>(DEFAULTS.thinking);
  const [reasoningEffort, setReasoningEffort] = useState<AssistantConfig['reasoningEffort']>(
    DEFAULTS.reasoningEffort,
  );
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
      const body: Record<string, unknown> = {
        baseUrl,
        model,
        thinking,
        reasoningEffort,
        maxTokens,
      };
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
      const detail = err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err);
      setStatus({ kind: 'error', message: detail });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTopbar contentMaxWidth={1100}>
        <h1>AI 配置</h1>
        {loaded && hasStoredKey && <span className="pill ai">已启用</span>}
        <div className="grow" />
      </PageTopbar>

      <div className={styles.grid}>
        <section className="panel">
          <div className="panel-head">
            <h2>模型接入</h2>
            <span className="sub">OpenAI 兼容协议 · 浏览器直连，无 60s 函数超时</span>
          </div>
          <div className="panel-body">
            {loaded ? (
              <>
                <div className="field">
                  <label>Base URL</label>
                  <input
                    className="input mono"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.deepseek.com"
                    spellCheck={false}
                  />
                  <div className="hint">
                    任何 OpenAI 兼容端点均可（DeepSeek / 通义 / 本地 Ollama 网关…）
                  </div>
                </div>

                <div className="field">
                  <label>模型</label>
                  <input
                    className="input mono"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="deepseek-v4-pro"
                    spellCheck={false}
                  />
                </div>

                <div className="field">
                  <label>{hasStoredKey ? 'API Key（已保存，留空则不变）' : 'API Key'}</label>
                  <div className={styles.keyRow}>
                    <input
                      className={`input mono ${styles.input}`}
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={hasStoredKey ? '••••••••（已保存）' : 'sk-…'}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="button" className="btn" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                  <div className="hint">凭证存于本服务、仅你可见，只在浏览器内发起调用时使用。</div>
                </div>

                <div className="field">
                  <label>思考模式 thinking</label>
                  <div className="seg">
                    {THINKING_OPTS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={`opt${thinking === o.value ? ' on' : ''}`}
                        onClick={() => setThinking(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label>推理强度 reasoning_effort</label>
                  <div className="seg">
                    {EFFORT_OPTS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={`opt${reasoningEffort === o.value ? ' on' : ''}`}
                        onClick={() => setReasoningEffort(o.value)}
                        disabled={thinking === 'disabled'}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label>最大生成 tokens</label>
                  <input
                    className="input mono num"
                    type="number"
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value) || DEFAULTS.maxTokens)}
                    min={256}
                    max={65536}
                    style={{ maxWidth: 160 }}
                  />
                </div>

                <div className={styles.saveRow}>
                  <button className="btn primary" onClick={onSave} disabled={busy}>
                    {busy ? '保存中…' : '保存配置'}
                  </button>
                  {status && (
                    <span
                      className={`${styles.statusMsg} ${
                        status.kind === 'success' ? styles.ok : styles.err
                      }`}
                    >
                      {status.message}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="hint">加载中…</div>
            )}
          </div>
        </section>

        <aside className={styles.aside}>
          <section className="panel">
            <div className="panel-head">
              <h2>技能与工具</h2>
              <span className="sub">Agent Skills · 31 工具</span>
            </div>
            <div className="panel-body" style={{ padding: '12px 18px' }}>
              {SKILLS.map((s) => (
                <div key={s.name} className={styles.skillRow}>
                  <div className={styles.skillName}>
                    <span>{s.label}</span>
                    <span className={styles.skillKind}>{s.kind}</span>
                  </div>
                  <div className={styles.skillDesc}>
                    <code>{s.name}</code> — {s.desc}
                  </div>
                </div>
              ))}
              <div className={styles.toolNote}>
                助手按你的意图自动加载对应技能，并按需展开各技能的参考文档（渐进披露）。
                旧版扁平工具清单已被技能取代。
                <br />
                <br />✎ 任何写操作都先出 diff、经你在确认卡里授权（服务端铸一次性 token）后才执行，
                并写入可撤销的操作历史。
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>作用域</h2>
            </div>
            <div className={`panel-body ${styles.prose}`}>
              每次对话自动注入你<b>当前选中的配置文件</b>
              作为默认作用域，助手据此判断「这份配置」指谁，写操作只动这一份。
              <br />
              需要批量时在指令里说明「<b>所有配置文件</b>」，助手会改全部并在确认 diff
              里逐份列出（已存在的自动跳过）。
              <br />
              共享资源（订阅源 / 规则集）的改动天然影响所有引用方，助手会提示受影响的配置文件。
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>隐私</h2>
            </div>
            <div className={`panel-body ${styles.prose}`}>
              发送给模型的上下文会做脱敏：订阅
              URL、token、节点服务器地址以占位符替代，模型只见结构不见凭证。
            </div>
          </section>
        </aside>
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h2>接入第三方客户端（MCP）</h2>
          <span className="sub">同一套技能 · 同一个后端 · 同一套写入门控</span>
        </div>
        <div className={`panel-body ${styles.prose}`}>
          网页内 AI 只是这套能力的一个客户端。相同的 <b>4 个技能 + 1 个 <code>proxymanager</code> MCP
          server</b> 已打包成可移植插件（仓库 <code>plugin/</code>），任何支持 Agent Skills 的客户端
          （Claude Code / Codex）都能驱动<b>同一个 ProxyManager 后端</b>，且写操作同样要过服务端确认门控。
          <h3>Claude Code（插件方式）</h3>
          <pre className={styles.code}>{`# 1) 装桥接依赖（首次）
cd plugin/servers && npm install

# 2) 以插件加载，注入你的管理员密钥
PROXYMANAGER_ADMIN_KEY=xxxx \\
PROXYMANAGER_BASE_URL=http://localhost:3000 \\
claude --plugin-dir ./plugin

# 3) 会话内核对
/help   # 应见 4 个 proxymanager 技能
/mcp    # 应见 proxymanager (stdio) 已连接`}</pre>
          <h3>其它客户端（Codex / 手动 .mcp.json）</h3>
          <pre className={styles.code}>{`{
  "mcpServers": {
    "proxymanager": {
      "command": "node",
      "args": ["/绝对路径/proxymanager/plugin/servers/proxymanager-mcp.mjs"],
      "env": {
        "PROXYMANAGER_BASE_URL": "http://localhost:3000",
        "PROXYMANAGER_ADMIN_KEY": "xxxx",
        "PROXYMANAGER_PROFILE": "default"
      }
    }
  }
}`}</pre>
          <table className={styles.envTable}>
            <thead>
              <tr>
                <th>环境变量</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>PROXYMANAGER_BASE_URL</td>
                <td>ProxyManager 实例地址（默认 http://localhost:3000）</td>
              </tr>
              <tr>
                <td>PROXYMANAGER_ADMIN_KEY</td>
                <td>管理员密钥，作 Authorization: Bearer 注入</td>
              </tr>
              <tr>
                <td>PROXYMANAGER_PROFILE</td>
                <td>作用的配置文件（默认 default）</td>
              </tr>
            </tbody>
          </table>
          接线细节与安全说明见仓库 <code>plugin/README.md</code> 与{' '}
          <code>plugin/servers/README.md</code>。技能正文以 <code>plugin/skills/*/SKILL.md</code>{' '}
          为单一真相源——改动后跑 <code>npm run build:skills</code> 让网页内 AI 同步。
        </div>
      </section>
    </>
  );
}
