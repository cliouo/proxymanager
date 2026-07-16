import { PROBLEM_BASE_URL, ProblemDetailsError, type ProblemDetails } from '@/lib/http/problem';

/** Which deterministic part of a subscription failed validation. */
export type SubscriptionValidationStage = 'definition' | 'content' | 'operators';

/**
 * A subscription is reachable, but its stored definition, returned nodes, or
 * operator pipeline is deterministically invalid.
 *
 * The original ProblemDetails payload is retained for the existing direct
 * subscription APIs. Save-time full-config preflight must use only `stage` and
 * `code`, never the detail, because provider payloads can contain credentials.
 */
export class SubscriptionResolutionValidationError extends ProblemDetailsError {
  constructor(
    public readonly stage: SubscriptionValidationStage,
    public readonly code: string,
    problem: ProblemDetails,
  ) {
    super(problem);
    this.name = 'SubscriptionResolutionValidationError';
  }
}

/**
 * The current remote subscription bytes could not be obtained. This is not
 * evidence that the candidate config is invalid, so preflight maps it to its
 * fixed, credential-free 503 response.
 */
export class SubscriptionUpstreamUnavailableError extends ProblemDetailsError {
  constructor(detail: string) {
    super({
      type: `${PROBLEM_BASE_URL}/bad-request`,
      title: 'Bad Request',
      status: 400,
      detail,
    });
    this.name = 'SubscriptionUpstreamUnavailableError';
  }
}

export function asSubscriptionValidationError(
  error: unknown,
  stage: SubscriptionValidationStage,
  code: string,
  fallbackDetail: string,
): SubscriptionResolutionValidationError {
  if (error instanceof SubscriptionResolutionValidationError) return error;
  if (error instanceof ProblemDetailsError) {
    return new SubscriptionResolutionValidationError(stage, code, error.problem);
  }
  return new SubscriptionResolutionValidationError(stage, code, {
    type: `${PROBLEM_BASE_URL}/bad-request`,
    title: 'Bad Request',
    status: 400,
    detail: fallbackDetail,
  });
}
