import {
  ClientSafeProblemDetailsError,
  PROBLEM_BASE_URL,
  ProblemDetailsError,
  type ProblemDetails,
} from '@/lib/http/problem';
import {
  MihomoProxyLimitError,
  MihomoProxyValidationError,
} from '@/lib/proxies/mihomoProxyValidator';
import { listSupportedProxyUriSchemes, type ProxyUriParseIssue } from '@/lib/proxies/uriToClash';

/** Which deterministic part of a subscription failed validation. */
export type SubscriptionValidationStage = 'definition' | 'content' | 'operators';

/** Credential-free node location emitted only by the fixed Mihomo validator. */
export interface SubscriptionNodeIssue {
  readonly index: number;
  readonly field: string;
  readonly reason: string;
}

/** Fixed, credential-free causes produced by subscription normalisation. */
export type SubscriptionContentIssue =
  | { readonly kind: 'content_empty' }
  | { readonly kind: 'content_format_unrecognised' }
  | {
      readonly kind: 'proxy_node_limit_exceeded';
      readonly count: number;
      readonly limit: number;
    }
  | {
      readonly kind: 'uri_input_line_limit_exceeded';
      readonly limit: number;
    }
  | {
      readonly kind: 'uri_list_invalid';
      readonly failed: number;
      readonly total: number;
      readonly samples: readonly ProxyUriParseIssue[];
    };

/**
 * A normaliser error whose public detail is derived exclusively from the
 * structured issue above. It is safe for direct APIs, while preflight keeps the
 * same structure instead of reparsing a message.
 */
export class SubscriptionContentValidationError extends ClientSafeProblemDetailsError {
  constructor(public readonly contentIssue: SubscriptionContentIssue) {
    super({
      type: `${PROBLEM_BASE_URL}/bad-request`,
      title: 'Bad Request',
      status: 400,
      detail: describeSubscriptionContentIssue(contentIssue),
    });
    this.name = 'SubscriptionContentValidationError';
  }
}

const SAFE_PROXY_URI_SCHEMES = new Set(listSupportedProxyUriSchemes());

export function describeSubscriptionContentIssue(issue: SubscriptionContentIssue): string {
  switch (issue.kind) {
    case 'content_empty':
      return 'A subscription has no content.';
    case 'content_format_unrecognised':
      return `A subscription content format is not recognised. Supported proxy URI schemes: ${listSupportedProxyUriSchemes()
        .map((scheme) => `${scheme}://`)
        .join(' ')}.`;
    case 'proxy_node_limit_exceeded':
      return `A subscription contains ${issue.count} proxy nodes, exceeding the ${issue.limit} node limit.`;
    case 'uri_input_line_limit_exceeded':
      return `A subscription URI list exceeds the ${issue.limit} physical-line limit.`;
    case 'uri_list_invalid': {
      const noun = issue.failed === 1 ? 'entry' : 'entries';
      const first = issue.samples[0];
      const suffix = first ? `; ${describeProxyUriIssue(first)}` : '';
      return `A subscription URI list has ${issue.failed} invalid ${noun} out of ${issue.total}${suffix}.`;
    }
  }
}

function describeProxyUriIssue(issue: ProxyUriParseIssue): string {
  const subject = issue.line === null ? 'the input' : `line ${issue.line}`;
  const scheme =
    issue.scheme && SAFE_PROXY_URI_SCHEMES.has(issue.scheme) ? issue.scheme : undefined;
  switch (issue.category) {
    case 'input_line_limit':
      return `${subject} exceeds the physical-line limit`;
    case 'unrecognised_text':
      return `${subject} is not a proxy URI`;
    case 'unsupported_scheme':
      return `${subject} uses an unsupported proxy URI scheme`;
    case 'parser_rejected':
      return scheme
        ? `${subject} (${scheme}://) was rejected by the parser`
        : `${subject} was rejected by the parser`;
    case 'parser_resource_limit':
      return scheme
        ? `${subject} (${scheme}://) exceeds a parser resource limit`
        : `${subject} exceeds a parser resource limit`;
  }
}

/**
 * A subscription is reachable, but its stored definition, returned nodes, or
 * operator pipeline is deterministically invalid.
 *
 * The original ProblemDetails payload is retained for the existing direct
 * subscription APIs. Save-time full-config preflight must use only `stage`,
 * `code`, `nodeIssue`, and `contentIssue`, never the detail, because provider
 * payloads can contain credentials. Structured issues are populated only from
 * fixed validators and normaliser classifications.
 */
export class SubscriptionResolutionValidationError extends ProblemDetailsError {
  constructor(
    public readonly stage: SubscriptionValidationStage,
    public readonly code: string,
    problem: ProblemDetails,
    public readonly nodeIssue?: SubscriptionNodeIssue,
    public readonly contentIssue?: SubscriptionContentIssue,
  ) {
    super(problem);
    this.name = 'SubscriptionResolutionValidationError';
  }
}

/* ─── fetch attempt classification (P-FFP v1) ───────────────────────── */

/**
 * The fixed closed enum of eligible remote-attempt failure categories. Only
 * `RemoteFetchAttemptError` instances whose category is IN this enum are
 * stale/skip-eligible; messages, HTTP status, generic ProblemDetails, Zod
 * issues and broad content-stage tests never confer eligibility.
 */
export const SUBSCRIPTION_FETCH_FAILURE_CATEGORIES = [
  'network',
  'timeout',
  'http',
  'response-encoding',
  'response-content-format',
  'proxy-node',
] as const;
export type SubscriptionFetchFailureCategory =
  (typeof SUBSCRIPTION_FETCH_FAILURE_CATEGORIES)[number];

/** Fixed, credential-free sentence per category — the ONLY public text. */
const FETCH_FAILURE_DESCRIPTIONS: Record<SubscriptionFetchFailureCategory, string> = {
  network: 'Upstream fetch failed',
  timeout: 'Upstream fetch timed out',
  http: 'Upstream returned an HTTP error',
  'response-encoding': 'Upstream response is not valid UTF-8',
  'response-content-format': 'Upstream response content is not a valid subscription',
  'proxy-node': 'Upstream response contains invalid proxy nodes',
};

export function describeSubscriptionFetchFailureCategory(
  category: SubscriptionFetchFailureCategory,
): string {
  return FETCH_FAILURE_DESCRIPTIONS[category];
}

/** network / timeout / http are transport outcomes → safe 503. */
const TRANSPORT_CATEGORIES = new Set<SubscriptionFetchFailureCategory>([
  'network',
  'timeout',
  'http',
]);

/**
 * A typed failure of the remote attempt itself (fetch/body transport, HTTP
 * protocol, response encoding/format, or proxy-node validation of newly
 * fetched bytes). Eligibility is `isEligibleFetchFailure` — instanceof plus
 * the closed enum above — and nothing else.
 *
 * The public problem is a fixed category sentence only (no URL, header,
 * credential, raw line, or caught error text). Transport categories carry
 * 503; response-content categories carry 422. `sourceName` is the SAFE slug
 * used by preflight for its structured path; it never enters the problem
 * payload.
 */
export class RemoteFetchAttemptError extends ProblemDetailsError {
  public readonly sourceName?: string;

  constructor(
    public readonly category: SubscriptionFetchFailureCategory,
    options: { sourceName?: string } = {},
  ) {
    const transport = TRANSPORT_CATEGORIES.has(category);
    super({
      type: transport
        ? `${PROBLEM_BASE_URL}/service-unavailable`
        : `${PROBLEM_BASE_URL}/invalid-upstream-response`,
      title: transport ? 'Service Unavailable' : 'Invalid upstream response',
      status: transport ? 503 : 422,
      detail: describeSubscriptionFetchFailureCategory(category),
    });
    this.name = 'RemoteFetchAttemptError';
    this.sourceName = options.sourceName;
  }
}

/**
 * THE only eligibility predicate for stale fallback / collection skip:
 * instanceof `RemoteFetchAttemptError` PLUS membership in the closed enum.
 * A subclass, a forged message, or a generic ProblemDetails never qualifies.
 */
export function isEligibleFetchFailure(error: unknown): error is RemoteFetchAttemptError {
  return (
    error instanceof RemoteFetchAttemptError &&
    SUBSCRIPTION_FETCH_FAILURE_CATEGORIES.includes(error.category)
  );
}

export function asSubscriptionValidationError(
  error: unknown,
  stage: SubscriptionValidationStage,
  code: string,
  fallbackDetail: string,
): SubscriptionResolutionValidationError {
  if (error instanceof SubscriptionResolutionValidationError) return error;
  if (error instanceof SubscriptionContentValidationError) {
    return new SubscriptionResolutionValidationError(
      stage,
      code,
      error.problem,
      undefined,
      error.contentIssue,
    );
  }
  if (error instanceof MihomoProxyLimitError && stage === 'content') {
    return new SubscriptionResolutionValidationError(stage, code, error.problem, undefined, {
      kind: 'proxy_node_limit_exceeded',
      count: error.count,
      limit: error.limit,
    });
  }
  if (error instanceof MihomoProxyValidationError) {
    return new SubscriptionResolutionValidationError(stage, code, error.problem, {
      index: error.index,
      field: error.field,
      reason: error.reason,
    });
  }
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
