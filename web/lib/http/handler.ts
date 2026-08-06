import { z } from '@/lib/openapi/zod';
import { HandleSecretError } from '@/lib/proxies/handles';
import {
  ConfigMissingError,
  ConfigPreflightUnavailableError,
  ConfigValidationError,
} from '@/lib/config/errors';
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

  // pass-6 blocker 3: a typed handle-secret configuration failure is caught
  // BEFORE the generic handler logs the raw error object — the log carries
  // at most the stable safe code, and the response is a generic 5xx with no
  // env name, key material, raw message or stack.
  if (err instanceof HandleSecretError) {
    console.error('[handle-secret-config]', err.code);
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/internal`,
      title: 'Internal Server Error',
      status: 500,
    });
  }

  if (err instanceof ConfigValidationError) {
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/config-validation`,
      title: 'Configuration validation failed',
      status: 422,
      detail: err.issue.message,
      errors: [err.issue],
    });
  }

  if (err instanceof ConfigMissingError) {
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/config-missing`,
      title: 'Configuration not found',
      status: 404,
      detail: err.message,
      resource: err.resource,
    });
  }

  if (err instanceof ConfigPreflightUnavailableError) {
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/config-validation-unavailable`,
      title: 'Service Unavailable',
      status: 503,
      detail: err.message,
    });
  }

  if (err instanceof z.ZodError) {
    return problemResponse({
      type: `${PROBLEM_BASE_URL}/validation-error`,
      title: 'Request validation failed',
      status: 422,
      detail: formatZodIssues(err),
      errors: err.issues,
    });
  }

  console.error('[unhandled-route-error]', err);
  // P3-15: don't leak internal error text (which can carry Redis hostnames /
  // stack details) to clients in production. The full error is always logged
  // above; the response detail is only echoed outside production.
  const detail =
    process.env.NODE_ENV === 'production'
      ? undefined
      : err instanceof Error
        ? err.message
        : undefined;
  const problem: ProblemDetails = {
    type: `${PROBLEM_BASE_URL}/internal`,
    title: 'Internal Server Error',
    status: 500,
    detail,
  };
  return problemResponse(problem);
}

/** Turn Zod issues into a single human-readable detail string, e.g. "标识: ...; url: ...". */
function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('；');
}
