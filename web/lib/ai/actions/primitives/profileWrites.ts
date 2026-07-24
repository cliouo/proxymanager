/**
 * Profile actions — enumerate profiles plus gated create/update over the
 * profile records themselves ("配置文件"：per-profile 拥有 base/规则/策略组/设备
 * 的顶层实体). They call the same `profileService` the /profiles UI uses, so
 * name-uniqueness, the `default`-anchor guards, source-binding validation and
 * clone-with-rollback all apply unchanged.
 *
 * Scope note: `list_profiles` exists here as a REAL server action so the
 * browser assistant can enumerate profiles too. The MCP bridge still
 * intercepts the same tool name locally (it knows its own `select_profile`
 * state) — the bridge dedupes tool names, and interception means the server
 * variant is simply shadowed there. `select_profile` remains bridge-only: the
 * web assistant's scope is the sidebar switcher (cookie), not a tool.
 *
 * Deliberately NOT here: `delete_profile`. Deleting a profile destroys its
 * whole owned universe (base/rules/groups/devices) — it stays UI-only and its
 * name sits on the Never-List (`../neverList.ts`) so it can never be
 * registered by accident.
 */

import { z } from 'zod';
import { stringify } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getProfile, getProfileByName, listProfiles } from '@/lib/repos/profilesRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { createProfile, patchProfile } from '@/lib/services/profileService';
import {
  NAME_HINT,
  NAME_REGEX,
  type Profile,
  type ProfileSource,
  type ProfileUpdate,
} from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

/** Resolve a source binding to a human label without leaking URLs/tokens. */
async function sourceLabel(source: ProfileSource): Promise<string | null> {
  if (source.type === 'none') return null;
  if (source.type === 'subscription') {
    const sub = (await listSubscriptions()).find((s) => s.id === source.id);
    return sub ? `订阅源: ${sub.name}` : `订阅源: ${source.id}（已不存在）`;
  }
  const col = (await listCollections()).find((c) => c.id === source.id);
  return col ? `聚合订阅: ${col.name}` : `聚合订阅: ${source.id}（已不存在）`;
}

/** Compact YAML view of a profile's editable fields for confirm-card diffs. */
function profileYaml(p: Partial<Profile>, extra?: Record<string, unknown>): string {
  const obj: Record<string, unknown> = { name: p.name };
  if (p.display_name !== undefined) obj.display_name = p.display_name;
  obj.kind = p.kind ?? 'normal';
  if (p.source) obj.source = p.source;
  if (p.notes !== undefined) obj.notes = p.notes;
  return stringify({ ...obj, ...(extra ?? {}) }).trimEnd();
}

/* ─── source binding (snake_case tool shape → discriminated union) ──── */

const SOURCE_TYPE = z
  .enum(['none', 'subscription', 'collection'])
  .describe('节点来源绑定：none 不注入 / subscription 绑单个订阅源 / collection 绑聚合订阅');

function toSource(
  type: 'none' | 'subscription' | 'collection' | undefined,
  id: string | undefined,
): ProfileSource | undefined {
  if (type === undefined) {
    if (id !== undefined) {
      throw ProblemDetailsError.unprocessable('给了 source_id 就必须同时给 source_type。');
    }
    return undefined;
  }
  if (type === 'none') {
    if (id !== undefined) {
      throw ProblemDetailsError.unprocessable('source_type=none 时不能带 source_id。');
    }
    return { type: 'none' };
  }
  if (!id) {
    throw ProblemDetailsError.unprocessable(`source_type=${type} 时必须给 source_id。`);
  }
  return { type, id };
}

/* ─── list_profiles ─────────────────────────────────────────────────── */

const listProfilesAction = defineAction({
  name: 'list_profiles',
  description:
    '列出全部配置文件（profile）：id、name（进分发 URL 的 kebab 标识）、display_name、kind（normal 普通 / template 模版，模版不分发）、节点来源绑定与当前会话作用域标记。新建/修改配置文件、跨配置文件操作、或回答「有哪些配置/绑的哪个订阅」前先调用。只读。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    const profiles = await listProfiles();
    return {
      kind: 'profile-list',
      data: {
        count: profiles.length,
        profiles: await Promise.all(
          profiles.map(async (p) => ({
            id: p.id,
            name: p.name,
            display_name: p.display_name ?? null,
            kind: p.kind,
            source: p.source,
            source_label: await sourceLabel(p.source),
            notes: p.notes ?? null,
            current: p.id === ctx.profileId,
          })),
        ),
      },
    };
  },
});

/* ─── create_profile ────────────────────────────────────────────────── */

const CreateProfileInput = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(NAME_REGEX, NAME_HINT)
      .describe('kebab-case 标识，唯一，进分发 URL /api/sub/{token}/{name}'),
    display_name: z
      .string()
      .max(120)
      .optional()
      .describe('客户端导入后的显示名（中文/emoji 均可）；留空回退 proxymanager-{name}'),
    kind: z
      .enum(['normal', 'template'])
      .default('normal')
      .describe('normal 普通配置 / template 模版（不分发，供克隆）'),
    copy_from: z
      .uuid()
      .optional()
      .describe(
        '克隆来源 profile id（先用 list_profiles 拿；「从模版新建」就把模版 id 填这里）。深拷贝其 base+策略组+规则+设备（设备 features 清空）；省略则从 default 拷空骨架，无组无规则',
      ),
    notes: z.string().optional().describe('备注'),
    source_type: SOURCE_TYPE.optional().describe('节点来源绑定；省略=none 不注入订阅节点'),
    source_id: z
      .uuid()
      .optional()
      .describe('绑定的订阅源/聚合订阅 id（source_type 为 subscription/collection 时必填）'),
  })
  .refine((v) => !(v.source_type === undefined && v.source_id !== undefined), {
    message: '给了 source_id 就必须同时给 source_type',
  });

const createProfileAction = defineWriteAction({
  name: 'create_profile',
  description:
    '新建一份配置文件（profile）。需用户确认。「从模版新建配置」= copy_from 传模版 id：深拷贝该模版的 base/策略组/规则/设备（克隆不继承模版的节点来源绑定，需用 source_type/source_id 指定或事后 update_profile 绑定）。创建后当前会话作用域不变——MCP 端用 select_profile 切换，网页端用侧栏切换器。',
  input: CreateProfileInput,
  risk: 'write',
  summary: (i) =>
    i.copy_from
      ? `从现有配置克隆新建：${i.name}${i.kind === 'template' ? '（模版）' : ''}`
      : `新建配置文件：${i.name}${i.kind === 'template' ? '（模版）' : ''}`,
  async preview(_ctx, input) {
    if (await getProfileByName(input.name)) {
      throw ProblemDetailsError.conflict(`profile 名称 "${input.name}" 已存在。`);
    }
    let copyFromLabel: string | undefined;
    if (input.copy_from) {
      const src = await getProfile(input.copy_from);
      if (!src) {
        throw ProblemDetailsError.unprocessable(`复制来源配置文件不存在: ${input.copy_from}`);
      }
      copyFromLabel = `${src.name}${src.kind === 'template' ? '（模版）' : ''}`;
    }
    const source = toSource(input.source_type, input.source_id) ?? { type: 'none' };
    const view = profileYaml(
      {
        name: input.name,
        ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
        kind: input.kind,
        source,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      copyFromLabel ? { 克隆自: copyFromLabel } : undefined,
    );
    return { diff: { op: 'add', path: `profiles[${input.name}]`, afterYaml: view } };
  },
  async execute(_ctx, input) {
    const source = toSource(input.source_type, input.source_id);
    const created = await createProfile({
      name: input.name,
      ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
      kind: input.kind,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(source ? { source } : {}),
      ...(input.copy_from ? { copy_from: input.copy_from } : {}),
    });
    return writeResult('add', `已新建配置文件 ${created.name}`, {
      id: created.id,
      name: created.name,
      kind: created.kind,
      hint: '当前会话作用域未切换——MCP 端用 select_profile，网页端用侧栏切换器。',
    });
  },
});

/* ─── update_profile ────────────────────────────────────────────────── */

const UpdateProfileInput = z
  .object({
    id: z.uuid().describe('profile id（先用 list_profiles 拿）'),
    name: z
      .string()
      .min(1)
      .regex(NAME_REGEX, NAME_HINT)
      .optional()
      .describe('改名——分发 URL 含名字，改名会使客户端已导入的旧链接失效；default 不能改名'),
    display_name: z.string().max(120).nullable().optional().describe('传 null 清除'),
    kind: z
      .enum(['normal', 'template'])
      .optional()
      .describe('普通/模版互转，只改类型不动内容；转模版后停止分发（订阅 URL 404）'),
    notes: z.string().nullable().optional().describe('传 null 清除'),
    source_type: SOURCE_TYPE.optional().describe('改节点来源绑定；none=解绑不注入'),
    source_id: z
      .uuid()
      .optional()
      .describe('绑定的订阅源/聚合订阅 id（source_type 为 subscription/collection 时必填）'),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'id' && v[k as keyof typeof v] !== undefined), {
    message: '至少要改一个字段',
  });

const updateProfileAction = defineWriteAction({
  name: 'update_profile',
  description:
    '修改一份配置文件的元数据：改名（会断分发链接，先提醒）/ display_name / 普通↔模版互转 / 备注 / 节点来源绑定（绑订阅源、绑聚合订阅或解绑）。需用户确认。不改配置内容本身（规则/策略组/base 用各自工具）。先 list_profiles 拿 id 与现状。',
  input: UpdateProfileInput,
  risk: 'write',
  summary: (i) => `修改配置文件 ${i.id.slice(0, 8)}…`,
  async preview(_ctx, input) {
    const before = await getProfile(input.id);
    if (!before) throw ProblemDetailsError.notFound(`profile ${input.id} 不存在。`);
    const source = toSource(input.source_type, input.source_id);
    const after: Partial<Profile> = {
      name: input.name ?? before.name,
      display_name:
        input.display_name === null ? undefined : (input.display_name ?? before.display_name),
      kind: input.kind ?? before.kind,
      source: source ?? before.source,
      notes: input.notes === null ? undefined : (input.notes ?? before.notes),
    };
    return {
      diff: {
        op: 'update',
        path: `profiles[${before.name}]`,
        beforeYaml: profileYaml(before),
        afterYaml: profileYaml(after),
      },
    };
  },
  async execute(_ctx, input) {
    const before = await getProfile(input.id);
    if (!before) throw ProblemDetailsError.notFound(`profile ${input.id} 不存在。`);
    const source = toSource(input.source_type, input.source_id);
    const patch: ProfileUpdate = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(source ? { source } : {}),
    };
    const updated = await patchProfile(input.id, patch);
    return writeResult('update', `已修改配置文件 ${before.name}`, {
      id: updated.id,
      name: updated.name,
      kind: updated.kind,
    });
  },
});

export const PROFILE_READ_ACTIONS = [listProfilesAction];
export const PROFILE_WRITE_ACTIONS = [createProfileAction, updateProfileAction];
