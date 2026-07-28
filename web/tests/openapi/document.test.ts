import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '@/lib/openapi/document';
import { registry } from '@/lib/openapi/registry';
import { z } from '@/lib/openapi/zod';

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
    expect(Object.keys(request.properties ?? {})).toEqual([
      'expected_revision',
      'starter_version',
    ]);
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
