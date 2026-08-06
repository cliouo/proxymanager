import { withProblemDetails } from '@/lib/http/handler';
import { projectAliasKeysToHandles } from '@/lib/services/sourceAliasResolver';
import { enabledCollectionMemberSubs } from '@/lib/engine/resolve';
import { listSubscriptions } from '@/lib/services/subscriptionService';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createCollection, listCollections } from '@/lib/services/collectionService';
import { CollectionCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const cols = await listCollections();
  const subs = await listSubscriptions();
  const data = cols.map((col) => {
    // pass-10 blocker 1: alias projection uses the ENABLED authoritative set
    const members = enabledCollectionMemberSubs(col, subs).map((m) => m.name);
    return {
      ...col,
      operators: (col.operators ?? []).map((op) => {
        if ((op as { kind?: string }).kind !== 'rename-template') return op;
        const aliases = (op as { sourceAliases?: Record<string, string> }).sourceAliases;
        if (aliases === undefined) return op;
        return { ...op, sourceAliases: projectAliasKeysToHandles(aliases, members) };
      }),
    };
  });
  return Response.json({ data, meta: { total: data.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = CollectionCreateSchema.parse(raw);
  const created = await createCollection(input);
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/collections/${created.id}` } },
  );
});
