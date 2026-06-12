import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * v2「Signal Console」CodeMirror 主题。
 * 颜色全部走 CSS 变量（globals.css 的 --code-* / --cm-* / --accent …），
 * 深浅主题经 data-theme 翻转时自动跟随，这里不写死任何色值。
 * 字号 / 行高 / gutter 宽度对齐 v2-components.css 的 .editor / .codebox 约定。
 */
export const cmV2Theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--code-fg)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '14px 0',
  },
  '.cm-line': { padding: '0 16px' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
  // drawSelection 的选区层 + 原生 ::selection 一并染 accent-dim
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    {
      backgroundColor: 'var(--accent-dim) !important',
    },
  '.cm-content ::selection': { backgroundColor: 'var(--accent-dim)' },
  '.cm-gutters': {
    backgroundColor: 'var(--code-bg)',
    color: 'var(--code-gut)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '52px',
    padding: '0 14px 0 8px',
  },
  // 搜索面板（⌘F）走 surface / border token
  '.cm-panels': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--fg)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    fontSize: '12px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--accent-dim)',
    outline: '1px solid var(--accent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-on)',
  },
});

/** 克制的 YAML 高亮 —— 沿用 .codebox 的 --cm-* 配色约定，随主题翻转。 */
export const cmV2Highlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--cm-key)' },
  { tag: t.keyword, color: 'var(--cm-key)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cm-str)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--cm-num)' },
  { tag: t.comment, color: 'var(--cm-com)' },
  { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--cm-punc)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);
