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

| Name                | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `KV_REST_API_URL`   | Upstash Redis REST URL (auto-injected by Vercel Marketplace) |
| `KV_REST_API_TOKEN` | Upstash Redis REST token                                     |
| `ADMIN_KEY`         | Bearer token for management API                              |
| `SUB_TOKEN`         | URL path token for subscription endpoint                     |

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

Then add the two app secrets — either via dashboard (Settings → Environment Variables) or CLI:

```bash
npx vercel env add ADMIN_KEY   # paste the value when prompted, select all environments
npx vercel env add SUB_TOKEN
```

Finally pull everything into `.env.local`:

```bash
npm run vercel:env:pull
```

After that, `npm run dev` (or `npm run vercel:dev`) talks to the real Upstash instance, and `npm run vercel:deploy:prod` ships it.
