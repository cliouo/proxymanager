'use client';

import { useEffect, useRef, useState } from 'react';
import { FileUp, Globe, Info } from 'lucide-react';
import { api, request } from '@/ui/data/api';
import { refreshShared } from '@/ui/data/hooks';
import type { SubscriptionLocalFetchSpec } from '@/ui/data/types';
import {
  checkNativeFetchCompatibility,
  decodeUtf8,
  LOCAL_FETCH_ERROR_COPY,
  LocalFetchError,
  nativeFetch,
  type LocalFetchErrorCode,
} from '@/ui/data/local-fetch';
import { formatBytes } from '@/ui/lib/format';
import { Button, Dialog, notify, Textarea } from '@/ui/primitives';
import { sourceTitle, type Source } from './model';

const specPath = (id: string) => `/subscriptions/${id}/local-fetch-spec`;

/**
 * 手动导入: the browser obtains the subscription bytes (paste, UTF-8 file, or a
 * native fetch when it can reproduce the server's request exactly) and uploads
 * them. Importing switches the source to manual mode.
 */
export function ManualImportDialog({
  source,
  open,
  onOpenChange,
}: {
  source: Source;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [content, setContent] = useState('');
  const [blocked, setBlocked] = useState<LocalFetchErrorCode | null | undefined>(undefined);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBlocked(undefined);
    setFetchError(null);
    api
      .get<SubscriptionLocalFetchSpec>(specPath(source.id))
      .then((spec) => {
        if (cancelled) return;
        setBlocked(
          checkNativeFetchCompatibility(spec, {
            pageProtocol: window.location.protocol,
            navigatorUserAgent: navigator.userAgent,
          }),
        );
      })
      .catch(() => !cancelled && setBlocked('network'));
    return () => {
      cancelled = true;
    };
  }, [open, source.id]);

  const fetchInBrowser = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const spec = await api.get<SubscriptionLocalFetchSpec>(specPath(source.id));
      setContent(await nativeFetch(spec));
    } catch (error) {
      setFetchError(error instanceof LocalFetchError ? LOCAL_FETCH_ERROR_COPY[error.code] : String((error as Error)?.message ?? error));
    } finally {
      setFetching(false);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFetchError(null);
    try {
      setContent(decodeUtf8(await file.arrayBuffer()));
    } catch (error) {
      setFetchError(error instanceof LocalFetchError ? LOCAL_FETCH_ERROR_COPY[error.code] : '读取文件失败');
    }
  };

  const upload = async () => {
    if (!content.trim()) return;
    setUploading(true);
    try {
      const spec = await api.get<SubscriptionLocalFetchSpec>(specPath(source.id));
      const res = await request<{ data: { proxyCount: number } }>(`/subscriptions/${source.id}/manual-refresh`, {
        method: 'POST',
        text: true,
        body: content,
        headers: {
          'If-Match': String(source.updated_at ?? 0),
          'X-Fetch-Identity-Revision': String(spec.fetchIdentityRevision),
          'X-Source': 'web',
        },
      });
      notify.success(`已导入 ${res.data.proxyCount} 个节点`, `「${sourceTitle(source)}」现在由手动导入的内容提供节点。`);
      setContent('');
      onOpenChange(false);
    } catch (error) {
      notify.error(error, '导入失败');
    } finally {
      setUploading(false);
      refreshShared();
    }
  };

  const bytes = new TextEncoder().encode(content).length;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`手动导入 · ${sourceTitle(source)}`}
      description="服务器拉不到这个订阅时，可以在你自己的设备上拿到内容，再导入到这里。"
      footer={
        <>
          <span className="mr-auto text-xs text-ink-3">{content ? `${formatBytes(bytes)} · ${content.split('\n').length} 行` : '粘贴或选择内容后导入'}</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={uploading}
            disabled={!content.trim()}
            data-agent-confirm={`导入内容并切换「${sourceTitle(source)}」为手动维护模式`}
            onClick={() => void upload()}
          >
            确认导入
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-2">
          <Info size={14} className="mt-0.5 shrink-0 text-ink-3" />
          导入后，这个订阅源改为「手动维护」：平台不再自动拉取，节点以你导入的内容为准，直到你改回平台自动拉取。
        </div>
        <Textarea
          mono
          aria-label="订阅内容"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="把订阅内容粘贴到这里：Clash YAML、Base64 或每行一个的节点链接都可以"
          className="min-h-[220px]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,.txt,.conf,text/*"
            className="hidden"
            onChange={(e) => {
              void readFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button size="sm" icon={FileUp} onClick={() => fileRef.current?.click()}>
            选择文件
          </Button>
          <Button size="sm" icon={Globe} loading={fetching} disabled={blocked !== null} onClick={() => void fetchInBrowser()}>
            用浏览器直接拉取
          </Button>
        </div>
        {blocked && <p className="text-xs leading-relaxed text-ink-3">浏览器无法直接拉取：{LOCAL_FETCH_ERROR_COPY[blocked]}</p>}
        {fetchError && <p className="text-xs leading-relaxed text-bad">{fetchError}</p>}
      </div>
    </Dialog>
  );
}
