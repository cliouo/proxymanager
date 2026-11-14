'use client';

import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorSelection, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { isMarkerLine, type TextEdit } from './yaml-tools';

/**
 * Extensions layered onto the shared CodeEditor through its `onReady` view
 * (StateEffect.appendConfig), so the editor itself stays generic.
 */

/* ─── marker lines: quiet accent rail ────────────────────────────────── */

const markerLine = Decoration.line({ class: 'cm-pm-marker' });

function buildMarkers(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (isMarkerLine(line.text)) builder.add(line.from, line.from, markerLine);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const markerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkers(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildMarkers(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const pmTheme = EditorView.theme({
  '.cm-pm-marker': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)',
    boxShadow: 'inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent)',
  },
  '.cm-pm-marker, .cm-pm-marker span': {
    color: 'color-mix(in srgb, var(--accent) 88%, var(--ink)) !important',
    fontStyle: 'normal !important',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy color-mix(in srgb, var(--bad) 80%, transparent)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy color-mix(in srgb, var(--warn) 80%, transparent)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip-lint': { padding: '4px', fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-diagnostic': { padding: '4px 8px', borderRadius: '6px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--bad)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
});

export interface CursorInfo {
  line: number;
  col: number;
  lines: number;
  /** True once the user has put the caret somewhere (click / keys). */
  placed: boolean;
}

/** Marker rail + diagnostics styling, plus an optional caret listener. */
export function attachExtensions(view: EditorView, onCursor?: (info: CursorInfo) => void) {
  const extensions: Extension[] = [markerPlugin, pmTheme];
  if (onCursor) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged && !update.focusChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const placed = update.view.hasFocus || update.transactions.some((tr) => tr.isUserEvent('select'));
        onCursor({ line: line.number, col: head - line.from + 1, lines: update.state.doc.lines, placed });
      }),
    );
  }
  view.dispatch({ effects: StateEffect.appendConfig.of(extensions) });
}

/* ─── diagnostics & edits ────────────────────────────────────────────── */

export interface LineDiagnostic {
  line: number;
  col?: number;
  message: string;
  severity: 'error' | 'warning';
}

export function showDiagnostics(view: EditorView, items: LineDiagnostic[]) {
  const doc = view.state.doc;
  const diagnostics: Diagnostic[] = items.flatMap((item) => {
    if (item.line < 1 || item.line > doc.lines) return [];
    const line = doc.line(item.line);
    const from = Math.min(line.from + Math.max(0, (item.col ?? 1) - 1), line.to);
    const leading = line.text.length - line.text.trimStart().length;
    const start = from === line.to ? line.from + Math.min(leading, line.length) : from;
    return [{ from: start, to: Math.max(line.to, start), severity: item.severity, message: item.message }];
  });
  view.dispatch(setDiagnostics(view.state, diagnostics));
}

/** Apply a planned insertion as one undoable change and select what was inserted. */
export function applyEdit(view: EditorView, edit: TextEdit) {
  view.dispatch({ changes: { from: edit.from, insert: edit.insert } });
  const doc = view.state.doc;
  const first = doc.line(Math.max(1, Math.min(edit.selectFrom, doc.lines)));
  const last = doc.line(Math.max(1, Math.min(edit.selectTo, doc.lines)));
  view.dispatch({
    selection: EditorSelection.range(first.from, last.to),
    effects: EditorView.scrollIntoView(first.from, { y: 'center' }),
  });
  view.focus();
}
