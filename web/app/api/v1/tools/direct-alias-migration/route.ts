import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { z } from '@/lib/openapi/zod';
import { resolveScopeProfile } from '@/lib/profileScope';
import {
  BUILTIN_DIRECT,
  executeDirectAliasMigration,
  planDirectAliasMigration,
} from '@/lib/services/directMigrationService';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

const AliasSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'alias 不能包含控制字符')
  .refine((value) => value !== BUILTIN_DIRECT, 'alias 不能是 Mihomo 内建 DIRECT');

const PreviewSchema = z.object({
  action: z.literal('preview'),
  alias: AliasSchema.default('直连'),
});

const ApplySchema = z.object({
  action: z.literal('apply'),
  alias: AliasSchema.default('直连'),
  expected_version: z.number().int().nonnegative(),
  expected_base_etag: z.string().regex(/^[a-f0-9]{16}$/u),
  expected_subscription_failure_signature: z.string().min(1),
});

const InputSchema = z.discriminatedUnion('action', [PreviewSchema, ApplySchema]);

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = InputSchema.parse(raw);
  const profile = await resolveScopeProfile(request);

  if (input.action === 'preview') {
    const plan = await planDirectAliasMigration(profile.id, input.alias);
    return Response.json({
      data: {
        safe: true,
        ...plan.summary,
        expectedVersion: plan.expectedVersion,
        expectedBaseEtag: plan.expectedBaseEtag,
        subscriptionFailureSignature: plan.subscriptionFailureSignature,
      },
    });
  }

  const result = await executeDirectAliasMigration(
    profile.id,
    input.alias,
    input.expected_version,
    input.expected_base_etag,
    resolveActor(request),
    input.expected_subscription_failure_signature,
  );
  return Response.json({
    data: {
      summary: result.summary,
      newVersion: result.newVersion,
      auditEventId: result.auditEventId,
    },
  });
});
