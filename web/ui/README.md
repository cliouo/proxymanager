# ProxyManager UI — "Transit" design language

The management UI is a client-rendered app on top of the admin API
(`/api/v1/*`, `Authorization: Bearer <ADMIN_KEY>`). Everything visual lives in
`web/ui/`; routes live in `web/app/(app)/(shell)/…`.

## Concept

Traffic routing is a transit network. **Every policy group is a coloured
line**; rules are stops evaluated top-to-bottom with `MATCH` as the terminus;
nodes are destinations (flags); subscription sources are depots that feed
nodes; devices are the riders. The colour of a group is identical everywhere
(rules rail, group list, flow map, chips) so you can follow a line across the
app.

Colour assignment (`ActiveLineColors` in `ui/shell/scope.tsx`) depends only on
group definitions, never on rules: groups people route to (manual picks, bound
sources) claim the 10 distinct colours first, node pools (`filter` / `all`) fill
in after, by rank. Built-ins use neutral lines (`DIRECT` slate, `REJECT` ink).

Visual tone: warm paper canvas, ink type, a single ultramarine accent used
sparingly for selection/focus/links, the transit palette for data, serif
numerals (Instrument Serif) for hero numbers. Calm, precise, editorial — never
noisy. Prefer whitespace and hairlines over boxes inside boxes.

## Scope model (important for IA)

- **Profile-scoped** (each profile owns them): proxy groups, rules, base YAML,
  devices, chains, dashboard, rendered output. Routes: `/p/[profile]/…`.
  Always pass `profileId` (`useScope().profileId`) on API calls.
- **Global / shared** across profiles: subscription sources (`/sources`),
  collections a.k.a. 聚合订阅 / pools (`/pools/[id]`), rule-sets
  (`/rule-sets`), profiles (`/profiles`), history, settings.
- Editing a shared resource can change every profile's render — say so in the
  UI when it matters (e.g. "被 2 个配置文件使用").

## Tokens → Tailwind classes

| Purpose | Classes |
| --- | --- |
| App background / main panel / card | `bg-canvas` / `bg-panel` / `bg-surface` |
| Subtle fills (hover, wells, inputs disabled) | `bg-surface-2`, `bg-surface-3`, `bg-sunken` |
| Hairlines | `border-line`, stronger `border-line-strong` |
| Text | `text-ink` (primary), `text-ink-2` (secondary), `text-ink-3` (meta), `text-ink-4` (placeholder/disabled) |
| Accent | `text-accent`, `bg-accent`, `bg-accent-soft`, `border-accent-line` |
| Status | `text-ok/bg-ok-soft`, `text-warn/bg-warn-soft`, `text-bad/bg-bad-soft` |
| Inverse (primary buttons, tooltips) | `bg-inverse text-inverse-ink` |
| Transit lines | CSS vars `var(--l-1)` … `var(--l-10)`, `var(--l-direct)`, `var(--l-reject)` |
| Type sizes | `text-2xs` 11 · `text-xs` 12 · `text-sm` 13 · `text-base` 14 · `text-md` 15; page title is 26px (PageHeader) |
| Fonts | `font-sans` (Geist + PingFang), `font-mono` (Geist Mono), `font-display` (Instrument Serif — numerals/hero only) |
| Radii | `rounded-md` 8 (controls) · `rounded-lg` 11 · `rounded-xl` 14 (cards) · `rounded-2xl` 18 (dialogs/panels) |
| Shadows | `shadow-xs` (cards) · `shadow-sm` · `shadow-md` (hover) · `shadow-lg` (popovers) · `shadow-xl` (dialogs) |
| Numbers | add `tnum` for tabular numerals |

Never hard-code hex colours in components — use tokens so dark mode works.
Use `color-mix(in srgb, var(--l-3) 12%, transparent)` for tinted fills of line
colours.

## Layout

```tsx
<Page>                      // centred column, width="narrow|default|wide|full"
  <PageHeader title="规则" description="…" actions={<Button …/>} />
  <div className="flex flex-col gap-8"> <Block title="…">…</Block> </div>
</Page>
```

- `PageHeader` sets the browser tab title. Keep descriptions to one sentence
  that explains *what this page is for* in plain words.
- Vertical rhythm: `gap-8` between blocks, `gap-3` inside blocks, cards
  `p-4`/`px-4 py-3.5`. Lists inside cards use `divide-y divide-line`.
- Two-pane editors (list + detail) use a fixed list column (~320px) and a
  flexible detail column; stack them when the panel is narrow.
- Page layout breakpoints are **container queries on the main panel**
  (`@3xl/main:` ≈ old `lg:`, `@4xl/main:` ≈ old `xl:`, `@max-3xl/main:`), not
  viewport `lg:`/`xl:` — the AI panel can take 420px from the main area.
- The scroll container is `#scroll-root` (the main panel), not `window`.
- Sticky save: `<SaveBar visible={dirty} onSave onDiscard saving />` plus a
  `useHotkey('mod+s', save)`.

## Components (import from `@/ui/primitives` unless noted)

- `Button` — variants `primary` (ink, the main action), `secondary`
  (default), `ghost`, `subtle`, `accent`, `danger`, `danger-ghost`, `link`;
  sizes `xs|sm|md|lg`; `icon={LucideIcon}`, `loading`, `iconOnly`, `asChild`
  (wrap `<Link>`). One `primary` per view.
- `Input` (`mono`, `leading`, `trailing`, `invalid`, `inputSize`),
  `Textarea`, `SearchInput`, `Field` (render-prop `{(id) => <Input id={id}/>}`
  with `label`, `hint`, `error`, `optional`, `inline` for settings rows),
  `Label`.
- `Select` (enumerations), `Combobox` (searchable single, `allowCustom`),
  `MultiCombobox` (chips), `TagInput` (free text chips + `validate`),
  `SegmentedControl` (2–4 modes, animated pill), `Tabs` (underline, counts),
  `Switch`, `Checkbox`.
- `Dialog` (centred; `footer` for actions), `Sheet` (right panel for
  edit-in-context), `Popover`, `Menu` (`items` with `icon`, `tone: 'danger'`,
  `shortcut`, separators), `Tooltip` (`shortcut` hint).
- `Card`, `CardHeader`, `Badge` (`tone`), `StatusDot` (`pulse`), `Kbd`,
  `Skeleton`, `EmptyState` (icon + title + description + actions),
  `Monogram` (letter avatar from a name), `Numeral` (serif figure), `Code`,
  `Eyebrow`, `Divider`.
- `CopyButton` / `useCopy` / `copyText` — copy with a morphing check.
- `notify.success|info|warn|error(error)` — toasts. `notify.error(err)`
  understands `ApiError` (422 preflight issues get a 详情 dialog).
- `confirmAction({ title, description, confirmText, tone: 'danger' })` →
  `Promise<boolean>` — use before every destructive action.
- Editor: `CodeEditor` from `@/ui/editor/code-editor` (YAML highlighting,
  `readOnly`, `onSave` for ⌘S, `height`).
- Shell: `Page`, `PageHeader`, `Block`, `SaveBar` from `@/ui/shell/page`;
  `useScope()` / `profilePath()` from `@/ui/shell/scope`; `useHotkey` from
  `@/ui/shell/hotkeys`; `openAssistant(draft?)`, `openShare()` from
  `@/ui/shell/state`.
- Transit viz (`@/ui/viz/lines`): `useLineColors().color(policy)`,
  `PolicyChip`, `LineDot`, `GROUP_TYPES` / `groupTypeMeta(type)` (label, icon,
  description for select/url-test/fallback/load-balance), `isBuiltinPolicy`,
  `BUILTIN_LABEL` (DIRECT → 直连 …).
- Nodes (`@/ui/viz/nodes`): `NodeName` (flag + name), `Flag`, `RegionStrip`
  (flag counts), `describeNode`, `countRegions`.
- Source health (`@/ui/viz/health`): `sourceHealth(source)` → `{tone, badge,
  label, detail}`, `HealthPill`, `TrafficMeter`, `trafficOf(health)`.
- Formatting (`@/ui/lib/format`): `formatBytes`, `relativeTime`,
  `formatDate`, `daysUntil`, `formatCount`. Class merging: `cn` from
  `@/ui/lib/cn`.

Icons: `lucide-react`, `size={15|16}` and `strokeWidth={1.75}` by default.

## Data

```ts
import { api, request, errorMessage, ApiError } from '@/ui/data/api';
import { useQuery, invalidate, setQueryData } from '@/ui/data/query';
import { useGroups, refreshProfile, refreshShared, keys } from '@/ui/data/hooks';
```

- `api.get/post/put/patch/del` unwrap `{ data }`. `request()` returns the raw
  body (for `{ data, meta }` pages). Paths are relative to `/api/v1`.
- Read hooks live in `ui/data/hooks.ts` (`useProfiles`, `useSources`,
  `usePools`, `useGroups`, `useRules`, `useRuleSummary`, `usePolicies`,
  `useAnchors`, `useRuleSets`, `useBase`, `usePreview`, `useParsed`,
  `useDevices`, `useDevicePreview`, `useChains`, `useDashboard`, `useMeta`,
  `useHistory`, …). Feature-specific hooks go in the feature folder using
  `useQuery(key, fetcher)` with keys prefixed `p:${profileId}:` for scoped data.
- After a mutation: `refreshProfile(profileId)` for scoped writes,
  `refreshShared()` for sources / pools / rule-sets, `refreshProfiles()` for
  profile CRUD. Optimistic updates via `mutate()` are welcome for toggles.
- Every save is preflighted server-side against the final rendered config; a
  bad change returns 422 with `issues`. Always surface errors with
  `notify.error(error)` — never swallow them.
- Types: `@/ui/data/types` (re-exports schema types; type-only imports — never
  import runtime values from `@/schemas` in client code, it drags zod in).
- Client-safe shared logic you may import: `@/lib/proxies/filterMatch`
  (`matchFilter` for group filter previews), `@/lib/proxies/regions`.
- **Latency is the design constraint** (Vercel functions + KV REST: every
  request costs a few hundred ms). Three mechanisms hide it — keep them working:
  - *Persisted read cache*: keys matching `PERSISTED` in `ui/data/query.ts`
    survive reloads (localStorage, bound to the admin key, cleared on logout)
    and render instantly as stale, then revalidate. Add list/overview keys
    there; never add a document an editor seeds a draft from. Bump
    `pm.query-cache.vN` if a cached shape changes.
  - *Intent prefetch*: `ui/shell/prefetch.ts` maps each route to the
    `queries.*` descriptors its page reads; links get `{...intentProps(href)}`.
    When a page starts reading a new resource, add it to the route's plan.
    New read hooks should be defined via a `queries.*` descriptor.
  - *Static route shells*: dynamic segments under `app/(app)` export an empty
    `generateStaticParams` from a server `layout.tsx`, so navigation never
    waits on a per-click server render. Keep pages client-only.
  - The top activity bar (`ui/shell/activity-bar.tsx`) shows automatically
    for anything going through `request()`.
- React 19 lint (`react-hooks/refs`): never assign `ref.current` during render.
  Keep "latest value" refs in sync with `useIsomorphicLayoutEffect` from
  `@/ui/data/query`.

## Verifying

From the repository root (works inside worktree-isolated sessions too):

```sh
npx --prefix web tsc --noEmit -p web/tsconfig.json --incremental false
npx --prefix web eslint --config web/eslint.config.mjs web/ui web/app
npx --prefix web vitest run --root web tests/ui
```

## Copy & voice

Chinese, short, plain. Explain consequences, not mechanics: "删除后，引用它的
3 条规则会失效" beats "Delete failed: referenced". Use the product's nouns:
配置文件、订阅源、聚合订阅、节点、策略组、规则、规则集、设备、基础配置、最终配置.
Technical tokens (`MATCH`, `DOMAIN-SUFFIX`, YAML keys) stay in `font-mono`.

## States

Every data view handles: loading (Skeletons shaped like the content), empty
(EmptyState with the next action), error (inline message + retry), saving
(button `loading`), dirty (SaveBar). Destructive actions confirm first and
mention what depends on the target when the API tells us.

## Motion

Quiet and purposeful: sections enter with `animate-rise`, popovers `pop`,
lists that reorder use `motion` layout animations, progress bars spring.
Reduced motion is handled case by case in `globals.css` (never a blanket
`animation-duration: 0.01ms`): entrance/exit keyframes are redefined as plain
fades, spinners and skeletons keep running slower, decorative loops are
`motion-safe:` only. `motion/react` follows via `MotionConfig reducedMotion="user"`.
Anything that loops on its own must stop within 5s (WCAG 2.2.2) — finite
iteration counts, not `infinite`, unless it is a loading indicator.

## Inputs

- A custom `Enter` (or comma) keydown that submits/commits must bail out while
  an IME is composing: `if (event.nativeEvent.isComposing || event.keyCode === 229) return;`
  (the 229 check covers Safari). Chinese input depends on it.
- Wrap controls in `<Field>`: the matching `Input`/`Textarea` gets
  `aria-describedby` (hint, or the error while shown) and `aria-invalid`.
- Credentials for *this* app use `autoComplete="current-password"` + `required`;
  third-party keys/tokens (Tailscale, model API keys) use `autoComplete="off"`.
