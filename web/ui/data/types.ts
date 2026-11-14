/**
 * Client-side view of the API contract. Entity types come straight from the
 * zod schemas (type-only imports, so no validator code reaches the bundle);
 * response envelopes that only exist at the route layer are declared here.
 */
export type {
  AuditEvent,
  AuditTarget,
  BaseValidationResult,
  Collection,
  CollectionCreate,
  CollectionUpdate,
  Device,
  DeviceCreate,
  DeviceUpdate,
  Operator,
  Profile,
  ProfileCreate,
  ProfileKind,
  ProfileSource,
  ProfileUpdate,
  ProxyGroup,
  ProxyGroupCreate,
  ProxyGroupTemplate,
  ProxyGroupType,
  ProxyGroupUpdate,
  Rule,
  RuleCreate,
  RulePatch,
  RuleSet,
  RuleSetCreate,
  RuleSetMeta,
  RuleSetUpdate,
  RuleType,
  SetupApiStatus,
  SetupBootstrapApiResponse,
  StoredOperator,
  SubscriptionAdminView,
  SubscriptionCreate,
  SubscriptionFetchHealth,
  SubscriptionLocalFetchSpec,
  SubscriptionTraffic,
  SubscriptionUpdate,
  TailscaleDeviceFeatureUpdate,
  PublicTailscaleDeviceFeature,
  AssistantConfig,
  AssistantConfigUpdate,
} from '@/schemas';

import type {
  AuditEvent,
  Device,
  PublicDeviceFeatures,
  RuleSetMeta,
  SubscriptionFetchHealth,
} from '@/schemas';
import type { RuleSummary } from '@/lib/services/ruleSummaryTypes';

export type { RuleSummary };

/** Devices as served by the API: feature secrets replaced by `hasAuthKey`. */
export type PublicDevice = Omit<Device, 'features'> & { features: PublicDeviceFeatures };

export type RuleSetListItem = RuleSetMeta & { referenced_in_base: boolean };

export interface DashboardData {
  hasBase: boolean;
  buildId?: string | null;
  counts: {
    subscriptions: number;
    anchors: number;
    rules: number;
    ruleSets: number;
    proxyGroups: number;
  };
  groupTypeBreakdown: Record<string, number>;
  chainCount: number;
  deviceCounts: { total: number; tailscale: number };
  subscriptionHealthSummary: Array<{
    name: string;
    display_name?: string;
    fetch_health?: SubscriptionFetchHealth | null;
  }>;
  lastRenderSummary?: {
    subscriptions: SnapshotSubStatus[];
    warnings: string[];
    unmatchedAnchors: string[];
    anchorsApplied?: number;
    computedAt: number;
    buildId: string;
  } | null;
  recentEventSummaries: Array<{ id: string; ts: number; op: string; actor: string; undoes?: string }>;
  meta: { hasBase: boolean; buildId: string | null; subscriptionUrl: string };
}

export interface SnapshotSubStatus {
  name: string;
  injectedCount: number;
  stale?: boolean;
  staleReason?: string;
  error?: string;
}

export interface Collision {
  name: string;
  keptFrom: string | null;
  droppedFrom: string[];
  resolvedTo?: string;
}

export interface PreviewData {
  rendered_at: number;
  content: string;
  build_id: string;
  anchors_applied: Array<{ anchor: string; ruleCount: number }>;
  unmatched_anchors: string[];
  inlined_proxy_count: number;
  proxy_group_count: number;
  node_names?: string[];
  nodes_by_sub?: Record<string, string[]>;
  collisions?: Collision[];
  subscriptions?: SnapshotSubStatus[];
  warnings: string[];
}

export interface ParsedConfig {
  proxies: Array<{ name: string; type: string; dialerProxy?: string; server?: string }>;
  proxyGroups: Array<{ name: string; type: string; proxies: string[]; dialerProxy?: string }>;
  etag: string;
  updated_at: number;
  resolve: {
    buildId: string;
    inlinedProxyCount: number;
    proxyGroupCount: number;
    nodeNames: string[];
    collisions: Collision[];
    subscriptions: SnapshotSubStatus[];
    warnings: string[];
  };
}

export interface MetaData {
  capabilities: { profileIdScope: boolean };
  subscriptionUrl: string;
  subBase: string;
  ruleProvidersBase: string;
  buildId: string | null;
  hasBase: boolean;
}

export interface BaseData {
  content: string;
  anchors: string[];
  policies: string[];
  etag: string;
  updated_at: number;
}

export interface RulePageMeta {
  total: number;
  summary: RuleSummary;
  limit: number;
  offset: number;
  configVersion: number;
  profileId: string;
}

export interface SourceUsage {
  profiles: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
}

export interface NamesPayload {
  count: number;
  names: string[];
  truncated: boolean;
}

/** One step of a pipeline preview (mirrors `OperatorStep` in lib/proxies/operators.ts). */
export interface OperatorStepTrace {
  id: string;
  kind: string;
  /** False when the step is disabled and was skipped. */
  applied: boolean;
  before: number;
  after: number;
  /** Nodes removed by filters / dedup-drop. */
  dropped: number;
  /** Nodes whose name or properties changed. */
  changed: number;
  /** rename-template only: names that collided and were disambiguated. */
  collisions?: string[];
  /** rename-template only: true duplicates removed by node identity. */
  deduped?: Array<{ kept: string; dropped: string; sourceKey?: string }>;
  /** Up to a few representative before → after names. */
  samples?: Array<{ before: string; after: string }>;
}

export type PreviewIssue =
  | { code: 'duplicate-final-name'; name: string; count: number }
  | { code: 'rename-collision-resolved'; name: string }
  | { code: 'true-dedup'; kept: string; dropped: string }
  | { code: 'orphaned-reference'; kind: string; [key: string]: unknown }
  | { code: string; [key: string]: unknown };

export interface PipelinePreview {
  before: NamesPayload;
  after: NamesPayload;
  steps: OperatorStepTrace[];
  issues: PreviewIssue[];
  memberErrors?: Array<{ name: string; error: string }>;
}

export interface HistoryPage {
  data: AuditEvent[];
  meta: { limit: number; count: number; nextCursor: string | null };
}

export interface ChainSummary {
  fixedChains: Array<{ chainName: string; backend: string; front: string }>;
  poolChains: Array<{
    poolName: string;
    poolMembers: string[];
    chainName: string;
    backend: string;
    smart?: { strategy: 'fallback' | 'url-test'; filter?: string; testUrl: string; interval: number };
  }>;
}

export interface DevicePreview {
  shared: string;
  device: string | null;
  issues: Array<{ code?: string; message: string; path?: string; section?: string }>;
}

export interface WriteWarnings {
  warnings: string[];
}

export type { AuditEvent as HistoryEvent };
