import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleSet } from '@/schemas';

const RULE_SET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET_URL =
  'https://user:password@example.com/api/1234567890abcdef1234567890abcdef/rules.yaml?token=short';
const SECRET_CONTENT = 'payload:\n  - DOMAIN-SUFFIX,private.internal\n  - TOKEN,do-not-return';

const mocks = vi.hoisted(() => ({
  current: null as RuleSet | null,
  dispatch: vi.fn(),
  safeFetchText: vi.fn(),
}));

vi.mock('@/lib/repos/rulesRepo', () => ({ listRules: vi.fn(async () => []) }));
vi.mock('@/lib/services/ruleSetService', () => ({
  listRuleSets: vi.fn(async () => (mocks.current ? [mocks.current] : [])),
  getRuleSet: vi.fn(async () => mocks.current),
}));
vi.mock('@/lib/scenarios/_shared/dispatch', () => ({ dispatch: mocks.dispatch }));
vi.mock('@/lib/net/safeFetch', () => ({ safeFetchText: mocks.safeFetchText }));

const CTX = { actor: 'test', profileId: 'profile-test' };

interface TestWriteAction {
  preview(ctx: typeof CTX, input: Record<string, unknown>): Promise<unknown>;
  execute(ctx: typeof CTX, input: Record<string, unknown>): Promise<unknown>;
}

function requireWriteAction(
  actions: ReadonlyArray<{ name: string }>,
  name: string,
): TestWriteAction {
  const action = actions.find((item) => item.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action as unknown as TestWriteAction;
}

function remoteRuleSet(): RuleSet {
  return {
    id: RULE_SET_ID,
    name: 'private-rules',
    source: 'remote',
    format: 'yaml',
    behavior: 'classical',
    content: '',
    url: SECRET_URL,
    interval: 86400,
    updated_at: 1,
  };
}

beforeEach(() => {
  mocks.current = remoteRuleSet();
  mocks.dispatch.mockReset();
  mocks.safeFetchText.mockReset();
});

describe('rule-provider assistant redaction', () => {
  it('redacts credentials and tokenized segments from list results', async () => {
    const { RULE_PROVIDER_READ_ACTIONS } =
      await import('@/lib/ai/actions/primitives/ruleProviderWrites');
    const action = RULE_PROVIDER_READ_ACTIONS.find((item) => item.name === 'list_rule_providers');
    if (!action) throw new Error('missing list_rule_providers');

    const result = await action.run(CTX, {});
    const serialized = JSON.stringify(result.data);
    expect(serialized).toContain('***');
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('1234567890abcdef');
    expect(serialized).not.toContain('token=short');
  });

  it('hides stored URL and local content in previews and successful write results', async () => {
    const { RULE_PROVIDER_WRITE_ACTIONS } =
      await import('@/lib/ai/actions/primitives/ruleProviderWrites');
    const update = requireWriteAction(RULE_PROVIDER_WRITE_ACTIONS, 'update_rule_provider');
    const localize = requireWriteAction(RULE_PROVIDER_WRITE_ACTIONS, 'localize_rule_provider');

    const updatePreview = await update.preview(CTX, { id: RULE_SET_ID, interval: 3600 });
    expect(JSON.stringify(updatePreview)).not.toContain('password');
    expect(JSON.stringify(updatePreview)).not.toContain('1234567890abcdef');
    expect(JSON.stringify(updatePreview)).not.toContain('token=short');

    mocks.dispatch.mockResolvedValueOnce({
      data: { ...remoteRuleSet(), interval: 3600 },
      events: [{ id: 'event-1', op: 'rule-provider.update' }],
    });
    const updateResult = await update.execute(CTX, { id: RULE_SET_ID, interval: 3600 });
    expect(JSON.stringify(updateResult)).not.toContain('password');
    expect(JSON.stringify(updateResult)).not.toContain('1234567890abcdef');
    expect(JSON.stringify(updateResult)).not.toContain('token=short');

    mocks.safeFetchText.mockResolvedValueOnce({ text: SECRET_CONTENT, bytes: 64 });
    mocks.dispatch.mockResolvedValueOnce({
      data: { ...remoteRuleSet(), source: 'local', url: '', content: SECRET_CONTENT },
      events: [{ id: 'event-2', op: 'rule-provider.update' }],
    });
    const localizeResult = await localize.execute(CTX, { id: RULE_SET_ID });
    expect(JSON.stringify(localizeResult)).not.toContain('private.internal');
    expect(JSON.stringify(localizeResult)).not.toContain('do-not-return');
  });

  it('does not echo newly supplied local content in the confirmation diff', async () => {
    const { RULE_PROVIDER_WRITE_ACTIONS } =
      await import('@/lib/ai/actions/primitives/ruleProviderWrites');
    const create = requireWriteAction(RULE_PROVIDER_WRITE_ACTIONS, 'create_rule_provider');

    const preview = await create.preview(CTX, {
      name: 'local-private',
      source: 'local',
      format: 'yaml',
      behavior: 'classical',
      content: SECRET_CONTENT,
    });
    expect(JSON.stringify(preview)).toContain('本地内容');
    expect(JSON.stringify(preview)).not.toContain('private.internal');
    expect(JSON.stringify(preview)).not.toContain('do-not-return');
  });
});
