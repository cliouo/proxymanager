import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'API Reference — ProxyManager',
};

export default function DocsPage() {
  return (
    <>
      <script id="api-reference" data-url="/api/v1/openapi.json"></script>
      <script async src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    </>
  );
}
