import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '@/lib/openapi/document';
import { registry } from '@/lib/openapi/registry';
import { z } from '@/lib/openapi/zod';
import { SubscriptionAdminViewSchema } from '@/schemas';

describe('generateOpenApiDocument', () => {
  it('registers every component through the shared extended Zod entry', () => {
    const registeredSchemas = registry.definitions.flatMap((definition) =>
      definition.type === 'schema' ? [definition.schema] : [],
    );

    expect(registeredSchemas.length).toBeGreaterThan(0);
    for (const schema of registeredSchemas) {
      expect(schema).toBeInstanceOf(z.ZodType);
      expect(typeof schema.openapi).toBe('function');
    }
  });

  // Guards that refined schemas (RuleCreate/RuleReplace use superRefine) still
  // convert to OpenAPI without throwing, and that the new rule fields surface.
  it('builds a 3.1 document including the rule schemas', () => {
    const doc = generateOpenApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    const schemas = doc.components?.schemas ?? {};
    expect(schemas.Rule).toBeDefined();
    expect(schemas.RuleCreate).toBeDefined();
    expect(schemas.RuleReplace).toBeDefined();
  });

  it('exposes options and enabled on the Rule schema', () => {
    const doc = generateOpenApiDocument();
    const rule = doc.components?.schemas?.Rule as { properties?: Record<string, unknown> };
    expect(rule.properties?.options).toBeDefined();
    expect(rule.properties?.enabled).toBeDefined();
  });

  it('documents distinct base PUT missing, invalid, conflict, and unavailable responses', () => {
    const doc = generateOpenApiDocument();
    const operation = doc.paths?.['/api/v1/base']?.put;
    expect(operation?.responses).toMatchObject({
      404: { description: expect.stringContaining('missing') },
      412: { description: expect.stringContaining('Concurrency conflict') },
      422: { description: expect.stringContaining('invalid') },
      503: { description: expect.stringContaining('unavailable') },
    });
  });

  it('documents the kind-discriminated stored schema and a TRUE remote/local admin-view union', () => {
    const doc = generateOpenApiDocument();
    const schemas = doc.components?.schemas ?? {};
    const stored = schemas.Subscription as { properties?: Record<string, unknown> };
    const storedText = JSON.stringify(stored);
    // v2 I1: the stored schema discriminates kind — the remote branch may
    // carry the optional policy, the local branch omits it (stripped in
    // memory), and legacy rows canonicalize to remote. The union may render
    // as oneOf/anyOf, so the contract is asserted on the component text.
    expect(storedText).toContain('remote');
    expect(storedText).toContain('local');
    expect(storedText).toContain('fetch_failure_policy');

    // v2 F1: the ADMIN VIEW is a true discriminated union — the remote
    // branch carries the required policy + nullable health, the local branch
    // declares neither. A flat always-present `properties` surface would
    // violate local omission, so the union has no top-level policy/health
    // properties; both field names and both branch markers must still appear.
    const view = schemas.SubscriptionResponse as {
      properties?: { data?: { properties?: Record<string, unknown> } };
    };
    // The union has NO flat always-present policy/health properties.
    expect(view.properties?.data?.properties?.fetch_failure_policy).toBeUndefined();
    expect(view.properties?.data?.properties?.fetch_health).toBeUndefined();
    const viewText = JSON.stringify(view);
    expect(viewText).toContain('fetch_failure_policy');
    expect(viewText).toContain('fetch_health');
    expect(viewText).toContain('remote');
    expect(viewText).toContain('local');

    // Direct schema oracle: remote requires policy+health; local omits both.
    const viewBase = {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'air',
      enabled: true,
      ttl_ms: 60_000,
      tags: [],
      operators: [],
    };
    const remote = SubscriptionAdminViewSchema.parse({
      ...viewBase,
      kind: 'remote',
      fetch_failure_policy: 'use-stale-cache',
      fetch_health: null,
    });
    expect(remote.fetch_failure_policy).toBe('use-stale-cache');
    expect('fetch_health' in remote).toBe(true);
    const local = SubscriptionAdminViewSchema.parse({ ...viewBase, kind: 'local' });
    expect('fetch_failure_policy' in local).toBe(false);
    expect('fetch_health' in local).toBe(false);

    const list = schemas.SubscriptionListResponse as {
      properties?: { data?: { items?: { properties?: Record<string, unknown> } } };
    };
    expect(list.properties?.data?.items?.properties?.fetch_health).toBeUndefined();
    expect(JSON.stringify(list)).toContain('fetch_health');
  });

  it('documents refresh 422/503 and the noCache fresh-only contract on public source routes', () => {
    const doc = generateOpenApiDocument();
    const refresh = doc.paths?.['/api/v1/subscriptions/{id}/refresh']?.post;
    expect(refresh?.responses).toMatchObject({
      422: expect.any(Object),
      503: expect.any(Object),
    });

    for (const path of ['/api/sub/{token}/source/{name}', '/api/sub/{token}/collection/{name}']) {
      const operation = doc.paths?.[path]?.get;
      const parameters = (operation?.parameters ?? []) as Array<{
        in?: string;
        name?: string;
      }>;
      expect(parameters.some((p) => p.in === 'query' && p.name === 'noCache')).toBe(true);
      expect(operation?.responses).toMatchObject({
        422: expect.any(Object),
        503: expect.any(Object),
      });
    }
  });

  it('documents setup status and atomic bootstrap contracts', () => {
    const doc = generateOpenApiDocument();
    const statusOperation = doc.paths?.['/api/v1/setup/status']?.get;
    expect(statusOperation?.responses).toHaveProperty('200');
    expect(statusOperation?.responses?.[200]).toMatchObject({
      headers: {
        'Cache-Control': expect.objectContaining({
          description: expect.stringContaining('no-store'),
        }),
      },
    });
    expect(doc.paths?.['/api/v1/setup/bootstrap']?.post?.responses).toMatchObject({
      200: expect.any(Object),
      201: expect.any(Object),
      409: expect.any(Object),
      412: expect.any(Object),
      422: expect.any(Object),
      503: expect.any(Object),
    });
    const status = doc.components?.schemas?.SetupStatus as {
      properties?: Record<string, unknown>;
    };
    expect(status.properties).toMatchObject({
      state: expect.any(Object),
      revision: expect.any(Object),
      starter_version: expect.any(Object),
      inventory: expect.any(Object),
      starter: expect.any(Object),
      provenance: expect.any(Object),
    });
    const request = doc.components?.schemas?.SetupBootstrapRequest as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(request.required).toEqual(['expected_revision', 'starter_version']);
    expect(request.additionalProperties).toBe(false);
    expect(Object.keys(request.properties ?? {})).toEqual(['expected_revision', 'starter_version']);
    const response = doc.components?.schemas?.SetupBootstrapResponse as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(response.required).toContain('provenance');
    expect(response.properties).toMatchObject({
      provenance: expect.any(Object),
      resources: expect.any(Object),
      readiness: expect.any(Object),
    });
    const setupContract = JSON.stringify({ status, request, response });
    expect(setupContract).toContain('listener_ports');
    expect(setupContract).not.toContain('mixed_port');
  });
});
