import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase, setBase, type BaseMeta } from '@/lib/repos/baseRepo';
import { computeEtag, parseAndValidate } from '@/lib/services/baseService';
import { BaseUpdateRequestSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const base = await getBase();
  if (!base) {
    throw ProblemDetailsError.notFound('Base config has not been initialized yet.');
  }
  return Response.json(
    {
      data: {
        content: base.content,
        anchors: base.anchors,
        policies: base.policies,
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
        policies: meta.policies,
        updated_at: meta.updated_at,
      },
    },
    {
      status: 200,
      headers: { ETag: `"${meta.etag}"` },
    },
  );
});
