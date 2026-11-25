import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  getProfileCardSummaries,
  MAX_PROFILE_SUMMARY_BATCH,
} from '@/lib/repos/profileSummaryRepo';

export const dynamic = 'force-dynamic';

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const GET = withProblemDetails(async (request: Request) => {
  const rawIds = new URL(request.url).searchParams.get('ids') ?? '';
  const ids = [...new Set(rawIds.split(',').map((part) => part.trim()).filter(Boolean))];

  if (ids.length === 0) {
    throw ProblemDetailsError.unprocessable('Query parameter "ids" must include at least one profile id.');
  }
  if (ids.length > MAX_PROFILE_SUMMARY_BATCH) {
    throw ProblemDetailsError.unprocessable(
      `At most ${MAX_PROFILE_SUMMARY_BATCH} profile ids are allowed per summaries request.`,
    );
  }
  for (const id of ids) {
    if (!PROFILE_ID_RE.test(id)) {
      throw ProblemDetailsError.unprocessable(`Invalid profile id "${id}".`);
    }
  }

  const data = await getProfileCardSummaries(ids);
  return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
});
