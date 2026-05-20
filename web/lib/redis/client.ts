import { Redis } from '@upstash/redis';

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env.local for local development, or in Vercel project env vars for production. ` +
        `See .env.local.example for guidance.`,
    );
  }
  return value;
}

let cached: Redis | null = null;

export function getRedis(): Redis {
  if (!cached) {
    cached = new Redis({
      url: readEnv('KV_REST_API_URL'),
      token: readEnv('KV_REST_API_TOKEN'),
    });
  }
  return cached;
}
