import {
  isActiveCurrentRenameTemplateOperator,
  isExecutableOperator,
  type StoredOperator,
} from '@/schemas/operator';

export const POST_TEMPLATE_RENAME_WARNING = 'post-template rename rows; convert to facts/rules';

export interface MemberNamingWarning {
  code: 'member-post-template-rename';
  memberId: string;
  message: string;
}

export function hasPostTemplateRenameRows(operators: readonly StoredOperator[]): boolean {
  const index = operators.findIndex(isActiveCurrentRenameTemplateOperator);
  return index !== -1 && operators.slice(index + 1).some(
    (row) => isExecutableOperator(row) && !row.disabled &&
      (row.kind === 'rename-regex' || row.kind === 'flag-emoji'),
  );
}

export function collectionMemberNamingWarnings(
  members: readonly { id: string; operators?: StoredOperator[] }[],
  managed: boolean,
): MemberNamingWarning[] {
  if (!managed) return [];
  return members.filter((member) => hasPostTemplateRenameRows(member.operators ?? [])).map(
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
    operators: managed && !hasPostTemplateRenameRows(operators)
      ? operators.filter((row) => row !== managed)
      : [...operators],
  };
}
