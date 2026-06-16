/**
 * Action registry — single source of truth for every action the assistant
 * can invoke. The orchestrator derives DeepSeek tools from this list, looks
 * actions up by name when the model calls them, and (Tier C) checks each
 * against the Never-List before dispatch.
 *
 * To add an action: define it with `defineAction`, then add it here.
 */

import { searchMihomoDocs } from '../docs';
import { CONFIG_READ_ACTIONS } from './primitives/configReads';
import { CONFIG_WRITE_ACTIONS } from './primitives/configWrites';
import { FETCH_ACTIONS } from './primitives/fetch';
import {
  OPERATOR_READ_ACTIONS,
  OPERATOR_WRITE_ACTIONS,
} from './primitives/operatorWrites';
import {
  PROXY_GROUP_READ_ACTIONS,
  PROXY_GROUP_WRITE_ACTIONS,
} from './primitives/proxyGroupWrites';
import { READ_ACTIONS } from './primitives/reads';
import {
  RULE_PROVIDER_READ_ACTIONS,
  RULE_PROVIDER_WRITE_ACTIONS,
} from './primitives/ruleProviderWrites';
import { WRITE_ACTIONS } from './primitives/writes';
import type { ActionDef } from './types';

const ALL_ACTIONS: ActionDef[] = [
  ...READ_ACTIONS,
  ...CONFIG_READ_ACTIONS,
  ...RULE_PROVIDER_READ_ACTIONS,
  ...PROXY_GROUP_READ_ACTIONS,
  ...OPERATOR_READ_ACTIONS,
  ...FETCH_ACTIONS,
  searchMihomoDocs,
  ...WRITE_ACTIONS,
  ...RULE_PROVIDER_WRITE_ACTIONS,
  ...PROXY_GROUP_WRITE_ACTIONS,
  ...OPERATOR_WRITE_ACTIONS,
  ...CONFIG_WRITE_ACTIONS,
];

const byName = new Map(ALL_ACTIONS.map((a) => [a.name, a]));

export function listActions(): ActionDef[] {
  return ALL_ACTIONS;
}

export function getAction(name: string): ActionDef | undefined {
  return byName.get(name);
}
