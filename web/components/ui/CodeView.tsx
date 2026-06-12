'use client';

import { yaml } from '@codemirror/lang-yaml';
import { syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
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
 * 只读大文本查看器 —— CodeMirror 6 虚拟化渲染，只为可视行建 DOM。
 * /config 渲染产物（可能几 MB、几万行 YAML）用，替代裸 <pre> 整体布局。
 * 高度铺满父容器（父容器需有确定高度），滚动发生在 .cm-scroller 内部；
 * 支持选中复制与 ⌘F 搜索。
 */
export function CodeView({ value, className = '' }: { value: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  });

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        yaml(),
        syntaxHighlighting(cmV2Highlight),
        cmV2Theme,
        keymap.of(searchKeymap),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 外部 value 变化时整文替换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={className} style={{ height: '100%' }} />;
}
