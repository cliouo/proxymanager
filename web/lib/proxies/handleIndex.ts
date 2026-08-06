/**
 * Bounded handle-collision failure (round-3 Decision 4).
 *
 * The generic single-token construction/resolution helpers were removed in
 * round 2/3: every semantic handle is built by the complete-domain scope
 * builders in `handleScopes.ts`, which own the exact identity maps and fail
 * bounded on ambiguity. This module retains ONLY the shared bounded collision
 * error constant those builders (and their consumers) use.
 */

/** One bounded failure for every ambiguous handle. */
export const HANDLE_COLLISION_ERROR = '句柄冲突：多个目标映射到同一个不透明句柄，请刷新后重试。';
