/**
 * GET responses project the managed rename-template row's `sourceAliases`
 * keys to opaque `src-*` handles (dropping orphan keys). A client that edits
 * other pipeline steps echoes that projected row back on PATCH/PUT, and the
 * operator mutation policy — which compares against the stored, unprojected
 * row — would read it as a forbidden naming edit.
 *
 * Before parsing a generic write body, swap every rename-template row that is
 * byte-for-byte the GET projection of the stored row back to the stored row.
 * Anything the client actually changed stays as sent, so the policy still
 * rejects real naming edits through the generic path (fail-closed).
 */
import { deepEqualKeyOrderInsensitive } from '@/lib/repos/rawOperators';
import { projectAliasKeysToHandles } from './sourceAliasResolver';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function projectForResponse(row: Record<string, unknown>, sourceKeys: readonly string[]): Record<string, unknown> {
  const aliases = row.sourceAliases as Record<string, string> | undefined;
  if (aliases === undefined) return row;
  return { ...row, sourceAliases: projectAliasKeysToHandles(aliases, sourceKeys) };
}

export function restoreUnchangedNamingRows(
  body: unknown,
  stored: readonly unknown[],
  sourceKeys: readonly string[],
): unknown {
  if (!isRecord(body) || !Array.isArray(body.operators)) return body;
  const storedById = new Map<string, Record<string, unknown>>();
  for (const row of stored) {
    if (isRecord(row) && row.kind === 'rename-template' && typeof row.id === 'string') {
      storedById.set(row.id, row);
    }
  }
  if (storedById.size === 0) return body;

  let restored = false;
  const operators = body.operators.map((row) => {
    if (!isRecord(row) || row.kind !== 'rename-template' || typeof row.id !== 'string') return row;
    const original = storedById.get(row.id);
    if (!original) return row;
    let projected: unknown;
    try {
      // Same projection as the GET route, then a JSON round trip like the client's echo.
      projected = JSON.parse(JSON.stringify(projectForResponse(original, sourceKeys)));
    } catch {
      return row;
    }
    if (!deepEqualKeyOrderInsensitive(projected, row)) return row;
    restored = true;
    return original;
  });
  return restored ? { ...body, operators } : body;
}
