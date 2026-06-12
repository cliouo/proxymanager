/**
 * 极简 OpenAPI 3.1 读取层 —— 只服务于 /docs 的渲染需求。
 * spec 来自真实的 /api/v1/openapi.json;这里不做完整校验,
 * 只做 $ref 解析、属性行扁平化、示例骨架与 cURL 生成。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SchemaObj = Record<string, any>;

export interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: SchemaObj[];
  requestBody?: SchemaObj;
  responses?: Record<string, SchemaObj>;
}

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  security?: unknown[];
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, SchemaObj> };
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpEntry {
  method: HttpMethod;
  path: string;
  op: Operation;
  /** op-level `security: []` 表示公开端点(覆盖全局 bearerAuth)。 */
  isPublic: boolean;
  anchor: string;
}

export function anchorFor(method: string, path: string): string {
  return `op-${method}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** 按 spec 内出现顺序分组到 tag(未标记的归入 "other")。 */
export function groupByTag(spec: OpenApiSpec): { tag: string; ops: OpEntry[] }[] {
  const groups = new Map<string, OpEntry[]>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? 'other';
      const list = groups.get(tag) ?? [];
      list.push({
        method,
        path,
        op,
        isPublic: Array.isArray(op.security) && op.security.length === 0,
        anchor: anchorFor(method, path),
      });
      groups.set(tag, list);
    }
  }
  return Array.from(groups.entries()).map(([tag, ops]) => ({ tag, ops }));
}

/** 解析 $ref(只支持 #/components/schemas/X,够用)。返回解析结果与引用名。 */
export function resolveRef(
  spec: OpenApiSpec,
  schema: SchemaObj | undefined,
): { schema: SchemaObj | undefined; refName?: string } {
  if (!schema) return { schema: undefined };
  const ref = schema.$ref as string | undefined;
  if (!ref) return { schema };
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
  const target = m ? spec.components?.schemas?.[m[1]] : undefined;
  return { schema: target, refName: m?.[1] };
}

/** 人类可读的类型标签:string / integer / string[] / enum / 引用名 / object。 */
export function typeLabel(spec: OpenApiSpec, raw: SchemaObj | undefined): string {
  const { schema, refName } = resolveRef(spec, raw);
  if (!schema) return '';
  if (refName) return refName;
  if (schema.enum) return `enum`;
  if (schema.oneOf) return `oneOf(${(schema.oneOf as SchemaObj[]).length})`;
  if (schema.anyOf) return `anyOf(${(schema.anyOf as SchemaObj[]).length})`;
  const t = schema.type;
  if (t === 'array') {
    const inner = typeLabel(spec, schema.items);
    return inner ? `${inner}[]` : 'array';
  }
  if (t === 'object' || (t === undefined && schema.properties)) return 'object';
  if (Array.isArray(t)) return t.join(' | ');
  return String(t ?? '');
}

export interface PropRow {
  name: string;
  depth: number;
  type: string;
  required: boolean;
  description?: string;
  deflt?: string;
  enums?: string[];
}

/** 把 object schema 扁平化成属性行(嵌套对象/数组项展开一层,最大 depth 2)。 */
export function propRows(
  spec: OpenApiSpec,
  raw: SchemaObj | undefined,
  depth = 0,
): PropRow[] {
  const { schema } = resolveRef(spec, raw);
  if (!schema || depth > 2) return [];
  // oneOf/anyOf:取第一个变体展示(文档示意,完整定义见下载的 spec)。
  const eff = (schema.oneOf?.[0] ?? schema.anyOf?.[0])
    ? resolveRef(spec, schema.oneOf?.[0] ?? schema.anyOf?.[0]).schema ?? schema
    : schema;
  const props = eff.properties as Record<string, SchemaObj> | undefined;
  if (!props) return [];
  const required = new Set<string>((eff.required as string[]) ?? []);
  const rows: PropRow[] = [];
  for (const [name, p] of Object.entries(props)) {
    const { schema: ps } = resolveRef(spec, p);
    rows.push({
      name,
      depth,
      type: typeLabel(spec, p),
      required: required.has(name),
      description: ps?.description,
      deflt: ps?.default !== undefined ? JSON.stringify(ps.default) : undefined,
      enums: ps?.enum ? (ps.enum as unknown[]).map((v) => String(v)) : undefined,
    });
    // 展开嵌套对象 / 对象数组的下一层。
    const inner = ps?.type === 'array' ? resolveRef(spec, ps.items).schema : ps;
    if (inner && (inner.properties || inner.oneOf || inner.anyOf) && depth < 2) {
      rows.push(...propRows(spec, inner, depth + 1));
    }
  }
  return rows;
}

/** 从 schema 派生示例骨架(default → enum 首项 → 类型占位符)。 */
export function exampleOf(spec: OpenApiSpec, raw: SchemaObj | undefined, depth = 0): unknown {
  const { schema } = resolveRef(spec, raw);
  if (!schema || depth > 3) return undefined;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf || schema.anyOf) {
    return exampleOf(spec, schema.oneOf?.[0] ?? schema.anyOf?.[0], depth);
  }
  const t = schema.type;
  if (t === 'object' || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, SchemaObj>)) {
      const ex = exampleOf(spec, v, depth + 1);
      if (ex !== undefined) out[k] = ex;
    }
    return out;
  }
  if (t === 'array') {
    const item = exampleOf(spec, schema.items, depth + 1);
    return item === undefined ? [] : [item];
  }
  if (t === 'string') return '<string>';
  if (t === 'integer' || t === 'number') return 0;
  if (t === 'boolean') return false;
  return undefined;
}

/** 生成 cURL 示例(真实路径 + 鉴权头 + 由 schema 派生的请求体骨架)。 */
export function curlFor(spec: OpenApiSpec, entry: OpEntry, origin: string): string {
  const lines: string[] = [];
  const url = `${origin}${entry.path}`;
  const methodFlag = entry.method === 'get' ? '' : ` -X ${entry.method.toUpperCase()}`;
  lines.push(`curl${methodFlag} '${url}'`);
  if (!entry.isPublic) lines.push(`  -H 'Authorization: Bearer $ADMIN_KEY'`);
  const bodySchema = entry.op.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    lines.push(`  -H 'Content-Type: application/json'`);
    const ex = exampleOf(spec, bodySchema);
    const json = JSON.stringify(ex ?? {}, null, 2).replace(/'/g, "'\\''");
    lines.push(`  -d '${json}'`);
  }
  return lines.join(' \\\n');
}
