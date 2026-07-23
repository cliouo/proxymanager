/**
 * 规则集写入的校验闸口。
 *
 * 规则集是**跨配置文件共享**的库，但写它的路径长期只跑了字段级 `assertInvariants`
 * 就直写 —— 于是把一个 behavior 从 `domain` 改成 `ipcidr`、或把 url 改坏，可以让
 * 每一份引用它的配置文件（连同这些配置文件下的每一台设备）在下一次渲染时直接崩掉，
 * 而保存时一声不响。这是先于设备层就存在的缺口，设备层只是把后果放大了。
 *
 * 补法沿用 AGENTS.md「Shared subscription mutation invariant」的既有先例：
 * **一个 profile 作用域的动作不得改写被其它 profile 消费的共享资源，除非它把每一个
 * 消费者都对着同一份候选、同一个配置版本预检过。**
 *
 * 这里把「消费者」精确判定为引用了该名字的 profile —— 判定本身很廉价（规则列表 +
 * base 正文），而全量预检每份配置都要跑一次完整渲染（含上游订阅拉取），代价差一个
 * 数量级。没有引用者时（例如新建一条谁都没用的规则集）本来就不改变任何渲染产物，
 * 自然也不需要预检。
 */

import { ProblemDetailsError } from '@/lib/http/problem';
import { referencedProviderNamesInBaseYaml } from '@/lib/engine/renderer';
import { getBase } from '@/lib/repos/baseRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { listProfiles } from '@/lib/repos/profilesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { isTemplateProfile } from '@/lib/profiles/kind';
import { preflightProfileConfig } from '@/lib/services/configPreflight';
import type { Profile, Rule, RuleSet } from '@/schemas';

/** 一份配置文件对某个规则集名字的引用情况。 */
export interface ReferencingProfile {
  profile: Profile;
  /** 引用该名字的 RULE-SET 规则（重命名时要级联改写的就是它们）。 */
  rules: Rule[];
  /** base 正文里以 `rule-set:` 直接引用（无法自动改写，只能拒绝重命名）。 */
  baseReferences: boolean;
}

/**
 * 找出引用了 `names` 中任一名字的配置文件。
 *
 * 模版一并纳入：模版同样会被渲染与预览，它引用的规则集被改坏了照样是坏的，而且
 * 「从模版新建」会把这份坏配置原样拷进新配置文件 —— 不分发不等于不需要正确。
 */
export async function findReferencingProfiles(
  names: readonly string[],
): Promise<ReferencingProfile[]> {
  const wanted = new Set(names);
  if (wanted.size === 0) return [];
  const profiles = await listProfiles();
  const [ruleLists, bases] = await Promise.all([
    Promise.all(profiles.map((p) => listRules(p.id))),
    Promise.all(profiles.map((p) => getBase(p.id))),
  ]);

  const out: ReferencingProfile[] = [];
  profiles.forEach((profile, i) => {
    const rules = ruleLists[i].filter((r) => r.type === 'RULE-SET' && wanted.has(r.value));
    const baseRefs = referencedProviderNamesInBaseYaml(bases[i]?.content ?? '');
    const baseReferences = [...wanted].some((name) => baseRefs.has(name));
    if (rules.length > 0 || baseReferences) {
      out.push({ profile, rules, baseReferences });
    }
  });
  return out;
}

export interface RuleSetPreflightPlan {
  /** 由**版本括号内**的当前库推导出候选库（meta 级即可 —— 渲染只读 meta 字段）。 */
  candidateSets: (currentSets: RuleSet[]) => RuleSet[];
  /** 重命名级联要改写的规则，按 profile 分组（id-keyed 写集，不是完整列表）。 */
  cascadeWrites?: ReadonlyMap<string, Rule[]>;
  /** 要预检的配置文件。空数组 = 没有消费者，直接返回当前版本。 */
  affected: readonly ReferencingProfile[];
}

/**
 * 对每个受影响的配置文件跑一次完整 preflight（设备校验挂在 preflight 里，随之自动
 * 生效），全部通过后返回可用于 CAS 提交的配置版本。
 *
 * 候选**在版本括号内构造**：`preflightProfileConfig` 传给回调的 `state` 是
 * version-bracketed 的稳定快照，从它推导候选库与候选规则，才能保证「校验的那份状态」
 * 与「提交时的那一代」是同一个世界。括号外先读一份库再拿去当候选，会把并发写者刚落地
 * 的其它规则集变化排除在校验之外。
 *
 * 任意一份 profile 的版本与其它不一致，说明预检期间有并发写 —— 此时没有「同一代」
 * 可言，只能 412 让调用方重来，绝不能挑一个版本硬提交。
 */
export async function preflightRuleSetChange(plan: RuleSetPreflightPlan): Promise<number> {
  if (plan.affected.length === 0) {
    // 没有任何配置文件引用它 → 这次改动不改变任何渲染产物。仍然要拿一个版本号来
    // CAS 提交，保证「读到的库状态」与「写进去的库状态」之间没有别人插队。
    return getConfigVersion();
  }

  let version: number | null = null;
  for (const { profile } of plan.affected) {
    const writes = plan.cascadeWrites?.get(profile.id);
    const byId = new Map((writes ?? []).map((r) => [r.id, r]));
    const checked = await preflightProfileConfig(profile.id, (state) => ({
      ruleSets: plan.candidateSets(state.ruleSets),
      // 候选规则必须是该 profile 的**完整**列表（级联改写后），不是只有被改的那几条。
      ...(byId.size > 0 ? { rules: state.rules.map((r) => byId.get(r.id) ?? r) } : {}),
    })).catch((error: unknown) => {
      // 点名是哪份配置文件被这次改动破坏了 —— 否则用户在规则集页收到一个
      // 「配置校验失败」，完全不知道该去哪一份配置里查。
      if (error instanceof Error && !(error instanceof ProblemDetailsError)) {
        error.message = `配置文件「${profile.name}」会被这次规则集改动破坏：${error.message}`;
      }
      throw error;
    });

    if (version === null) version = checked.configVersion;
    else if (version !== checked.configVersion) {
      throw ProblemDetailsError.preconditionFailed(
        '配置在保存前校验期间被其他写入修改,请刷新后重试。',
      );
    }
  }
  return version ?? (await getConfigVersion());
}

/** 非模版的受影响配置文件 —— 仅用于面向用户的措辞，不影响是否预检。 */
export function distributableNames(affected: readonly ReferencingProfile[]): string[] {
  return affected.filter((a) => !isTemplateProfile(a.profile)).map((a) => a.profile.name);
}
