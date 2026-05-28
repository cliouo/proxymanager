import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { createProfile, listProfiles } from '@/lib/services/profileService';
import { ProfileCreateSchema } from '@/schemas';

export const dynamic = 'force-dynamic';

export const GET = withProblemDetails(async () => {
  const data = await listProfiles();
  return Response.json({ data, meta: { total: data.length } });
});

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = ProfileCreateSchema.parse(raw);
  const created = await createProfile(input);
  return Response.json(
    { data: created },
    { status: 201, headers: { Location: `/api/v1/profiles/${created.id}` } },
  );
});
