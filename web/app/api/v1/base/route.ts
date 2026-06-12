import { mergePolicyUniverse } from '@/lib/engine/parser';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase, setBase, type BaseMeta } from '@/lib/repos/baseRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { computeEtag, parseAndValidate } from '@/lib/services/baseService';
import { BaseUpdateRequestSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const [base, groups] = await Promise.all([getBase(), listProxyGroups()]);
  if (!base) {
    throw ProblemDetailsError.notFound('Base config has not been initialized yet.');
  }
  return Response.json(
    {
      data: {
        content: base.content,
        anchors: base.anchors,
        // 响应里的 policies 是"规则可指向的全集"(托管策略组 + base 字面)；
        // 存库 meta 仍只记 base 字面快照，组的增删不需要重写 base。
        policies: mergePolicyUniverse(
          groups.map((g) => g.name),
          base.policies,
        ),
        etag: base.etag,
        updated_at: base.updated_at,
      },
    },
    {
      headers: {
        ETag: `"${base.etag}"`,
        'Cache-Control': 'no-store',
      },
    },
  );
});

export const PUT = withProblemDetails(async (request: Request) => {
  const rawBody = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const { content } = BaseUpdateRequestSchema.parse(rawBody);

  const ifMatch = request.headers.get('if-match');
  const expectedEtag = ifMatch ? ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '') : null;

  const { parsedBase, validation } = await parseAndValidate(content);
  if (!validation.valid) {
    throw ProblemDetailsError.unprocessable(
      'Base config would orphan existing rules.',
      validation.orphans,
    );
  }

  const meta: BaseMeta = {
    etag: computeEtag(content),
    anchors: parsedBase.anchors,
    policies: parsedBase.policies,
    updated_at: Math.floor(Date.now() / 1000),
  };

  const result = await setBase(content, meta, expectedEtag);
  if (!result.ok) {
    throw ProblemDetailsError.preconditionFailed(
      `Base config has been modified by another writer. Current ETag is ${result.currentEtag ?? '(none)'}.`,
    );
  }

  return Response.json(
    {
      data: {
        etag: meta.etag,
        anchors: meta.anchors,
        // 与 GET 同义：返回合并后的全集(validateBase 已做合并)。
        policies: validation.policies,
        updated_at: meta.updated_at,
      },
    },
    {
      status: 200,
      headers: { ETag: `"${meta.etag}"` },
    },
  );
});
