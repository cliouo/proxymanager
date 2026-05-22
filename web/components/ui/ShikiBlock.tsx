'use client';

import { useEffect, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';

/**
 * 按需加载的 Shiki 单例。**关键**：用 `shiki/core` + 显式 lang/theme imports
 * 而不是 `import('shiki')` —— 后者会让打包器把 ~200 个 grammar 都列为可加载入口，
 * 在 dev 模式下解析全部 AST 时极易爆内存。
 *
 * 启用 JavaScript 正则引擎而非 wasm oniguruma：进一步缩小 bundle、避免 wasm 实例化。
 */
let highlighterPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, yaml, json, bash, ts, ghDark] =
        await Promise.all([
          import('shiki/core'),
          import('@shikijs/engine-javascript'),
          import('@shikijs/langs/yaml'),
          import('@shikijs/langs/json'),
          import('@shikijs/langs/bash'),
          import('@shikijs/langs/typescript'),
          import('@shikijs/themes/github-dark-default'),
        ]);
      return createHighlighterCore({
        themes: [ghDark.default],
        langs: [yaml.default, json.default, bash.default, ts.default],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

interface ShikiBlockProps {
  code: string;
  lang?: 'yaml' | 'json' | 'bash' | 'typescript';
  className?: string;
  inline?: boolean;
  maxHeight?: string;
}

export function ShikiBlock({
  code,
  lang = 'yaml',
  className = '',
  inline = false,
  maxHeight,
}: ShikiBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        try {
          const out = hl.codeToHtml(code, {
            lang,
            theme: 'github-dark-default',
          });
          setHtml(out);
        } catch {
          setHtml(null);
        }
      })
      .catch(() => setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const surface = inline
    ? 'bg-[var(--color-surface-dark-soft)]'
    : 'bg-[var(--color-surface-dark)]';

  const baseClasses = `surface-dark ${surface} text-[var(--color-on-dark)] font-mono text-[12px] leading-[1.6] rounded-xl overflow-auto`;
  const style = maxHeight ? { maxHeight } : undefined;

  if (html) {
    return (
      <div
        className={`${baseClasses} ${className} [&_pre]:!bg-transparent [&_pre]:p-4 [&_pre]:m-0 [&_code]:!bg-transparent`}
        style={style}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre
      className={`${baseClasses} p-4 whitespace-pre ${className}`}
      style={style}
    >
      {code}
    </pre>
  );
}
