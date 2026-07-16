export const PROBLEM_BASE_URL = 'https://proxymanager.dev/errors';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: unknown[];
  [extension: string]: unknown;
}

export class ProblemDetailsError extends Error {
  public readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemDetailsError';
    this.problem = problem;
  }

  static unauthorized(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/unauthorized`,
      title: 'Unauthorized',
      status: 401,
      detail,
    });
  }

  static forbidden(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/forbidden`,
      title: 'Forbidden',
      status: 403,
      detail,
    });
  }

  static notFound(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/not-found`,
      title: 'Not Found',
      status: 404,
      detail,
    });
  }

  static badRequest(detail?: string, errors?: unknown[]): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/bad-request`,
      title: 'Bad Request',
      status: 400,
      detail,
      errors,
    });
  }

  static conflict(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/conflict`,
      title: 'Conflict',
      status: 409,
      detail,
    });
  }

  static preconditionFailed(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/precondition-failed`,
      title: 'Precondition Failed',
      status: 412,
      detail,
    });
  }

  static unprocessable(detail?: string, errors?: unknown[]): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/unprocessable-entity`,
      title: 'Unprocessable Entity',
      status: 422,
      detail,
      errors,
    });
  }

  static tooManyRequests(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/rate-limited`,
      title: 'Too Many Requests',
      status: 429,
      detail,
    });
  }

  static internal(detail?: string): ProblemDetailsError {
    return new ProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/internal`,
      title: 'Internal Server Error',
      status: 500,
      detail,
    });
  }
}

/**
 * Marker for fixed, credential-free problem details that may be shown through
 * the assistant/MCP boundary. Ordinary ProblemDetailsError text is not trusted:
 * parser diagnostics can contain raw YAML source lines and secrets.
 */
export class ClientSafeProblemDetailsError extends ProblemDetailsError {
  static badRequest(detail: string, errors?: unknown[]): ClientSafeProblemDetailsError {
    return new ClientSafeProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/bad-request`,
      title: 'Bad Request',
      status: 400,
      detail,
      errors,
    });
  }

  static notFound(detail: string): ClientSafeProblemDetailsError {
    return new ClientSafeProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/not-found`,
      title: 'Not Found',
      status: 404,
      detail,
    });
  }

  static conflict(detail: string): ClientSafeProblemDetailsError {
    return new ClientSafeProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/conflict`,
      title: 'Conflict',
      status: 409,
      detail,
    });
  }

  static unprocessable(detail: string, errors?: unknown[]): ClientSafeProblemDetailsError {
    return new ClientSafeProblemDetailsError({
      type: `${PROBLEM_BASE_URL}/unprocessable-entity`,
      title: 'Unprocessable Entity',
      status: 422,
      detail,
      errors,
    });
  }
}

export function problemResponse(problem: ProblemDetails, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: {
      'Content-Type': 'application/problem+json',
      ...(extraHeaders ? Object.fromEntries(new Headers(extraHeaders)) : {}),
    },
  });
}
