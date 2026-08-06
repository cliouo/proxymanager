/**
 * History-page copy + naming rollback guidance (finding 6).
 *
 * Kept OUT of page.tsx: Next.js page modules may not export components beyond
 * the route contract (the generated route types reject extra named exports).
 */

/** The truthful global copy: NOT every write is undoable — naming-class
 * operations roll back in the 智能命名 workspace. */
export function HistoryCrumb(): React.ReactElement {
  return (
    <span className="crumb">写操作留痕；可撤销的显示撤销，命名类操作请在「智能命名」页面回滚</span>
  );
}

/** Specialized naming rollback guidance: naming events are undoable:false
 * (rollback lives in the 智能命名 workspace) — show explicit guidance instead
 * of an unusable undo control. */
export function NamingRollbackHint({
  e,
  undone,
  isUndo,
}: {
  e: { undoable?: boolean; target?: { kind?: string } & Record<string, unknown> };
  undone: boolean;
  isUndo: boolean;
}): React.ReactElement | null {
  if (undone || isUndo || e.undoable !== false || e.target?.kind !== 'naming-source') {
    return null;
  }
  return (
    <span className="pill plain" style={{ height: 18 }}>
      回滚请在「智能命名」页面操作
    </span>
  );
}
