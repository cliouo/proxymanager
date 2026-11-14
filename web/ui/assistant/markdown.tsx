'use client';

import { isValidElement, memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/ui/primitives';

/**
 * Assistant markdown. Raw HTML in the model's text is shown as text (never
 * rendered), images become plain links (no remote loads), links open in a
 * new tab without referrer.
 */

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HNode[];
  properties?: Record<string, unknown>;
}

const CARET_CLASSES = [
  'ml-0.5',
  'inline-block',
  'h-[1.05em]',
  'w-[2px]',
  'translate-y-[0.18em]',
  'rounded-full',
  'bg-accent',
  'animate-[fade-in_0.7s_ease-in-out_infinite_alternate]',
];

const NO_INLINE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol']);

/** Streaming caret: appended after the last piece of text in the tree. */
function rehypeCaret() {
  return (tree: HNode) => {
    let node = tree;
    for (;;) {
      const kids = node.children ?? [];
      let i = kids.length - 1;
      while (i >= 0 && kids[i].type === 'text' && !kids[i].value?.trim()) i--;
      const last = i >= 0 ? kids[i] : null;
      if (last && last.type === 'element' && last.children?.length) node = last;
      else break;
    }
    // A span is not valid content for table / list containers (e.g. a row whose cell hasn't streamed yet).
    if (node.tagName && NO_INLINE.has(node.tagName)) return;
    node.children = [
      ...(node.children ?? []),
      { type: 'element', tagName: 'span', properties: { className: CARET_CLASSES, ariaHidden: 'true' }, children: [] },
    ];
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? '') : '';
  const lang = /language-([\w+-]+)/.exec(className)?.[1];
  const text = textOf(children).replace(/\n$/, '');
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line bg-sunken first:mt-0 last:mb-0">
      <div className="flex h-7 items-center justify-between border-b border-line pl-3 pr-1">
        <span className="font-mono text-2xs text-ink-3">{lang ?? 'text'}</span>
        <CopyButton text={text} size="sm" label="复制代码" />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink">{children}</pre>
    </div>
  );
}

const components: Components = {
  h1: ({ children }) => <h3 className="mb-2 mt-4 text-md font-semibold tracking-tight text-ink first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mb-1.5 mt-4 text-base font-semibold tracking-tight text-ink first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mb-1 mt-3 text-sm font-semibold text-ink first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mb-1 mt-3 text-sm font-semibold text-ink-2 first:mt-0">{children}</h6>,
  h5: ({ children }) => <h6 className="mb-1 mt-3 text-sm font-semibold text-ink-2 first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mb-1 mt-3 text-sm font-semibold text-ink-2 first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-ink-4 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-ink-3 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 [&>p]:my-1">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-accent underline decoration-accent-line underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
        {alt || '图片链接'}
      </a>
    ) : null,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  del: ({ children }) => <del className="text-ink-3">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-2 first:mt-0 last:mb-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-line" />,
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-[5px] border border-line bg-surface-2 px-1 py-px font-mono text-[11.5px] text-ink">
        {children}
      </code>
    ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-line first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-xs [&_tr:last-child>td]:border-b-0">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-line px-2.5 py-1.5 text-left font-semibold text-ink-2">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line px-2.5 py-1.5 align-top text-ink">{children}</td>,
  input: ({ checked }) => (
    <input type="checkbox" checked={!!checked} readOnly disabled className="mr-1.5 translate-y-px accent-[var(--accent)]" />
  ),
};

const REMARK = [remarkGfm];
const STREAMING = [rehypeCaret];
const STATIC: [] = [];

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="min-w-0 break-words text-sm leading-[1.7] text-ink [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={streaming ? STREAMING : STATIC} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
