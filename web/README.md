# ProxyManager Web

Vercel-hosted Sub-Store replacement. Full-stack Next.js app: subscription aggregation, rule-set management, Clash/Mihomo config generation, and a management UI. The browser extension (separate `extension/` module, future) consults this service.

Design doc: [`../REQUIREMENTS.md`](../REQUIREMENTS.md)

## Stack

- Next.js 16 (App Router, Route Handlers)
- TypeScript (strict)
- Upstash Redis (via Vercel Marketplace)
- Zod schemas + auto-generated OpenAPI 3.1
- ESLint + Prettier

## Layout

```
app/
  api/
    v1/             Management API (/api/v1/*, Bearer auth)
    sub/            Subscription delivery (/api/sub/{token}/{profile})
  docs/             Scalar API reference UI
lib/
  redis/            Upstash Redis client + helpers
  repos/            Data access layer (rules, base, subscriptions, proxies)
  engine/           base.yaml parser, renderer, validator
schemas/            Zod schemas (single source of truth for types + OpenAPI)
scripts/            Migration & maintenance scripts
```

## Commands

```
npm run dev              # Next.js dev server (uses .env.local)
npm run build            # Production build
npm run start            # Serve production build
npm run lint             # ESLint
npm run format           # Prettier write
npm run format:check
npm run typecheck        # tsc --noEmit

npm run vercel:link      # Link this directory to a Vercel project (interactive)
npm run vercel:dev       # Run via Vercel's dev runtime (closer to prod)
npm run vercel:env:pull  # Pull project env vars from Vercel into .env.local
npm run vercel:deploy    # Deploy preview build
npm run vercel:deploy:prod  # Deploy to production
```

## Environment variables

| Name                 | Purpose                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `KV_REST_API_URL`    | Upstash Redis REST URL (auto-injected by Vercel Marketplace)                                                                    |
| `KV_REST_API_TOKEN`  | Upstash Redis REST token                                                                                                        |
| `ADMIN_KEY`          | Bearer token for management API                                                                                                 |
| `SUB_TOKEN`          | URL path token for subscription endpoint                                                                                        |
| `DEEPSEEK_API_KEY`   | DeepSeek key for the in-app AI config assistant (optional)                                                                      |
| `NODE_HANDLE_SECRET` | REQUIRED — HMAC key for opaque model-facing node/source handles in the 智能命名 assistant (≥ 32 bytes, stable across instances) |

## Vercel setup

One-time, interactive (browser-based OAuth):

```bash
cd web
npx vercel login            # opens browser, sign in with GitHub/email
npx vercel link             # picks scope, links to existing or creates project
```

> If you previously ran `vercel link` from the project root, also go to Vercel
> dashboard → project → Settings → General → **Root Directory** and set it to `web`.

Then add Upstash Redis via the Vercel dashboard:

1. Open the project in https://vercel.com/dashboard
2. **Storage** tab → **Create Database** → **Upstash Redis** (free plan)
3. Choose a region close to where Clash clients pull from
4. Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` into the project envs

Then add the three app secrets — either via dashboard (Settings → Environment Variables) or CLI:

```bash
npx vercel env add ADMIN_KEY            # paste the value when prompted, select all environments
npx vercel env add SUB_TOKEN
npx vercel env add NODE_HANDLE_SECRET   # 智能命名 opaque-handle HMAC key — generate with: openssl rand -hex 32
```

> **`NODE_HANDLE_SECRET` stability/rotation**: it keys the opaque MAC handles the
> naming assistant emits (target refs, node/source/value tokens). The value must
> be STRONG (≥ 32 bytes, `openssl rand -hex 32`) and STABLE across redeploys and
> across all instances — changing it invalidates every previously emitted
> ephemeral handle/ref, so old tool calls in an in-flight assistant conversation
> fail closed with the bounded "目标引用不存在或已失效" error and the model must
> re-run `list_naming_targets`. The 智能命名 workspace GET and the one-shot
> analysis route derive handles too and fail closed with a GENERIC bounded
> error (never the env name, stack or key material) when the variable is missing
> or weaker than 32 bytes.
>
> **Upgrade order for EXISTING deployments**: set `NODE_HANDLE_SECRET` in Vercel
> (and `.env.local`) BEFORE deploying the upgraded code — otherwise the naming
> workspace/analysis entrypoints fail closed until the variable is added.
> Generate once (`openssl rand -hex 32`), store in Vercel + `.env.local` (via
> `npm run vercel:env:pull`), and rotate only during a maintenance window.
> Local development without Vercel: add the same value to `web/.env.local`.

Finally pull everything into `.env.local`:

```bash
npm run vercel:env:pull
```

After that, `npm run dev` (or `npm run vercel:dev`) talks to the real Upstash instance, and `npm run vercel:deploy:prod` ships it.
