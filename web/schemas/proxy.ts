import { z } from 'zod';

export const ProxySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  proxy_yaml: z.string().min(1),
  enabled: z.boolean(),
});

export const ProxyCreateSchema = ProxySchema.omit({ id: true });
export const ProxyUpdateSchema = ProxyCreateSchema.partial();

export type Proxy = z.infer<typeof ProxySchema>;
export type ProxyCreate = z.infer<typeof ProxyCreateSchema>;
export type ProxyUpdate = z.infer<typeof ProxyUpdateSchema>;
