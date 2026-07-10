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
      // P3-39: 注册 light + dark 两套主题，codeToHtml 以双主题输出
      // （浅色内联为默认，深色写进 --shiki-dark），由 globals.css 按 data-theme 翻转。
      const [
        { createHighlighterCore },
        { createJavaScriptRegexEngine },
        yaml,
        json,
        bash,
        ts,
        ghDark,
        ghLight,
      ] = await Promise.all([
        import('shiki/core'),
        import('@shikijs/engine-javascript'),
        import('@shikijs/langs/yaml'),
        import('@shikijs/langs/json'),
        import('@shikijs/langs/bash'),
        import('@shikijs/langs/typescript'),
        import('@shikijs/themes/github-dark-default'),
        import('@shikijs/themes/github-light-default'),
      ]);
      return createHighlighterCore({
        themes: [ghLight.default, ghDark.default],
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
  maxHeight?: string;
}

export function ShikiBlock({
  code,
  lang = 'yaml',
  className = '',
  maxHeight,
}: ShikiBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        try {
          // P3-39: 双主题输出，浅色为默认色、深色进 --shiki-dark CSS 变量
          const out = hl.codeToHtml(code, {
            lang,
            themes: { light: 'github-light-default', dark: 'github-dark-default' },
            defaultColor: 'light',
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

  // P3-39: 主题感知底色 —— 深/浅由 --code-bg/--code-fg 翻转，取代写死的暖褐 surface-dark；
  // P3-38: 顺手去掉从未定义的 surface-dark 空类。
  const baseClasses = `bg-[var(--code-bg)] text-[var(--code-fg)] border border-[var(--color-border)] font-mono text-[12px] leading-[1.6] rounded-xl overflow-auto`;
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
