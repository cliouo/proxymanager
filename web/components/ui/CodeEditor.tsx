'use client';

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { cmV2Highlight, cmV2Theme } from './cm-v2-theme';

/**
 * v2「Signal Console」代码编辑器 —— 行号 gutter + 未保存点 + ⌘S。
 * 对应原型 .editor-shell / .bar，rule-sets / subscriptions 复用。
 *
 * 内部用 CodeMirror 6：只渲染可视行（gutter 天然虚拟化），
 * 万行规则集不再创建几万个 DOM 节点。外层 .editor-shell / .bar 视觉不变。
 *
 * - 受控：value / onChange（外部 value 变化时比对 doc 再 dispatch，避免和输入打架）。
 * - dirty 控制 bar 上的未保存点（.is-dirty 由本组件按需加）。
 * - onSave：⌘S / Ctrl+S 经 CodeMirror keymap（Prec.high + preventDefault）触发。
 */
export function CodeEditor({
  value,
  onChange,
  onSave,
  dirty = false,
  label = 'content · yaml',
  readOnly = false,
  minHeight = 300,
  hint = '⌘S 保存',
}: {
  value: string;
  onChange?: (v: string) => void;
  onSave?: () => void;
  dirty?: boolean;
  label?: string;
  readOnly?: boolean;
  minHeight?: number;
  hint?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        // ⌘S 抢在浏览器「保存网页」与其它绑定之前
        Prec.high(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
        ),
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentUnit.of('  '), // 2 空格
        EditorState.tabSize.of(2),
        yaml(),
        syntaxHighlighting(cmV2Highlight),
        cmV2Theme,
        keymap.of([
          indentWithTab, // Tab 打缩进，不跳焦点
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        readOnlyCompRef.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const next = u.state.doc.toString();
            if (next !== valueRef.current) {
              valueRef.current = next;
              onChangeRef.current?.(next);
            }
          }
        }),
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

  // 外部 value 变化时同步（比对 doc，用户自己的输入不会触发 dispatch）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // readOnly 变化时重配
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return (
    <div className={`editor-shell${dirty ? ' is-dirty' : ''}`}>
      <div className="bar">
        <span>{label}</span>
        <span className="unsaved-dot" />
        <div style={{ flex: 1 }} />
        {!readOnly && <span>{hint}</span>}
        {readOnly && <span>只读</span>}
      </div>
      {/* .editor 仍提供 --code-bg 底色与 minHeight；CodeMirror 绝对定位铺满，
          高度不随文档行数增长，长文档在 .cm-scroller 内部滚动 */}
      <div className="editor" style={{ minHeight, position: 'relative' }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
    </div>
  );
}
