/**
 * get_skill_reference — progressive disclosure for the web surface.
 *
 * The four skill bodies are inlined into SYSTEM_PROMPT; their deeper reference
 * files are NOT (token economy). A skill-aware client (Claude Code) reads those
 * files from disk; the browser can't, so this read action serves them from the
 * generated bundle on demand. The model calls it with `<skill-slug>/<file>`
 * (e.g. `managing-clash-config/rule-providers`) when a SKILL.md section points
 * at `references/<file>.md`.
 */

import { z } from 'zod';
import { SKILL_REFERENCES } from '../../skills.generated';
import { defineAction } from '../types';

const REF_KEYS = Object.keys(SKILL_REFERENCES).sort();

const getSkillReference = defineAction({
  name: 'get_skill_reference',
  description:
    '读取某个 skill 的参考资料（references/ 下的深入文档），按需加载。当某段工作法指向 `references/<文件>.md` 而你需要其细节时调用。参数 name 形如 "managing-clash-config/rule-providers"（skill 槽名/文件名去掉 .md）。返回该参考的 Markdown 全文。' +
    `可用的 name：${REF_KEYS.join('、')}。`,
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(128)
      .describe('参考资料键，形如 "<skill-slug>/<file>"，如 managing-clash-config/rules'),
  }),
  risk: 'read',
  async run(_ctx, input) {
    const key = input.name.replace(/\.md$/, '').trim();
    const body = SKILL_REFERENCES[key];
    if (body === undefined) {
      return {
        kind: 'skill-reference',
        data: { error: `未找到参考 "${input.name}"。`, available: REF_KEYS },
      };
    }
    // The dispatcher feeds JSON.stringify(data) to the model, so the markdown
    // body rides along in `data.body`. UI renders the envelope (unknown kind →
    // graceful JSON fallback in cards.tsx).
    return { kind: 'skill-reference', data: { name: key, body } };
  },
});

export const SKILL_REF_ACTIONS = [getSkillReference];
