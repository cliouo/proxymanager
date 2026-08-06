/**
 * History page render evidence (finding 6): the global copy is truthful
 * (not every write is undoable) and naming events (undoable:false) render
 * the specialized rollback guidance instead of an unusable undo control.
 * Static markup via react-dom/server — the same markup a screen reader gets.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { HistoryCrumb, NamingRollbackHint } from '@/app/(authed)/history/namingHints';

/** The exact copy the page renders (HistoryCrumb). */
const TRUTHFUL_COPY = '写操作留痕；可撤销的显示撤销，命名类操作请在「智能命名」页面回滚';

describe('history page copy + naming rollback guidance (finding 6)', () => {
  it('the GLOBAL copy no longer claims every write is undoable', () => {
    const html = renderToStaticMarkup(createElement(HistoryCrumb));
    expect(html).toContain(TRUTHFUL_COPY);
    // the old false claim is gone from the rendered copy
    expect(html).not.toContain('每次写操作都有快照 · 可撤销');
  });

  it('naming events (undoable:false) render explicit specialized rollback guidance', () => {
    const html = renderToStaticMarkup(
      createElement(NamingRollbackHint, {
        e: {
          undoable: false,
          target: { kind: 'naming-source', type: 'subscription', id: 'sub-1', name: '机场A' },
        },
        undone: false,
        isUndo: false,
      }),
    );
    expect(html).toContain('回滚请在「智能命名」页面操作');
  });

  it('other events (undoable:true / non-naming) render NO naming guidance', () => {
    const undoable = renderToStaticMarkup(
      createElement(NamingRollbackHint, {
        e: { undoable: true, target: { kind: 'rule', id: 'r-1' } },
        undone: false,
        isUndo: false,
      }),
    );
    expect(undoable).toBe('');
    const undone = renderToStaticMarkup(
      createElement(NamingRollbackHint, {
        e: {
          undoable: false,
          target: { kind: 'naming-source', type: 'subscription', id: 's', name: 'x' },
        },
        undone: true,
        isUndo: false,
      }),
    );
    expect(undone).toBe('');
  });
});
