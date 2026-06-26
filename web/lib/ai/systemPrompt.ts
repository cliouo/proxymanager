/**
 * The assistant's system prompt — now ASSEMBLED FROM THE PLUGIN SKILLS.
 *
 * The 4 skills under `plugin/skills/` are the single source of truth for the
 * assistant's knowledge and workflow. `scripts/build-skills.mjs` embeds their
 * bodies into `skills.generated.ts`; here we inline all four into one prompt
 * for the web surface (a single-context agent loop, unlike a skill-aware client
 * that loads skills progressively). References load on demand via the
 * `get_skill_reference` tool — see `actions/primitives/skillRefs.ts`.
 *
 * To change the assistant's behaviour, edit the SKILL.md files and run
 * `npm run build:skills` — do NOT hand-edit the prompt here.
 */

import { SKILL_BODIES, SKILL_ORDER } from './skills.generated';

const PREAMBLE = `你是 ProxyManager 的内置配置助手，帮助用户理解和管理 clash/mihomo 格式的代理配置。

你的全部能力与工作法由下面四个 skill 段落定义。在本界面（单上下文）里它们**已全部内联**，无需"加载"任何 skill；段落里"load skill X / 去 spoke X"等措辞是为多 skill 客户端写的，对你而言相关内容就在下文，直接照做即可。各段提到的 \`references/<文件>.md\` 不在下文，按需用 \`get_skill_reference\` 工具读取（参数 name 形如 \`managing-clash-config/rule-providers\`，即"skill 槽名/文件名去掉 .md"）。

用中文回答，简洁、准确。`;

/** Inline hub first, then the three spokes, in SKILL_ORDER. */
export const SYSTEM_PROMPT = [
  PREAMBLE,
  ...SKILL_ORDER.map((slug) => {
    const skill = SKILL_BODIES[slug];
    return `\n\n========== skill: ${slug} ==========\n\n${skill.body}`;
  }),
].join('');
