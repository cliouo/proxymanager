# ProxyManager interface direction

## 1. Visual theme and atmosphere

ProxyManager is an approachable infrastructure workspace: precise enough for experienced operators, calm enough for a teammate opening Mihomo configuration for the first time. The interface uses quiet blue-green neutrals, clear Chinese labels, and restrained technical detail instead of a terminal-themed control panel.

The default experience is light and legible. Dark mode remains available for long operational sessions, but both themes use the same hierarchy and interaction model.

## 2. Color palette and roles

| Token          | Light value              | Role                               |
| -------------- | ------------------------ | ---------------------------------- |
| Canvas         | `oklch(95.5% 0.011 206)` | Page background and separation     |
| Surface        | `oklch(99% 0.004 206)`   | Primary working surfaces           |
| Surface raised | `oklch(97% 0.007 206)`   | Sidebar and secondary controls     |
| Ink            | `oklch(22% 0.025 223)`   | Primary text                       |
| Muted ink      | `oklch(50% 0.020 220)`   | Explanations and metadata          |
| Border         | `oklch(88% 0.015 210)`   | Structural dividers                |
| Accent         | `oklch(52% 0.105 184)`   | Current scope and primary action   |
| Success        | `oklch(55% 0.140 151)`   | Valid, ready, and connected states |
| Warning        | `oklch(58% 0.120 76)`    | Attention without failure          |
| Danger         | `oklch(57% 0.180 29)`    | Destructive and failed states      |

## 3. Typography rules

- Product UI: Noto Sans SC, with system fallbacks.
- Configuration, addresses, IDs, and counts: JetBrains Mono.
- Body: 14.5px, line height 1.6.
- Navigation label: 14px, weight 600.
- Navigation explanation: 11.5px, weight 400.
- Page title: 16px, weight 650.
- Section title: 14px to 15px, weight 600.
- Monospace is never used as a decorative voice.

## 4. Component styling

- Buttons use a 10px radius and a 38px desktop height. At 600px and below,
  buttons and tabs use a minimum 40px touch target. Primary buttons use the
  blue-green accent; secondary buttons use a raised neutral surface.
- Navigation items have a fixed icon container, a plain-language label, and an optional one-line explanation. The active item uses a filled surface and a quiet accent icon.
- Infrequent profile-level capabilities sit in a quiet Advanced Configuration group. Do not add a disclosure layer while the group has only one item.
- Device-only capabilities such as Tailscale appear on the device card and device detail page, not as a competing global navigation destination.
- Pills are reserved for scope and state. They do not carry primary actions.
- Panels are used for independent tasks, not as a default wrapper around every section.
- Inputs and code surfaces retain visible focus and use the same semantic color system.

## 5. Layout principles

- Desktop sidebar: 264px.
- Main top bar: 64px.
- Spacing scale: 4, 8, 12, 16, 24, 32px.
- Radius scale: 6, 10, 14px, pill.
- Utility pages orient the user first, show current state second, and expose the main action third.
- Advanced diagnostics sit beside or below the main task, never before it.
- The device workspace begins with one shared-config baseline, then a responsive device grid. Device cards expose only inherited differences, device-scoped features, and the subscription action.
- Device details use stable task tabs for differences, Tailscale, and rendered preview. Destructive actions stay below the task surface.

## 6. Depth and elevation

Depth comes from background lightness steps and soft shadows, not decorative glass. The sidebar, page canvas, working surface, popover, and drawer each have a distinct level. Borders remain one-pixel structural dividers.

## 7. Do and do not

- Do use ordinary task language before Mihomo vocabulary.
- Do keep the active configuration visible throughout the workspace.
- Do mask subscription credentials by default.
- Do provide a clear next action in empty and error states.
- Do keep expert YAML available without making it the first explanation.
- Do not use punctuation glyphs as unexplained navigation icons.
- Do not rely on hover to reveal essential navigation.
- Do not flatten advanced capabilities into the same level as routine configuration tasks.
- Do not add decorative gradients or ornamental motion.
- Do not mix page-scoped Tailwind utilities with CSS Modules on one element.

## 8. Responsive behavior

- At 1100px and below, the sidebar becomes a modal drawer with a scrim.
- At 600px and below, top-bar metadata collapses before actions.
- Interactive targets remain at least 40px high on touch layouts.
- The configuration inspector becomes a right drawer with an explicit close action and scrim.
- All layouts must be checked at 1440px desktop and 375px mobile widths.

## 9. Agent prompt guide

- Shell: “Use `--bg` for the canvas, `--surface` for the workspace, `--surface-2` for navigation, `--accent` only for current scope and the primary action. Sidebar width 264px, top bar 64px, radii 6/10/14px.”
- Navigation: “Create a 48px navigation row with an 18px stroke icon, 14px weight-600 label, 11.5px muted explanation, 10px radius, and active state on a raised surface.”
- Page header: “Create a 64px utility header with a 16px weight-650 title, one compact scope pill, flexible whitespace, then secondary and primary actions at 38px height.”
- Status: “Show one sentence that answers whether the result is usable, then place build ID, counts, and diagnostics in lower-contrast metadata.”
- Motion: “Use 140ms or 220ms cubic-bezier(0.2,0,0,1), animate only transform and opacity, and disable non-essential motion with prefers-reduced-motion.”
