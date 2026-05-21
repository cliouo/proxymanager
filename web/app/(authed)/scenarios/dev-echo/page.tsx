'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

export default function EchoScenarioPage() {
  const [payload, setPayload] = useState('{\n  "hello": "world"\n}');
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState<string>('');

  async function call(op: 'ping' | 'mark') {
    setPending(true);
    setOutput('');
    try {
      const parsed = payload.trim() ? JSON.parse(payload) : null;
      const res = await api<{ data: unknown; events?: unknown[] }>('/api/v1/ops', {
        method: 'POST',
        body: { scenario: 'dev-echo', op, payload: parsed },
      });
      setOutput(JSON.stringify(res, null, 2));
    } catch (err) {
      setOutput(
        '// ERROR\n' +
          (err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : err instanceof SyntaxError
              ? `Invalid JSON: ${err.message}`
              : String(err)),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Echo (dev)</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Verifies the scenario dispatcher pipeline end-to-end without
          touching real config. <code className="font-mono">ping</code>{' '}
          returns your payload; <code className="font-mono">mark</code>{' '}
          additionally emits one audit event so you can confirm it lands in
          /history.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payload (JSON)</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          <Textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={6}
            className="font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button onClick={() => call('ping')} disabled={pending}>
              {pending ? '…' : 'POST ops { op: ping }'}
            </Button>
            <Button variant="secondary" onClick={() => call('mark')} disabled={pending}>
              {pending ? '…' : 'POST ops { op: mark }'}
            </Button>
          </div>
        </CardBody>
      </Card>

      {output && (
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
          </CardHeader>
          <CardBody>
            <pre className="font-mono text-xs whitespace-pre-wrap text-[var(--color-fg)]">
              {output}
            </pre>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
