'use client';

import { useEffect, useRef } from 'react';
import { createParts } from '@ui-sdk/react/primitive';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { cn } from '@/ui/lib/cn';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { codeDocument } from './code-document';

const { Root: CodeDocumentRoot } = createParts(codeDocument, { root: 'div' });

/** Editor chrome built from the design tokens, so light/dark just work. */
const transitTheme = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '10px 0',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ink) 3.5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-4)',
    border: 'none',
    paddingLeft: '6px',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '30px', paddingRight: '10px', fontSize: '11px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--ink-4)', paddingRight: '4px' },
  '.cm-line': { padding: '0 14px 0 4px' },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)',
    outline: 'none',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--l-9) 22%, transparent)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--l-9) 30%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--l-9) 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--l-4) 40%, transparent)' },
  '.cm-placeholder': { color: 'var(--ink-4)' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--ink)',
    borderColor: 'var(--line)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '12px', padding: '6px 10px' },
  '.cm-search input, .cm-search button': {
    fontFamily: 'inherit',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    color: 'var(--ink)',
  },
  '.cm-search label': { fontSize: '12px', color: 'var(--ink-2)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-lg)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--ink-3)',
    borderRadius: '4px',
    padding: '0 4px',
  },
});

const transitHighlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--ink)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'color-mix(in srgb, var(--l-6) 85%, var(--ink))' },
  { tag: [t.number, t.integer, t.float], color: 'var(--l-4)' },
  { tag: [t.bool, t.null, t.atom, t.keyword], color: 'var(--l-5)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace], color: 'var(--ink-3)' },
  { tag: [t.labelName, t.special(t.variableName)], color: 'var(--l-7)' },
  { tag: [t.typeName, t.tagName, t.meta], color: 'var(--l-8)' },
  { tag: t.content, color: 'var(--ink)' },
  { tag: t.invalid, color: 'var(--bad)' },
]);

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: 'yaml' | 'text';
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  /** Fixed height (CSS); defaults to filling the parent. */
  height?: string;
  minHeight?: string;
  lineNumbers?: boolean;
  wrap?: boolean;
  autoFocus?: boolean;
  /** ⌘S / Ctrl+S inside the editor. */
  onSave?: () => void;
  /** Ref-style hook to get the view (e.g. to reveal a line). */
  onReady?: (view: EditorView) => void;
  label?: string;
  'aria-label'?: string;
}

export function CodeEditor({
  value,
  onChange,
  language = 'yaml',
  readOnly = false,
  placeholder,
  className,
  height,
  minHeight,
  lineNumbers: showLineNumbers = true,
  wrap = false,
  autoFocus,
  onSave,
  onReady,
  label,
  'aria-label': ariaLabel,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useIsomorphicLayoutEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });
  const readOnlyCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      showLineNumbers ? [lineNumbers(), foldGutter({ openText: '▾', closedText: '▸' })] : [],
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(transitHighlight),
      transitTheme,
      EditorState.tabSize.of(2),
      language === 'yaml' ? yaml() : [],
      placeholder ? placeholderExt(placeholder) : [],
      readOnlyCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
      // ⌘S: handled here only when the editor has its own onSave (and then it
      // doesn't bubble to page-level hotkeys); otherwise the page's hotkey runs.
      EditorView.domEventHandlers({
        keydown(event) {
          if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's' && onSaveRef.current) {
            event.preventDefault();
            event.stopPropagation();
            onSaveRef.current();
            return true;
          }
          return false;
        },
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    onReady?.(view);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once per language/line-number mode; value/readOnly sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, showLineNumbers]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  return (
    <CodeDocumentRoot
      aria-label={ariaLabel ?? label ?? '代码编辑器'}
      value={value}
      readOnly={readOnly}
      onValueChange={(next) => onChange?.(next)}
      className={cn('min-h-0 overflow-hidden text-[12.5px]', className)}
      style={{ height: height ?? '100%', minHeight }}
    >
      <div ref={hostRef} className="h-full min-h-0" />
    </CodeDocumentRoot>
  );
}

/** Scroll a line into view and select it. */
export function revealLine(view: EditorView, line: number) {
  const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  });
  view.focus();
}
