import { ZodError } from 'zod';
import {
  PROBLEM_BASE_URL,
  ProblemDetailsError,
  problemResponse,
  type ProblemDetails,
} from './problem';

type RouteHandler<TArgs extends unknown[]> = (...args: TArgs) => Promise<Response>;

export function withProblemDetails<TArgs extends unknown[]>(
  handler: RouteHandler<TArgs>,
): RouteHandler<TArgs> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return toProblemResponse(err);
    }
  };
}

function toProblemResponse(err: unknown): Response {
  if (err instanceof ProblemDetailsError) {
    return problemResponse(err.problem);
  }

  if (err instanceof ZodError) {
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/validation-error`,
      title: 'Request validation failed',
      status: 422,
      detail: formatZodIssues(err),
      errors: err.issues,
    });
  }

  console.error('[unhandled-route-error]', err);
  const detail = err instanceof Error ? err.message : undefined;
  const problem: ProblemDetails = {
    type: `${PROBLEM_BASE_URL}/internal`,
    title: 'Internal Server Error',
    status: 500,
    detail,
  };
  return problemResponse(problem);
}

/** Turn Zod issues into a single human-readable detail string, e.g. "标识: ...; url: ...". */
function formatZodIssues(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('；');
}
