import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '@/lib/openapi/document';

describe('generateOpenApiDocument', () => {
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
});
