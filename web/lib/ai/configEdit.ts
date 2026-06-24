/**
 * Path-scoped structured edits to base.yaml (Tier D phase 2).
 *
 * Mutations run on a `yaml` Document so comments / anchors / ordering on
 * untouched nodes survive. The real write path is the `config-section`
 * scenario (audit + undo via dispatch); these helpers are the shared core,
 * also used for dry-run previews so a doomed edit never mints a confirmation.
 *
 * Safety: `assertEditablePath` (Never-List) is enforced by callers before any
 * mutation; `validateReferences` refuses edits that would orphan rules.
 */

import { isMap, isSeq, parse, parseDocument, stringify, type Document } from 'yaml';
import { parseBase } from '@/lib/engine/parser';
import { validateBase } from '@/lib/engine/validator';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { parsePath, type Segment } from './configPath';

/** Parse the AI-supplied value (YAML scalar or block) into a JS value. */
export function parseYamlValue(value: string): unknown {
  return parse(value);
}

interface Resolved {
  /** Path to set/read/delete when the node exists (or a new map key). */
  setPath: (string | number)[];
  /** When set, the leaf is a new named seq item to append to this seq path. */
  appendSeqPath?: (string | number)[];
  existed: boolean;
}

function namedIndex(seq: { items: unknown[] }, name: string): number {
  return seq.items.findIndex((it) => {
    if (!isMap(it)) return false;
    const n = it.get('name', true);
    return n && typeof (n as { value?: unknown }).value === 'string'
      ? (n as { value: string }).value === name
      : false;
  });
}

function resolveDocPath(doc: Document, segs: Segment[]): Resolved {
  const path: (string | number)[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const isLast = i === segs.length - 1;
    path.push(s.key);
    if (s.selector !== undefined) {
      const seqNode = doc.getIn(path, true);
      if (!isSeq(seqNode)) {
        if (isLast) return { setPath: path, appendSeqPath: [...path], existed: false };
        throw ProblemDetailsError.notFound(
          `路径 "${s.key}" 不是序列，无法用 [${s.selector}] 选择。`,
        );
      }
      const idx = namedIndex(seqNode, s.selector);
      if (idx === -1) {
        if (isLast) return { setPath: path, appendSeqPath: [...path], existed: false };
        throw ProblemDetailsError.notFound(`${s.key}[${s.selector}] 不存在。`);
      }
      path.push(idx);
    } else if (!isLast && doc.getIn(path, true) === undefined) {
      throw ProblemDetailsError.notFound(`路径 "${s.key}" 不存在。`);
    }
  }
  return { setPath: path, existed: doc.getIn(path, true) !== undefined };
}

function readJs(doc: Document, path: (string | number)[]): unknown {
  const node = doc.getIn(path, true);
  if (node === undefined) return undefined;
  return (node as { toJSON?: () => unknown }).toJSON?.() ?? node;
}

/** Set/replace (or create) the value at a path. Returns the prior value. */
export function setValueAt(doc: Document, segs: Segment[], jsValue: unknown): { before: unknown } {
  const r = resolveDocPath(doc, segs);
  if (r.appendSeqPath) {
    doc.addIn(r.appendSeqPath, doc.createNode(jsValue));
    return { before: undefined };
  }
  const before = readJs(doc, r.setPath);
  doc.setIn(r.setPath, doc.createNode(jsValue));
  return { before };
}

/** Delete the value at a path. Throws if it doesn't exist. Returns prior value. */
export function deleteValueAt(doc: Document, segs: Segment[]): { before: unknown } {
  const r = resolveDocPath(doc, segs);
  if (r.appendSeqPath || !r.existed) {
    throw ProblemDetailsError.notFound('要删除的路径不存在。');
  }
  const before = readJs(doc, r.setPath);
  doc.deleteIn(r.setPath);
  return { before };
}

/** Refuse a mutation that would leave rules referencing a missing anchor/policy. */
export async function validateReferences(profileId: string, doc: Document): Promise<void> {
  const parsed = parseBase(doc.toString());
  const [rules, groups] = await Promise.all([listRules(profileId), listProxyGroups(profileId)]);
  // 托管策略组计入合法 policy 全集——它们在渲染时注入，不在 base 字面里。
  const v = validateBase(
    parsed,
    rules,
    undefined,
    groups.map((g) => g.name),
  );
  if (!v.valid) {
    const reasons = v.orphans
      .slice(0, 5)
      .map((o) => o.reason)
      .join('；');
    throw ProblemDetailsError.unprocessable(
      `改动会让 ${v.orphans.length} 条规则失去引用：${reasons}`,
    );
  }
}

async function loadDoc(profileId: string): Promise<Document> {
  const base = await getBase(profileId);
  if (!base) throw ProblemDetailsError.unprocessable('base.yaml 尚未初始化。');
  const doc = parseDocument(base.content);
  if (doc.errors.length > 0) {
    throw ProblemDetailsError.unprocessable(`base.yaml 解析失败：${doc.errors[0].message}`);
  }
  return doc;
}

export interface DryRunResult {
  beforeYaml?: string;
  afterYaml?: string;
  existed: boolean;
}

/** Apply a set to a throwaway doc + validate, returning before/after YAML for the confirm card. */
export async function dryRunSet(
  profileId: string,
  path: string,
  value: string,
): Promise<DryRunResult> {
  const doc = await loadDoc(profileId);
  const segs = parsePath(path);
  const jsValue = parseYamlValue(value);
  const { before } = setValueAt(doc, segs, jsValue);
  await validateReferences(profileId, doc);
  return {
    beforeYaml: before === undefined ? undefined : stringify(before).trimEnd(),
    afterYaml: stringify(jsValue).trimEnd(),
    existed: before !== undefined,
  };
}

export async function dryRunDelete(profileId: string, path: string): Promise<DryRunResult> {
  const doc = await loadDoc(profileId);
  const segs = parsePath(path);
  const { before } = deleteValueAt(doc, segs);
  await validateReferences(profileId, doc);
  return {
    beforeYaml: before === undefined ? undefined : stringify(before).trimEnd(),
    existed: true,
  };
}
