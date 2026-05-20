'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

interface BaseData {
  content: string;
  anchors: string[];
  policies: string[];
  etag: string;
  updated_at: number;
}

interface ValidationResult {
  valid: boolean;
  anchors: string[];
  policies: string[];
  orphans: Array<{ rule_id: string; reason: string }>;
}

export default function BasePage() {
  const [data, setData] = useState<BaseData | null>(null);
  const [content, setContent] = useState('');
  const [etag, setEtag] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'info' | 'success' | 'error'; message: string } | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api<{ data: BaseData }>('/api/v1/base');
      setData(res.data);
      setContent(res.data.content);
      setEtag(res.data.etag);
      setValidation(null);
      setStatus(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setData(null);
        setContent('');
        setEtag(null);
        setStatus({ kind: 'info', message: 'No base config yet. Paste one below and save.' });
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = data ? content !== data.content : content.length > 0;

  async function onValidate() {
    setBusy('validate');
    setStatus(null);
    try {
      const res = await api<{ data: ValidationResult }>('/api/v1/base/validate', {
        method: 'POST',
        body: { content },
      });
      setValidation(res.data);
      setStatus(
        res.data.valid
          ? { kind: 'success', message: 'Validation passed.' }
          : { kind: 'error', message: `Validation failed: ${res.data.orphans.length} orphan(s).` },
      );
    } catch (err) {
      const detail = err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setStatus({ kind: 'error', message: detail });
      if (err instanceof ApiError && Array.isArray(err.problem.errors)) {
        setValidation({
          valid: false,
          anchors: [],
          policies: [],
          orphans: err.problem.errors as ValidationResult['orphans'],
        });
      }
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    setBusy('save');
    setStatus(null);
    try {
      const headers: Record<string, string> = {};
      if (etag) headers['If-Match'] = `"${etag}"`;
      await api('/api/v1/base', {
        method: 'PUT',
        body: { content },
        headers,
      });
      setStatus({ kind: 'success', message: 'Saved.' });
      await load();
    } catch (err) {
      const detail = err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setStatus({ kind: 'error', message: detail });
      if (err instanceof ApiError && Array.isArray(err.problem.errors)) {
        setValidation({
          valid: false,
          anchors: [],
          policies: [],
          orphans: err.problem.errors as ValidationResult['orphans'],
        });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Base config</h1>
          <p className="text-sm text-[var(--color-muted)]">Edit the Clash YAML skeleton.</p>
        </div>
        <div className="flex items-center gap-2">
          {etag && <Badge tone="neutral">etag {etag.slice(0, 8)}</Badge>}
          {dirty && <Badge tone="warn">unsaved</Badge>}
          <Button variant="secondary" onClick={onValidate} disabled={busy !== null}>
            {busy === 'validate' ? 'Validating…' : 'Validate'}
          </Button>
          <Button onClick={onSave} disabled={busy !== null || !dirty}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {loadError && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{loadError}</CardBody>
        </Card>
      )}

      {status && (
        <Card
          className={
            status.kind === 'error'
              ? 'border-[var(--color-danger)]/40'
              : status.kind === 'success'
                ? 'border-[var(--color-accent)]/40'
                : ''
          }
        >
          <CardBody
            className={`text-sm ${
              status.kind === 'error'
                ? 'text-[var(--color-danger)]'
                : status.kind === 'success'
                  ? 'text-[var(--color-accent)]'
                  : ''
            }`}
          >
            {status.message}
          </CardBody>
        </Card>
      )}

      {validation && validation.orphans.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Orphan rules ({validation.orphans.length})</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-1 text-xs font-mono">
              {validation.orphans.map((o, i) => (
                <li key={i} className="text-[var(--color-danger)]">
                  {o.rule_id}: {o.reason}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={32}
        spellCheck={false}
        className="min-h-[70vh] text-xs"
        placeholder="paste base.yaml content here…"
      />

      {data && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-[var(--color-muted)]">Anchors:</span>
          {data.anchors.map((a) => (
            <Badge key={a} tone="accent">
              {a}
            </Badge>
          ))}
          <span className="ml-3 text-[var(--color-muted)]">Policies:</span>
          {data.policies.slice(0, 12).map((p) => (
            <Badge key={p}>{p}</Badge>
          ))}
          {data.policies.length > 12 && (
            <Badge>+{data.policies.length - 12} more</Badge>
          )}
        </div>
      )}
    </div>
  );
}
