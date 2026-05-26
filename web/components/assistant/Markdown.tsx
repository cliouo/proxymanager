'use client';

/**
 * Minimal, dependency-free Markdown renderer for the assistant's prose.
 *
 * Intentionally renders Markdown → React elements only (no raw HTML, no
 * dangerouslySetInnerHTML), so model output can't inject markup — a trusted
 * component in the refract sense. Covers the constructs LLMs actually emit:
 * fenced code, headings, ordered/unordered lists, hr, paragraphs, and inline
 * bold / italic / code / links.
 */

import { type ReactNode } from 'react';

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(\[[^\]]+?\]\([^)\s]+?\))/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      out.push(
        <code
          key={i}
          className="rounded bg-[var(--color-bg-strong)] px-1 py-0.5 text-[12px] text-[var(--color-fg)]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <strong key={i} className="font-semibold text-[var(--color-fg)]">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (m[3] || m[4]) {
      out.push(<em key={i}>{tok.slice(1, -1)}</em>);
    } else if (m[5]) {
      const lm = /\[([^\]]+?)\]\(([^)\s]+?)\)/.exec(tok);
      if (lm) {
        out.push(
          <a
            key={i}
            href={lm[2]}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-primary)] hover:text-[var(--color-primary-hover)]"
          >
            {lm[1]}
          </a>,
        );
      } else {
        out.push(tok);
      }
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre
      className="my-1.5 overflow-auto rounded-lg bg-[var(--color-surface-dark)] p-3 text-[12px] leading-relaxed text-[var(--color-on-dark)]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <code>{code}</code>
    </pre>
  );
}

/** A GFM table separator row, e.g. `| --- | :--: |`. */
function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')));
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function TableBlock({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="my-1.5 overflow-auto rounded-lg border border-[var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--color-bg-sunk)]">
            {header.map((h, i) => (
              <th
                key={i}
                className="border-b border-[var(--color-border)] px-2.5 py-1.5 text-left font-semibold text-[var(--color-fg)]"
              >
                {renderInline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td
                  key={ci}
                  className="border-b border-[var(--color-border)] px-2.5 py-1.5 align-top text-[var(--color-fg-soft)]"
                >
                  {renderInline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADING_SIZES: Record<number, string> = {
  1: 'text-[16px]',
  2: 'text-[15px]',
  3: 'text-[14px]',
  4: 'text-[14px]',
  5: 'text-[14px]',
  6: 'text-[14px]',
};

export function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} />);
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div
          key={key++}
          className={`mt-2 mb-1 font-semibold text-[var(--color-fg)] ${HEADING_SIZES[level]}`}
        >
          {renderInline(h[2])}
        </div>,
      );
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key++} className="my-2 border-[var(--color-border)]" />);
      i++;
      continue;
    }

    // GFM table: a `|` row immediately followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(<TableBlock key={key++} header={header} rows={rows} />);
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const inner = items.map((it, j) => <li key={j}>{renderInline(it)}</li>);
      blocks.push(
        ordered ? (
          <ol key={key++} className="my-1 list-decimal pl-5 text-[14px] leading-relaxed">
            {inner}
          </ol>
        ) : (
          <ul key={key++} className="my-1 list-disc pl-5 text-[14px] leading-relaxed">
            {inner}
          </ul>
        ),
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-[14px] leading-relaxed text-[var(--color-fg-soft)]">
        {renderInline(para.join('\n'))}
      </p>,
    );
  }

  return <div className="flex flex-col gap-1">{blocks}</div>;
}
