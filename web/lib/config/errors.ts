/**
 * A client-safe description of a deterministic configuration failure.
 *
 * Callers must build `message` from fixed text and safe schema identifiers
 * only. Raw YAML, subscription URLs, proxy values and caught error messages do
 * not belong here; infrastructure failures use their own error type instead.
 */
export interface ConfigValidationIssue {
  code: string;
  message: string;
  section: string;
  path: string;
  resource: string;
}

export class ConfigValidationError extends Error {
  public readonly issue: Readonly<ConfigValidationIssue>;

  constructor(issue: ConfigValidationIssue) {
    super(issue.message);
    this.name = 'ConfigValidationError';
    this.issue = Object.freeze({ ...issue });
  }
}

/**
 * The optional full-config preflight could not reach its validator. This is
 * deliberately separate from ConfigValidationError: temporary infrastructure
 * failures must never be reported as if the user's configuration were invalid.
 */
export class ConfigPreflightUnavailableError extends Error {
  constructor() {
    super('Configuration validation is temporarily unavailable.');
    this.name = 'ConfigPreflightUnavailableError';
  }
}
