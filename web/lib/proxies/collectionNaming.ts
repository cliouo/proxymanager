import {
  isActiveCurrentRenameTemplateOperator,
  isExecutableOperator,
  type Operator,
  type StoredOperator,
} from '@/schemas/operator';

export const POST_TEMPLATE_RENAME_WARNING = 'post-template name-dependent rows; convert to facts/rules';

export interface MemberNamingWarning {
  code: 'member-post-template-rename';
  memberId: string;
  message: string;
}

function dependsOnName(row: Operator): boolean {
  switch (row.kind) {
    case 'filter-type':
    case 'set-prop':
      return false;
    case 'sort':
      return row.by === 'name' || row.by === 'region';
    case 'dedup':
      return row.by === 'name' || row.action === 'rename';
    default:
      return true;
  }
}

export function hasPostTemplateNameDependentRows(operators: readonly StoredOperator[]): boolean {
  const index = operators.findIndex(isActiveCurrentRenameTemplateOperator);
  return index !== -1 && operators.slice(index + 1).some(
    (row) => isExecutableOperator(row) && !row.disabled &&
      dependsOnName(row),
  );
}

export function collectionMemberNamingWarnings(
  members: readonly { id: string; operators?: StoredOperator[] }[],
  managed: boolean,
): MemberNamingWarning[] {
  if (!managed) return [];
  return members.filter((member) => hasPostTemplateNameDependentRows(member.operators ?? [])).map(
    (member) => ({
      code: 'member-post-template-rename',
      memberId: member.id,
      message: POST_TEMPLATE_RENAME_WARNING,
    }),
  );
}

export function collectionMemberExecution(operators: readonly StoredOperator[]) {
  const managed = operators.find(isActiveCurrentRenameTemplateOperator);
  return {
    managed,
    operators: managed && !hasPostTemplateNameDependentRows(operators)
      ? operators.filter((row) => row !== managed)
      : [...operators],
  };
}
