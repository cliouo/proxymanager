import { withProblemDetails } from '@/lib/http/handler';
import { projectAliasKeysToHandles } from '@/lib/services/sourceAliasResolver';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { listSubscriptions } from '@/lib/services/subscriptionService';
import { ProblemDetailsError } from '@/lib/http/problem';
import { deleteCollection, getCollection, patchCollection } from '@/lib/services/collectionService';
import { CollectionUpdateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/collections/[id]'>;

export const GET = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const col = await getCollection(id);
  if (!col) throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  // pass-6 blocker 2: external payloads carry ONLY opaque src-* handles
  // pass-10 blocker 1: alias projection uses the ENABLED authoritative set
  const members = await enabledCollectionMemberSubs(col, await listSubscriptions()).map(
    (m) => m.name,
  );
  const data = {
    ...col,
    operators: (col.operators ?? []).map((op) => {
      if ((op as { kind?: string }).kind !== 'rename-template') return op;
      const aliases = (op as { sourceAliases?: Record<string, string> }).sourceAliases;
      if (aliases === undefined) return op;
      return { ...op, sourceAliases: projectAliasKeysToHandles(aliases, members) };
    }),
  };
  return Response.json({ data });
});

export const PATCH = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const patch = CollectionUpdateSchema.parse(raw);
  // P2-2: If-Match carries the client's last-known updated_at (optimistic
  // version). Absent → undefined → unchanged last-write-wins behavior.
  const ifMatch = request.headers.get('if-match');
  const parsed = ifMatch ? Number(ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '')) : NaN;
  const expectedUpdatedAt = Number.isFinite(parsed) ? parsed : undefined;
  const updated = await patchCollection(id, patch, expectedUpdatedAt);
  return Response.json({ data: updated });
});

export const DELETE = withProblemDetails(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { removed, warnings } = await deleteCollection(id);
  if (!removed) throw ProblemDetailsError.notFound(`Collection ${id} not found.`);
  // P0-2: delete-but-warn (see subscription DELETE).
  if (warnings.length > 0) return Response.json({ data: { warnings } }, { status: 200 });
  return new Response(null, { status: 204 });
});
