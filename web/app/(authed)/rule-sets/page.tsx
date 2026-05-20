'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

type Format = 'yaml' | 'text';
type Behavior = 'classical' | 'domain' | 'ipcidr';

interface RuleSet {
  id: string;
  name: string;
  format: Format;
  behavior?: Behavior;
  content: string;
  note?: string;
  updated_at: number;
}

interface Meta {
  ruleProvidersBase: string;
}

function fmtTime(s: number): string {
  return new Date(s * 1000).toLocaleString();
}

export default function RuleSetsPage() {
  const [sets, setSets] = useState<RuleSet[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, m] = await Promise.all([
        api<{ data: RuleSet[] }>('/api/v1/rule-sets'),
        api<{ data: Meta }>('/api/v1/meta'),
      ]);
      setSets(list.data);
      setMeta(m.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onDelete(id: string) {
    if (!confirm('Delete this rule set?')) return;
    try {
      await api(`/api/v1/rule-sets/${id}`, { method: 'DELETE' });
      setSets((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Rule sets</h1>
        <p className="text-sm text-[var(--color-muted)]">
          User-maintained rule-set files served at{' '}
          <code className="font-mono">/api/rule-providers/&#123;token&#125;/&#123;name&#125;</code>.
        </p>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <AddForm onAdded={reload} />

      <div className="space-y-3">
        {sets.map((set) => {
          const providerUrl = meta ? `${meta.ruleProvidersBase}/${set.name}` : '';
          const isEditing = editingId === set.id;
          return (
            <RuleSetCard
              key={set.id}
              set={set}
              providerUrl={providerUrl}
              editing={isEditing}
              onStartEdit={() => setEditingId(set.id)}
              onCancelEdit={() => setEditingId(null)}
              onSaved={async () => {
                setEditingId(null);
                await reload();
              }}
              onDelete={() => onDelete(set.id)}
              onError={(msg) => setError(msg)}
            />
          );
        })}
        {sets.length === 0 && (
          <Card>
            <CardBody className="text-sm text-[var(--color-muted)] text-center py-8">
              No rule sets yet.
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function RuleSetCard({
  set,
  providerUrl,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onDelete,
  onError,
}: {
  set: RuleSet;
  providerUrl: string;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onDelete: () => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState(set.content);
  const [draftNote, setDraftNote] = useState(set.note ?? '');
  const [draftBehavior, setDraftBehavior] = useState<Behavior | ''>(set.behavior ?? '');
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (editing) {
      setDraft(set.content);
      setDraftNote(set.note ?? '');
      setDraftBehavior(set.behavior ?? '');
    }
  }, [editing, set]);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function onSave() {
    setPending(true);
    try {
      await api(`/api/v1/rule-sets/${set.id}`, {
        method: 'PATCH',
        body: {
          content: draft,
          note: draftNote || undefined,
          behavior: draftBehavior || undefined,
        },
      });
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const lineCount = set.content ? set.content.split('\n').length : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>{set.name}</CardTitle>
          <Badge tone="accent">{set.format}</Badge>
          {set.behavior && <Badge>{set.behavior}</Badge>}
          <span className="text-xs text-[var(--color-muted)]">{lineCount} lines</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="secondary" onClick={() => copy(providerUrl)}>
            {copied ? 'Copied' : 'Copy URL'}
          </Button>
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={onCancelEdit} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" onClick={onSave} disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={onStartEdit}>
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-2">
        <div className="flex gap-2 items-start text-xs">
          <span className="w-24 text-[var(--color-muted)] shrink-0">Provider URL</span>
          <code className="flex-1 break-all font-mono text-[var(--color-accent)]">
            {providerUrl}
          </code>
        </div>
        <div className="flex gap-2 items-start text-xs">
          <span className="w-24 text-[var(--color-muted)] shrink-0">Updated</span>
          <span>{fmtTime(set.updated_at)}</span>
        </div>
        {set.note && !editing && (
          <div className="flex gap-2 items-start text-xs">
            <span className="w-24 text-[var(--color-muted)] shrink-0">Note</span>
            <span>{set.note}</span>
          </div>
        )}

        {editing ? (
          <div className="space-y-2 pt-2">
            <div className="flex gap-2 items-center text-xs">
              <span className="w-24 text-[var(--color-muted)]">Behavior</span>
              <Select
                value={draftBehavior}
                onChange={(e) => setDraftBehavior(e.target.value as Behavior | '')}
                className="max-w-xs"
              >
                <option value="">(none)</option>
                <option value="classical">classical</option>
                <option value="domain">domain</option>
                <option value="ipcidr">ipcidr</option>
              </Select>
            </div>
            <Input
              placeholder="note (optional)"
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
            />
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={20}
              spellCheck={false}
              className="text-xs min-h-[40vh]"
            />
          </div>
        ) : (
          <details className="pt-2">
            <summary className="cursor-pointer text-xs text-[var(--color-muted)] select-none">
              Show content preview
            </summary>
            <pre className="mt-2 rounded-md bg-[var(--color-surface-2)] p-3 text-xs font-mono overflow-x-auto max-h-72 overflow-y-auto">
              {set.content}
            </pre>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<Format>('yaml');
  const [behavior, setBehavior] = useState<Behavior | ''>('classical');
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/api/v1/rule-sets', {
        method: 'POST',
        body: {
          name: name.trim(),
          format,
          behavior: behavior || undefined,
          content,
          note: note.trim() || undefined,
        },
      });
      setName('');
      setContent('');
      setNote('');
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add rule set</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </CardHeader>
      {open && (
        <CardBody>
          <form onSubmit={onSubmit} className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <Input
                placeholder="name (e.g. emby_classic)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-z0-9_-]+"
                required
              />
              <Select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                <option value="yaml">yaml</option>
                <option value="text">text</option>
              </Select>
              <Select
                value={behavior}
                onChange={(e) => setBehavior(e.target.value as Behavior | '')}
              >
                <option value="">(no behavior hint)</option>
                <option value="classical">classical</option>
                <option value="domain">domain</option>
                <option value="ipcidr">ipcidr</option>
              </Select>
              <Input
                placeholder="note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <Textarea
              placeholder={
                'payload:\n  - DOMAIN-SUFFIX,emby.media\n  - DOMAIN-KEYWORD,emby\n'
              }
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              spellCheck={false}
              className="text-xs"
              required
            />
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Adding…' : 'Add'}
              </Button>
              {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
            </div>
          </form>
        </CardBody>
      )}
    </Card>
  );
}
