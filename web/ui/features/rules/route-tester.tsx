'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, CircleCheck, CircleDashed, CircleHelp, Crosshair, FlaskConical, Minus, X } from 'lucide-react';
import { api } from '@/ui/data/api';
import type { Rule, RuleSet, RuleSetListItem } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Input, Spinner } from '@/ui/primitives';
import { BUILTIN_LABEL, isBuiltinPolicy, PolicyChip } from '@/ui/viz/lines';
import { evaluateRuleSetContent, evaluateWithOptions, parseProbe, ruleText, type MatchVerdict, type Probe } from './rule-model';

const EXAMPLES = ['google.com', 'chat.openai.com', 'www.bilibili.com', 'api.telegram.org', '1.1.1.1'];

type SetState = { status: 'loading' } | { status: 'ready'; content: string; behavior?: string } | { status: 'error' };

interface Step {
  rule: Rule;
  position: number;
  verdict: MatchVerdict;
  reason?: string;
  /** Rule-set whose name matches the probed domain (e.g. `openai` vs chat.openai.com). */
  likely?: boolean;
}

const GENERIC_TOKENS = new Set(['cn', 'direct', 'reject', 'proxy', 'cidr', 'ip', 'geo', 'domain', 'list', 'rules', 'set', 'global', 'private', 'lan']);

/** Heuristic: a rule-set named after a brand that appears in the host name very likely covers it. */
function nameMatchesHost(name: string, host: string | null): boolean {
  if (!host) return false;
  const labels = host.split('.');
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token.length >= 3 && !GENERIC_TOKENS.has(token) && labels.some((label) => label === token || label.startsWith(token)));
}

function unknownReason(rule: Rule, probe: Probe, set?: RuleSetListItem, state?: SetState): string {
  switch (rule.type) {
    case 'RULE-SET':
      if (!set) return '找不到这个规则集';
      if (set.source === 'remote') return '远程规则集，内容由客户端下载，浏览器里无法展开';
      if (state?.status === 'loading') return '正在载入规则集内容…';
      if (state?.status === 'error') return '规则集内容载入失败';
      return '规则集里有浏览器无法判断的条目';
    case 'GEOSITE':
      return '需要客户端的 GeoSite 数据库';
    case 'GEOIP':
    case 'IP-ASN':
      return probe.host ? '要先把域名解析成 IP 再查库' : '需要客户端的 GeoIP 数据库';
    case 'IP-CIDR':
    case 'IP-CIDR6':
      return '取决于域名解析出的 IP';
    case 'DOMAIN-REGEX':
      return '这个正则无法在浏览器中执行';
    default:
      return '取决于发起连接的进程、端口或协议';
  }
}

export function RouteTester({
  ordered,
  ruleSets,
  onReveal,
  onClose,
}: {
  /** Enabled rules in evaluation order. */
  ordered: Rule[];
  ruleSets: RuleSetListItem[] | undefined;
  onReveal: (ruleId: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [sets, setSets] = useState<Record<string, SetState>>({});
  const [showTrace, setShowTrace] = useState(false);
  const probe = useMemo(() => parseProbe(input), [input]);
  const setByName = useMemo(() => new Map((ruleSets ?? []).map((s) => [s.name, s])), [ruleSets]);

  // Lazily load hosted rule-set bodies that the probe has to pass through.
  useEffect(() => {
    if (!probe) return;
    const needed = ordered
      .filter((r) => r.type === 'RULE-SET')
      .map((r) => setByName.get(r.value))
      .filter((s): s is RuleSetListItem => !!s && (s.source ?? 'local') === 'local' && !sets[s.name]);
    if (needed.length === 0) return;
    setSets((current) => {
      const next = { ...current };
      for (const s of needed) next[s.name] = { status: 'loading' };
      return next;
    });
    for (const s of needed) {
      api
        .get<RuleSet>(`/rule-sets/${s.id}`)
        .then((full) => setSets((c) => ({ ...c, [s.name]: { status: 'ready', content: full.content, behavior: full.behavior } })))
        .catch(() => setSets((c) => ({ ...c, [s.name]: { status: 'error' } })));
    }
  }, [probe, ordered, setByName, sets]);

  const result = useMemo(() => {
    if (!probe) return null;
    const steps: Step[] = [];
    let match: Step | null = null;
    ordered.forEach((rule, index) => {
      if (match) return;
      const set = rule.type === 'RULE-SET' ? setByName.get(rule.value) : undefined;
      const state = set ? sets[set.name] : undefined;
      const verdict = evaluateWithOptions(rule, probe, () => {
        if (!set || (set.source ?? 'local') === 'remote' || !state || state.status !== 'ready') return 'unknown';
        return evaluateRuleSetContent(state.content, state.behavior ?? set.behavior, probe);
      });
      const step: Step = {
        rule,
        position: index + 1,
        verdict,
        reason: verdict === 'unknown' ? unknownReason(rule, probe, set, state) : undefined,
        likely: verdict === 'unknown' && rule.type === 'RULE-SET' && nameMatchesHost(rule.value, probe.host),
      };
      steps.push(step);
      if (verdict === 'match') match = step;
    });
    const uncertain = steps.filter((s) => s.verdict === 'unknown');
    const likely = uncertain.find((s) => s.likely) ?? null;
    return { steps, match: match as Step | null, uncertain, likely };
  }, [probe, ordered, setByName, sets]);

  const loading = Object.values(sets).some((s) => s.status === 'loading');

  return (
    <div className="animate-rise overflow-hidden rounded-xl border border-accent-line/70 bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line bg-accent-soft/40 px-4 py-2.5">
        <FlaskConical size={15} className="text-accent" />
        <span className="text-sm font-semibold text-ink">路由测试</span>
        <span className="text-xs text-ink-3">输入一个域名或 IP，看它会命中哪条规则、走哪条线路</span>
        <button type="button" onClick={onClose} aria-label="关闭路由测试" className="ml-auto flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink">
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            inputSize="lg"
            mono
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="例如 chat.openai.com、https://www.netflix.com/title/123、1.1.1.1"
            leading={<Crosshair size={15} />}
            trailing={loading ? <Spinner size={14} className="mr-1.5 text-ink-3" /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            试试
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setInput(example)}
                className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-2 transition hover:border-line-strong hover:text-ink"
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        {result && (
          <div className="flex flex-col gap-3">
            {result.likely && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent-line/70 bg-accent-soft/50 px-4 py-3">
                <span className="text-sm text-ink-2">
                  {probe?.host} <span className="text-ink-4">→</span>
                </span>
                <PolicyChip policy={result.likely.rule.policy} />
                <span className="text-xs font-medium text-accent">很可能</span>
                <span className="text-xs text-ink-3">
                  第 <span className="tnum font-medium text-ink">{result.likely.position}</span> 条规则集「{result.likely.rule.value}」与域名吻合（内容由客户端下载，无法在这里逐条核对）
                </span>
                <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onReveal(result.likely!.rule.id)}>
                  在列表中定位
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-2/50 px-4 py-3">
              {result.match ? (
                <>
                  <span className="text-sm text-ink-2">
                    {result.likely ? '否则' : (probe?.host ?? probe?.ip)} <span className="text-ink-4">→</span>
                  </span>
                  <PolicyChip policy={result.match.rule.policy} />
                  {isBuiltinPolicy(result.match.rule.policy) && (
                    <span className="text-xs text-ink-3">{BUILTIN_LABEL[result.match.rule.policy]}</span>
                  )}
                  <span className="text-xs text-ink-3">
                    {result.uncertain.length ? '确定命中' : '命中'}第 <span className="tnum font-medium text-ink">{result.match.position}</span> 条
                  </span>
                  <code className="min-w-0 truncate font-mono text-[12px] text-ink-2">{ruleText(result.match.rule)}</code>
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onReveal(result.match!.rule.id)}>
                    在列表中定位
                  </Button>
                </>
              ) : (
                <span className="text-sm text-ink-2">
                  没有规则能确定命中{ordered.some((r) => r.type === 'MATCH') ? '' : '，也没有兜底规则——Mihomo 会直连'}。
                </span>
              )}
            </div>

            {result.uncertain.length > 0 && (
              <div className="rounded-lg border border-warn/25 bg-warn-soft/60 px-4 py-3">
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <CircleHelp size={14} className="text-warn" />
                  在它之前有 {result.uncertain.length} 条规则无法在浏览器里判断
                </div>
                <p className="mt-0.5 text-xs text-ink-2">如果其中任意一条在客户端里命中，流量会改走那一条的线路。</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {result.uncertain.slice(0, 6).map((step) => (
                    <li key={step.rule.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="tnum w-6 text-right text-ink-4">{step.position}</span>
                      <button type="button" onClick={() => onReveal(step.rule.id)} className="font-mono text-[11.5px] text-ink hover:underline">
                        {step.rule.type} {step.rule.value}
                      </button>
                      <PolicyChip policy={step.rule.policy} size="sm" />
                      {step.likely && <Badge tone="accent">很可能</Badge>}
                      <span className="text-ink-3">{step.reason}</span>
                    </li>
                  ))}
                  {result.uncertain.length > 6 && <li className="text-xs text-ink-3">…另有 {result.uncertain.length - 6} 条</li>}
                </ul>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowTrace((v) => !v)}
              className="flex items-center gap-1.5 self-start text-xs font-medium text-ink-3 hover:text-ink"
            >
              <ChevronDown size={13} className={cn('transition-transform', showTrace && 'rotate-180')} />
              {showTrace ? '收起' : '查看'}逐条判断过程（{result.steps.length} 条）
            </button>
            {showTrace && (
              <ol className="max-h-[280px] overflow-y-auto rounded-lg border border-line">
                {result.steps.map((step) => (
                  <li
                    key={step.rule.id}
                    className={cn(
                      'flex items-center gap-2.5 border-b border-line px-3 py-1.5 text-xs last:border-b-0',
                      step.verdict === 'match' && 'bg-ok-soft/60',
                    )}
                  >
                    <span className="tnum w-6 text-right text-ink-4">{step.position}</span>
                    {step.verdict === 'match' ? (
                      <CircleCheck size={13} className="text-ok" />
                    ) : step.verdict === 'unknown' ? (
                      <CircleDashed size={13} className="text-warn" />
                    ) : (
                      <Minus size={13} className="text-ink-4" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{ruleText(step.rule)}</span>
                    {step.verdict === 'unknown' && <Badge tone="warn">不确定</Badge>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
