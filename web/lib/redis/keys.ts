export const REDIS_KEYS = {
  /**
   * Per-profile base skeleton. Phase 2 made base/rules/proxy-groups owned by
   * each profile (keyed by profile id) instead of a single global instance —
   * see {@link legacy} for the pre-migration global keys the migration reads.
   */
  base: {
    content: (profileId: string): string => `base:content:${profileId}`,
    meta: (profileId: string): string => `base:meta:${profileId}`,
  },
  /** Per-profile routing rules. Hash keyed by rule id. */
  rules: (profileId: string): string => `rules:${profileId}`,
  /**
   * Per-profile devices (设备层, P1). Hash keyed by device id — mirrors the
   * `rules:${profileId}` shape. Each record carries the device's RFC 7386
   * `base_patch` over the profile's final rendered config. Writes bump
   * `config:version` in the same Lua/multi, which is what invalidates both the
   * shared and the device render caches (no explicit invalidation anywhere).
   * Deleting a profile drops this key in the same multi.
   */
  devices: (profileId: string): string => `devices:${profileId}`,
  subscriptions: 'subscriptions',
  proxies: 'proxies',
  ruleSets: 'rule-sets',
  /**
   * Audit log. `events` is a ZSET (score=ts ms, member=event id) used for
   * time-ordered listing. `byId` is a Hash keyed by event id storing the
   * full payload as JSON. Kept consistent via pipelined writes.
   */
  audit: {
    events: 'audit:events',
    byId: 'audit:by_id',
  },
  /**
   * Project-defined taxonomy that doesn't live in base.yaml. Used by
   * scenarios to distinguish proxy-groups by user intent (regional vs
   * platform vs custom) when the Clash schema treats them identically.
   * Hash keyed by group name → JSON {kind, region?, color?}. Per-profile
   * (Phase 2): proxy-groups are owned per profile and names can collide
   * across profiles, so taxonomy is scoped by profile id too.
   */
  taxonomy: {
    groups: (profileId: string): string => `taxonomy:groups:${profileId}`,
  },
  /**
   * Fetch cache for remote subscription bodies. Each entry is a standalone
   * Redis key with EX TTL so it auto-expires; we don't use a Hash because
   * Upstash doesn't expose per-field TTL.
   */
  fetchCache: (cacheKey: string): string => `fetch-cache:${cacheKey}`,
  /**
   * Aggregated subscription collections. Hash keyed by collection id.
   */
  collections: 'collections',
  /**
   * Managed proxy-groups (策略组). Per-profile (Phase 2): Hash keyed by group
   * id, one hash per profile id. Values include every native mihomo proxy-group
   * field plus our metadata (kind/section/rank/template_id/notes). Migrated out
   * of base.yaml's `proxy-groups:` block — base now only carries a
   * `# === PROXY-GROUPS ===` marker.
   */
  proxyGroups: (profileId: string): string => `proxy-groups:${profileId}`,
  /**
   * Shared-defaults templates for proxy-groups (the moral equivalent of the
   * `&pr` YAML anchor). Hash keyed by template id; referenced by
   * proxyGroups via `template_id`.
   */
  proxyGroupTemplates: 'proxy-group-templates',
  /**
   * Managed configuration profiles. Hash keyed by profile id; holds the
   * subscription binding list (and, in Phase 2, per-profile base/rule/group
   * overlays). `/api/v1/preview/[profile]` looks up by `name`.
   */
  profiles: 'profiles',
  /**
   * Cached summary of the most recent successful resolveConfig() — node
   * names, collisions, per-sub status. Readers (UI pickers, AI tools) that
   * only need the resolved node list can hit this instead of re-running the
   * pipeline. A Redis HASH keyed by profile id (P2-5): each profile owns its
   * own field so a render of one profile can't overwrite another's node list.
   * Invalidated (whole hash DEL) on subscription mutations and rewritten (HSET)
   * on every successful resolveConfig. A long whole-hash EX is a GC safety net.
   */
  resolvedSnapshot: 'resolved:snapshot',
  /**
   * Pending AI write confirmations. Each is a standalone key with a short
   * EX TTL holding the {actor, action, input} to execute once the user
   * authorises it; consumed atomically (one-time) via GETDEL.
   */
  assistantConfirm: (token: string): string => `assistant:confirm:${token}`,
  /**
   * Per-conversation assistant transcript (full message thread incl. tool
   * calls / tool results / reasoning_content), so follow-up turns keep the
   * context the model already gathered. Standalone key with EX TTL.
   */
  assistantSession: (id: string): string => `assistant:session:${id}`,
  /**
   * Assistant runtime config — the user's own DeepSeek credentials + model
   * knobs, set from the 「AI 配置」 page. A single JSON blob (one user). The
   * browser caches it to localStorage on load and calls DeepSeek directly,
   * so this is read once per page load rather than per turn.
   */
  assistantConfig: 'assistant:config',
  /**
   * Global config version — a monotonically increasing counter (INCR) bumped
   * by every repo write that can affect the rendered config (base / rules /
   * rule-sets / subscriptions / collections / profiles / proxy-groups /
   * templates). Read by the render cache to decide whether a cached render
   * is still valid; one counter for everything keeps invalidation trivially
   * correct at the cost of occasional over-invalidation.
   */
  configVersion: 'config:version',
  /**
   * Cached output of renderProfileConfig() — the full resolveConfig result
   * plus the config version it was rendered at. Validated on read against
   * `config:version`, the request's providerUrlBase and a freshness window
   * derived from the participating subscriptions' ttl_ms. EX slightly above
   * the freshness window acts as garbage collection.
   */
  renderCache: (profile: string): string => `render:${profile}`,
  /**
   * Cached device render — the shared render with that device's `base_patch`
   * applied. Validated on read against the exact same quadruple as the shared
   * entry (epoch / config:version / providerUrlBase / freshness), so a device
   * write (which INCRs config:version) invalidates it with no explicit logic.
   * Keyed by device **id**, not name, so renaming a device can't resurrect a
   * previous device's entry.
   */
  deviceRenderCache: (profile: string, deviceId: string): string =>
    `render:${profile}:device:${deviceId}`,
  /**
   * Rule-set content, split out of the `rule-sets` hash. The hash field keeps
   * only the meta record (content stored as ''); the potentially huge body
   * (thousands of lines for local rule-sets) lives here as a standalone key.
   * Rationale: listRuleSets() HGETALLs the hash on every render, and the
   * render path only needs name/behavior/format/url/interval/proxy/source to
   * emit `rule-providers:` declarations — keeping content inline meant every
   * render dragged the entire library body across the wire for nothing.
   * Readers fall back to the legacy embedded `content` for unmigrated fields.
   */
  ruleSetContent: (id: string): string => `rule-set-content:${id}`,
  /**
   * Pre-Phase-2 GLOBAL key literals for base/rules/proxy-groups/taxonomy,
   * back when those were single shared instances. Only the per-profile
   * migration script reads these (to move data into the `default` profile's
   * scope) and writes timestamped backups; nothing else should reference them.
   */
  legacy: {
    baseContent: 'base:content',
    baseMeta: 'base:meta',
    rules: 'rules',
    proxyGroups: 'proxy-groups',
    taxonomyGroups: 'taxonomy:groups',
  },
} as const;
