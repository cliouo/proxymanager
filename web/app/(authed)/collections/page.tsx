'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

interface Collection {
  id: string;
  name: string;
  subscription_ids: string[];
  subscription_tags: string[];
  dedup_by: 'name' | 'server-port' | 'none';
  name_prefix?: string;
  notes?: string;
  updated_at?: number;
}

interface Subscription {
  id: string;
  name: string;
  kind?: 'remote' | 'local';
  enabled: boolean;
  tags?: string[];
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [cs, ss] = await Promise.all([
        api<{ data: Collection[] }>('/api/v1/collections'),
        api<{ data: Subscription[] }>('/api/v1/subscriptions'),
      ]);
      setCollections(cs.data);
      setSubs(ss.data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Collections</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Aggregate multiple subscriptions. Referenced from base.yaml via{' '}
            <code className="font-mono">pm-inline-collections:</code> to inline nodes
            into the rendered config&apos;s <code className="font-mono">proxies:</code>{' '}
            section.
          </p>
        </div>
        <Button onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : 'Add'}</Button>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      {adding && (
        <CollectionForm
          subs={subs}
          onSubmit={async (input) => {
            await api('/api/v1/collections', { method: 'POST', body: input });
            setAdding(false);
            await reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <div className="space-y-3">
        {collections.map((c) => (
          <CollectionRow
            key={c.id}
            collection={c}
            subs={subs}
            onChanged={reload}
            onError={setError}
          />
        ))}
        {collections.length === 0 && !adding && (
          <Card>
            <CardBody className="text-sm text-[var(--color-muted)] text-center py-8">
              No collections yet. Click <strong>Add</strong> to combine subscriptions.
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function CollectionRow({
  collection,
  subs,
  onChanged,
  onError,
}: {
  collection: Collection;
  subs: Subscription[];
  onChanged: () => void;
  onError: (s: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  const subById = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);
  const resolved = useMemo(() => {
    const ids = new Set(collection.subscription_ids);
    if (collection.subscription_tags.length > 0) {
      for (const s of subs) {
        if (s.tags?.some((t) => collection.subscription_tags.includes(t))) {
          ids.add(s.id);
        }
      }
    }
    return [...ids]
      .map((id) => subById.get(id))
      .filter((s): s is Subscription => !!s);
  }, [collection, subs, subById]);

  async function onDelete() {
    if (!confirm(`Delete collection "${collection.name}"?`)) return;
    setPending(true);
    try {
      await api(`/api/v1/collections/${collection.id}`, { method: 'DELETE' });
      onChanged();
      onError(null);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <CollectionForm
        subs={subs}
        initial={collection}
        onSubmit={async (input) => {
          await api(`/api/v1/collections/${collection.id}`, { method: 'PATCH', body: input });
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>{collection.name}</CardTitle>
          <Badge tone="neutral">dedup: {collection.dedup_by}</Badge>
          {collection.name_prefix && (
            <Badge tone="neutral">prefix: {collection.name_prefix}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={pending}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete} disabled={pending}>
            {pending ? '…' : 'Delete'}
          </Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-2 text-xs">
        <div className="flex gap-2 items-start">
          <span className="w-32 text-[var(--color-muted)] shrink-0">Subscriptions</span>
          <div className="flex-1 flex flex-wrap gap-1">
            {resolved.length === 0 ? (
              <span className="text-[var(--color-muted)] italic">none</span>
            ) : (
              resolved.map((s) => (
                <Badge key={s.id} tone={s.enabled ? 'accent' : 'neutral'}>
                  {s.name}
                </Badge>
              ))
            )}
          </div>
        </div>
        {collection.subscription_tags.length > 0 && (
          <div className="flex gap-2 items-start">
            <span className="w-32 text-[var(--color-muted)] shrink-0">Tags auto-include</span>
            <div className="flex-1 flex flex-wrap gap-1">
              {collection.subscription_tags.map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {collection.notes && (
          <div className="flex gap-2 items-start">
            <span className="w-32 text-[var(--color-muted)] shrink-0">Notes</span>
            <span className="flex-1">{collection.notes}</span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function CollectionForm({
  subs,
  initial,
  onSubmit,
  onCancel,
}: {
  subs: Subscription[];
  initial?: Collection;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.subscription_ids ?? []),
  );
  const [tagsInput, setTagsInput] = useState(initial?.subscription_tags?.join(', ') ?? '');
  const [dedupBy, setDedupBy] = useState<'name' | 'server-port' | 'none'>(
    initial?.dedup_by ?? 'name',
  );
  const [namePrefix, setNamePrefix] = useState(initial?.name_prefix ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await onSubmit({
        name: name.trim(),
        subscription_ids: [...selected],
        subscription_tags: tags,
        dedup_by: dedupBy,
        name_prefix: namePrefix.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? `Edit "${initial.name}"` : 'New collection'}</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">Name (slug)</label>
              <Input
                placeholder="e.g. main-pool"
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-z0-9-]+"
                disabled={!!initial}
                required
              />
            </div>
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">Dedup</label>
              <Select
                value={dedupBy}
                onChange={(e) => setDedupBy(e.target.value as 'name' | 'server-port' | 'none')}
              >
                <option value="name">by name</option>
                <option value="server-port">by server:port</option>
                <option value="none">none</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">Name prefix</label>
              <Input
                placeholder="optional, e.g. [main]&nbsp;"
                value={namePrefix}
                onChange={(e) => setNamePrefix(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">
              Subscriptions — explicit pick
            </label>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 max-h-40 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1 text-xs">
              {subs.length === 0 ? (
                <p className="col-span-3 text-[var(--color-muted)]">
                  No subscriptions yet — add one on the Subscriptions page first.
                </p>
              ) : (
                subs.map((s) => {
                  const checked = selected.has(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-center gap-2 rounded px-2 py-1 cursor-pointer ${
                        checked
                          ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                          : 'hover:bg-[var(--color-surface)]'
                      }`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} />
                      <span className="font-mono truncate">{s.name}</span>
                      {!s.enabled && (
                        <span className="text-[10px] text-[var(--color-muted)]">(off)</span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">
              Tags — auto-include any sub matching one of these (comma-separated)
            </label>
            <Input
              placeholder="e.g. premium, asia"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs text-[var(--color-muted)] mb-1 block">Notes</label>
            <Input
              placeholder="optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !name}>
              {pending ? '…' : initial ? 'Save' : 'Create'}
            </Button>
            <Button variant="secondary" type="button" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
