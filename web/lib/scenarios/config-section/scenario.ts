/**
 * `config-section` — path-scoped structured edits to base.yaml, driven by the
 * AI assistant's set/delete_config_section write actions (always behind the
 * confirmation handshake).
 *
 * Goes through the dispatcher like any scenario, so it gets audit logging and
 * undo for free. Mutations run via `ctx.base.withDocument` (comment-preserving
 * + ETag-guarded) and are refused if they would orphan rules.
 *
 * No `navHref`: there is no standalone UI page (the Sidebar skips it); it
 * exists purely as the audited/undoable execution target.
 */

import { z } from 'zod';
import { deleteValueAt, parseYamlValue, setValueAt, validateReferences } from '@/lib/ai/configEdit';
import { assertEditablePath, parsePath } from '@/lib/ai/configPath';
import { ProblemDetailsError } from '@/lib/http/problem';
import type { InverseHandler, OpHandler, Scenario } from '../_shared/types';

const SetPayload = z.object({
  path: z.string().min(1).max(200),
  value: z.string().min(1).max(20000),
});
const DeletePayload = z.object({ path: z.string().min(1).max(200) });

function pathFromEvent(event: { target?: { kind: string; field?: string } }): string {
  const path = event.target?.kind === 'base' ? event.target.field : undefined;
  if (!path) throw ProblemDetailsError.unprocessable('审计事件缺少配置路径，无法撤销。');
  return path;
}

const set: OpHandler = async (ctx, raw) => {
  const { path, value } = SetPayload.parse(raw);
  const segs = parsePath(path);
  assertEditablePath(segs);
  const jsValue = parseYamlValue(value);
  let before: unknown;
  await ctx.base.withDocument(async (doc) => {
    before = setValueAt(doc, segs, jsValue).before;
    await validateReferences(ctx.profileId, doc);
  });
  return {
    data: { path, applied: true },
    events: [
      { action: 'set-section', target: { kind: 'base', field: path }, before, after: jsValue },
    ],
  };
};

const del: OpHandler = async (ctx, raw) => {
  const { path } = DeletePayload.parse(raw);
  const segs = parsePath(path);
  assertEditablePath(segs);
  let before: unknown;
  await ctx.base.withDocument(async (doc) => {
    before = deleteValueAt(doc, segs).before;
    await validateReferences(ctx.profileId, doc);
  });
  return {
    data: { path, deleted: true },
    events: [{ action: 'delete-section', target: { kind: 'base', field: path }, before }],
  };
};

const inverseSet: InverseHandler = async (ctx, event) => {
  const path = pathFromEvent(event);
  const segs = parsePath(path);
  assertEditablePath(segs);
  await ctx.base.withDocument(async (doc) => {
    if (event.before === undefined) {
      deleteValueAt(doc, segs); // it was newly created → remove it
    } else {
      setValueAt(doc, segs, event.before); // restore prior value
    }
    await validateReferences(ctx.profileId, doc);
  });
  return {
    data: { path },
    events: [
      {
        action: 'set-section',
        target: { kind: 'base', field: path },
        before: event.after,
        after: event.before,
      },
    ],
  };
};

const inverseDelete: InverseHandler = async (ctx, event) => {
  const path = pathFromEvent(event);
  if (event.before === undefined) {
    throw ProblemDetailsError.unprocessable('缺少删除前快照，无法恢复。');
  }
  const segs = parsePath(path);
  assertEditablePath(segs);
  await ctx.base.withDocument(async (doc) => {
    setValueAt(doc, segs, event.before);
    await validateReferences(ctx.profileId, doc);
  });
  return {
    data: { path },
    events: [
      { action: 'delete-section', target: { kind: 'base', field: path }, after: event.before },
    ],
  };
};

export const configSectionScenario: Scenario = {
  descriptor: {
    id: 'config-section',
    title: '配置区块编辑',
    description: 'AI 按路径读改 base.yaml 区块（确认后生效，可撤销）。',
  },
  ops: { set, delete: del },
  inverses: { 'set-section': inverseSet, 'delete-section': inverseDelete },
};
