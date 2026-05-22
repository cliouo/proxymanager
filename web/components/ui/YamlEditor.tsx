'use client';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useImperativeHandle, useRef } from 'react';

/**
 * Heritage Atelier 主题：
 * - 编辑器背景同纸张暖米白（与页面融为一体）
 * - 行号区下沉 bg-sunk，行号字色 muted
 * - 当前行用 primary-tint（极淡陶土）高亮
 * - 光标陶土红，选区陶土-soft
 * - YAML key 用 ink 浓墨，string 用 fg-soft，number/boolean 用 primary 陶土
 */
const heritageTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--color-surface)',
      color: 'var(--color-fg)',
      height: '100%',
      fontSize: '13px',
      fontFamily:
        'var(--font-jetbrains), "SF Mono", ui-monospace, Menlo, Consolas, monospace',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      caretColor: 'var(--color-primary)',
      padding: '12px 0',
      lineHeight: '1.6',
    },
    '.cm-line': { padding: '0 16px' },
    '.cm-cursor, .cm-dropCursor': {
      borderLeft: '2px solid var(--color-primary)',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection':
      {
        backgroundColor: 'var(--color-primary-soft) !important',
      },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg-sunk)',
      color: 'var(--color-muted)',
      border: 'none',
      borderRight: '1px solid var(--color-border)',
      paddingRight: '4px',
      fontSize: '11px',
      fontVariantNumeric: 'tabular-nums',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--color-primary-tint)',
      color: 'var(--color-primary-hover)',
      fontWeight: '600',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--color-primary-tint)',
    },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--color-muted)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-bg-strong)',
      border: 'none',
      color: 'var(--color-fg-soft)',
      padding: '0 6px',
      borderRadius: '4px',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-surface-dark)',
      color: 'var(--color-on-dark)',
      border: 'none',
      borderRadius: '8px',
      fontSize: '12px',
    },
    '.cm-searchMatch': {
      backgroundColor: 'var(--color-primary-soft)',
      outline: '1px solid var(--color-primary)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'var(--color-primary)',
      color: 'var(--color-on-primary)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--color-bg-sunk)',
      color: 'var(--color-fg)',
      borderTop: '1px solid var(--color-border)',
    },
    '.cm-panels-bottom input, .cm-panels-bottom button': {
      backgroundColor: 'var(--color-surface)',
      color: 'var(--color-fg)',
      border: '1px solid var(--color-border)',
      borderRadius: '6px',
      padding: '2px 8px',
      fontSize: '12px',
    },
  },
  { dark: false },
);

const heritageHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--color-ink)', fontWeight: '600' }, // YAML key
  { tag: t.keyword, color: 'var(--color-primary)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--color-fg-soft)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--color-primary)' },
  { tag: t.comment, color: 'var(--color-muted-strong)', fontStyle: 'italic' },
  { tag: t.atom, color: 'var(--color-plum)' },
  { tag: t.punctuation, color: 'var(--color-muted)' },
  { tag: t.invalid, color: 'var(--color-danger)' },
]);

export interface YamlEditorHandle {
  focus: () => void;
  getValue: () => string;
}

interface YamlEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  className?: string;
  ref?: React.Ref<YamlEditorHandle>;
}

export function YamlEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  className = '',
  ref,
}: YamlEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompRef = useRef(new Compartment());
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
    }),
    [],
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter({
          markerDOM: (open) => {
            const el = document.createElement('span');
            el.textContent = open ? '▾' : '▸';
            el.style.color = 'var(--color-muted)';
            el.style.fontSize = '10px';
            el.style.cursor = 'pointer';
            return el;
          },
        }),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        indentUnit.of('  '), // 2 空格
        EditorState.tabSize.of(2),
        yaml(),
        syntaxHighlighting(heritageHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        heritageTheme,
        keymap.of([
          indentWithTab, // Tab 打缩进，不跳焦点
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
        ]),
        readOnlyCompRef.current.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const next = u.state.doc.toString();
            if (next !== valueRef.current) onChangeRef.current(next);
          }
        }),
        EditorView.lineWrapping,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化时同步
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  // readOnly 变化时重配
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div ref={hostRef} className={`h-full overflow-hidden ${className}`} />;
}
