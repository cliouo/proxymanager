/**
 * Derive DeepSeek (OpenAI-compatible) function-calling tools from the action
 * registry. One ActionDef → one tool. The input zod schema becomes the
 * function `parameters` JSON Schema via zod v4's `z.toJSONSchema`.
 */

import { z } from 'zod';
import type { ActionDef } from './actions/types';

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function inputToJsonSchema(action: ActionDef): Record<string, unknown> {
  // draft-07 is the dialect OpenAI-style function calling expects.
  const schema = z.toJSONSchema(action.input, { target: 'draft-7' }) as Record<string, unknown>;
  // Strip the dialect marker; tool schemas don't carry it.
  delete schema.$schema;
  return schema;
}

export function actionsToTools(actions: ActionDef[]): DeepSeekTool[] {
  return actions.map((action) => ({
    type: 'function',
    function: {
      name: action.name,
      description: action.description,
      parameters: inputToJsonSchema(action),
    },
  }));
}
