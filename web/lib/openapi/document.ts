import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ProxyManager API',
      version: '1.0.0',
      description:
        'Personal proxy configuration manager backend. ' +
        'Subscription delivery + rule-set management + Clash/Mihomo config generation.',
    },
    servers: [{ url: '/', description: 'Current host' }],
    security: [{ bearerAuth: [] }],
  });
}
