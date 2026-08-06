/**
 * POST /api/v1/assistant/naming-analysis — explicit, user-triggered AI
 * analysis for the rename-template (名称统一) operator.
 *
 * Privacy: the client sends ONE opaque { ref } — never type/id — and the
 * server resolves it profile-bound (the caller's current profile source
 * binding authorizes the target). The configured model receives only the
 * bounded sanitized node-name features plus sanitized source labels / opaque
 * ids built by lib/ai/namingAnalysis — never credentials, endpoints,
 * subscription URLs, raw identity, or unsanitized source data. The response
 * includes the exact scrubbed payload so the workbench can show the user
 * what was sent. Neither the raw node data nor the AI payload are logged.
 * The result is a *suggestion* — the deterministic rename-template config
 * only changes when the user applies and saves it.
 *
 * No assistant config → 404 with a clear message; model/validation failure →
 * a safe, non-destructive error. Preview/render/export never depend on this.
 */

import { z } from '@/lib/openapi/zod';
import { resolveScopeProfile } from '@/lib/profileScope';
import {
  NAMING_SCOPE_ERROR,
  callerVisibleNamingTargets,
  resolveRefInVisibleSet,
} from '@/lib/services/namingTargetScope';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { NamingAnalysisRefSchema, runNamingAnalysis } from '@/lib/ai/namingAnalysis';
import { HandleSecretError } from '@/lib/proxies/handles';
import { withSource, type SourceIdentity } from '@/lib/proxies/provenance';
import { getCollection } from '@/lib/services/collectionService';
import { mergeCollectionMemberProxies } from '@/lib/services/nodeExportService';
import { resolveSubscriptionProxiesRaw } from '@/lib/services/subscriptionFetcher';
import { getSubscription, listSubscriptions } from '@/lib/services/subscriptionService';
import { getAssistantConfig } from '@/lib/repos/assistantConfigRepo';

export const dynamic = 'force-dynamic';
// The model call plus a possible cold upstream fetch; explicit ceiling like
// the preview routes.
export const maxDuration = 60;

/** Profile-bound opaque target ref — the ONE shared strict schema; raw
 * type/UUID (and any extra key) never crosses this surface (pass-7 blocker
 * 4); the caller's CURRENT profile source binding authorizes resolution. */
const SourceRef = NamingAnalysisRefSchema;

/**
 * Resolve a source's raw (pre-operator) nodes with provenance attached, so
 * the analysis sees the same source aliases the rename-template executor
 * would use. Read-only: never writes the fetch cache. Absent profile,
 * no-source profile, unbound/foreign targets, wrong-kind, zero/multiple and
 * colliding refs all fail the same bounded non-oracle error BEFORE the
 * assistant-config read (pass-8 blocker 5: the ref is parsed and authorized
 * first). SUBSCRIPTION and COLLECTION targets both resolve — the branch is
 * decided by the AUTHORIZED target, never by a hardcoded kind.
 */
async function resolveRawWithProvenance(
  ref: z.infer<typeof SourceRef>,
  request: Request,
): Promise<Array<Record<string, unknown>>> {
  const profile = await resolveScopeProfile(request);
  const visible = await callerVisibleNamingTargets(profile);
  // Match ANY visible target (type is part of the ref MAC) — wrong-kind and
  // cross-profile refs fail the same bounded error as zero/multiple matches.
  const { type, id } = resolveRefInVisibleSet(profile.id, ref.ref, visible);
  if (type === 'subscription') {
    const sub = await getSubscription(id);
    if (!sub) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
    const { proxies } = await resolveSubscriptionProxiesRaw(sub, { writeCache: false });
    const identity: SourceIdentity = { key: sub.name, label: sub.display_name?.trim() || sub.name };
    return proxies.map((p) => withSource(p, identity));
  }
  const collection = await getCollection(id);
  if (!collection) throw ProblemDetailsError.notFound(NAMING_SCOPE_ERROR);
  const subs = await listSubscriptions();
  const { merged } = await mergeCollectionMemberProxies(collection, subs, { writeCache: false });
  return merged;
}

export const POST = withProblemDetails(async (request: Request) => {
  // pass-8 blocker 5: parse + authorize the profile-bound ref BEFORE the
  // assistant-config read — an unauthorized request fails identically with
  // or without an assistant configured (no information-bearing reads).
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const ref = SourceRef.parse(raw);
  const proxies = await resolveRawWithProvenance(ref, request);

  const config = await getAssistantConfig();
  if (!config) {
    throw ProblemDetailsError.notFound(
      'AI 助手尚未配置；请先在「AI 配置」页填入 DeepSeek 凭证后重试。',
    );
  }

  if (proxies.length === 0) {
    throw ProblemDetailsError.unprocessable('该来源当前没有节点，无法分析。');
  }

  // The model call is driven by the user's stored assistant config — custom
  // base URL / model / key included — never by a server-side env fallback.
  const result = await runNamingAnalysis({
    proxies,
    config: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
      maxTokens: config.maxTokens,
    },
  }).catch((error: unknown) => {
    // pass-5 blocker: a missing/weak handle secret is SERVER misconfiguration
    // — a generic internal 5xx, never a 422 whose detail could reflect the
    // env name or key material.
    if (error instanceof HandleSecretError) {
      throw ProblemDetailsError.internal('AI 分析暂时不可用，请检查服务配置。');
    }
    const message = error instanceof Error ? error.message : '';
    if (message === 'AI 分析暂时不可用，请稍后重试或手动配置。') {
      throw ProblemDetailsError.internal(message);
    }
    throw ProblemDetailsError.unprocessable(message || 'AI 分析失败，请重试或手动配置。');
  });

  return Response.json({
    data: {
      suggestion: result.suggestion,
      // The exact scrubbed payload — shown in the workbench's privacy
      // disclosure. Credential-free by construction.
      payload: result.payload,
    },
  });
});
