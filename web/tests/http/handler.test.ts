import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigPreflightUnavailableError } from '@/lib/config/errors';
import { parseBaseDocument } from '@/lib/engine/parser';
import { resolveConfig } from '@/lib/engine/resolve';
import { withProblemDetails } from '@/lib/http/handler';

const SECRET = 'FAKE_SECRET_DO_NOT_RETURN';

async function problemFrom(action: () => Promise<unknown> | unknown): Promise<{
  response: Response;
  body: Record<string, unknown>;
}> {
  const route = withProblemDetails(async () => {
    await action();
    return new Response(null, { status: 204 });
  });
  const response = await route();
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('withProblemDetails configuration errors', () => {
  it('returns a structured, credential-free 422 for BaseParseError', async () => {
    const malformed = `proxies:\n  - password: ${SECRET}\n    broken: [ }\n`;
    const { response, body } = await problemFrom(() => parseBaseDocument(malformed));

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(body).toEqual({
      type: 'https://proxymanager.dev/errors/config-validation',
      title: 'Configuration validation failed',
      status: 422,
      detail: 'Invalid base YAML',
      errors: [
        {
          code: 'base_yaml_invalid',
          message: 'Invalid base YAML',
          section: 'base',
          path: '$',
          resource: 'base.yaml',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('points at the safe direct.udp field without reflecting the node', async () => {
    const { response, body } = await problemFrom(() =>
      parseBaseDocument(`proxies:
  - name: ${SECRET}
    type: direct
    udp: true
`),
    );

    expect(response.status).toBe(422);
    expect(body.errors).toEqual([
      {
        code: 'base_proxy_invalid',
        message:
          'Invalid base YAML: Invalid proxy entry at index 0: field "udp" is not supported for type "direct"',
        section: 'proxies',
        path: 'proxies[0].udp',
        resource: 'base.yaml',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('returns a fixed structured 422 without reflecting a bad final rule policy', async () => {
    const unsafePolicy = `https://user:${SECRET}@upstream.invalid/sub`;
    const base = ['rules:', `  - DOMAIN,example.com,${unsafePolicy}`].join('\n');
    const { response, body } = await problemFrom(() =>
      resolveConfig(base, [], [], [], [], { persistSnapshot: false }),
    );

    expect(response.status).toBe(422);
    expect(body.errors).toEqual([
      {
        code: 'final_rule_invalid',
        message: 'Full config render rejected: a final rule policy is missing.',
        section: 'rules',
        path: 'rules',
        resource: 'rendered-config',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain('upstream.invalid');
  });

  it('keeps an unknown infrastructure failure generic in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, body } = await problemFrom(() => {
      throw new Error(`Redis failed at https://user:${SECRET}@redis.invalid`);
    });

    expect(response.status).toBe(500);
    expect(body).toEqual({
      type: 'https://proxymanager.dev/errors/internal',
      title: 'Internal Server Error',
      status: 500,
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain('redis.invalid');
  });

  it('maps preflight availability failures to a fixed safe 503', async () => {
    const { response, body } = await problemFrom(() => {
      throw new ConfigPreflightUnavailableError();
    });

    expect(response.status).toBe(503);
    expect(body).toEqual({
      type: 'https://proxymanager.dev/errors/config-validation-unavailable',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Configuration validation is temporarily unavailable.',
    });
  });
});
