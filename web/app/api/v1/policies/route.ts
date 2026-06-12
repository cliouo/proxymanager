import { mergePolicyUniverse } from '@/lib/engine/parser';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getBase } from '@/lib/repos/baseRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';

export const dynamic = 'force-dynamic';

/**
 * 规则 policy 的合法目标全集：托管策略组(hash，rank 序)在前，其后是
 * base 字面 policies(残留组/手写节点/内建)。base.meta 里存的 policies
 * 只描述 base 字面内容(保存时快照)，策略组增删不会重写 base——所以这里
 * 必须活读 hash 合并，否则规则页选择器看不到托管策略组。
 */
export const GET = withProblemDetails(async () => {
  const [base, groups] = await Promise.all([getBase(), listProxyGroups()]);
  if (!base) {
    throw ProblemDetailsError.notFound('Base config has not been initialized yet.');
  }
  return Response.json({
    data: mergePolicyUniverse(
      groups.map((g) => g.name),
      base.policies,
    ),
  });
});
