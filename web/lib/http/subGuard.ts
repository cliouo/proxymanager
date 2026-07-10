/**
 * Shared guard for the public `/api/sub/*` and `/api/rule-providers/*` routes:
 * validate the subscription token (master / resource-derived / rotated — see
 * lib/auth.requireSubToken) and throttle brute-force by IP (P1-2). The `/api/sub`
 * paths are NOT covered by proxy.ts's admin matcher, so they need their own
 * failed-attempt limiter — an unauthenticated token is otherwise infinitely
 * guessable and, if guessed, yields a full config with node credentials.
 */

import { requireSubToken } from '@/lib/auth';
import { ProblemDetailsError } from '@/lib/http/problem';
import { clientIp, registerAuthFailure } from '@/lib/rateLimit';

export async function guardSubToken(
  request: Request,
  token: string,
  resource?: string,
): Promise<void> {
  try {
    requireSubToken(token, resource);
  } catch (err) {
    // On a bad token, count the failure; once over the window limit, answer 429
    // instead of another 401 so guessing (incl. distributed via CORS) is capped.
    const blocked = await registerAuthFailure('sub', clientIp(request));
    if (blocked) {
      throw ProblemDetailsError.tooManyRequests(
        'Too many failed subscription-token attempts. Try again later.',
      );
    }
    throw err;
  }
}
