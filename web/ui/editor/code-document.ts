import { createChange, definePrimitive, type ChangeDetails } from '@ui-sdk/core';

export type CodeDocumentReason = 'input-change' | 'imperative';

export interface CodeDocumentOptions {
  value?: string;
  readOnly?: boolean;
  onValueChange?: (value: string, details: ChangeDetails<CodeDocumentReason>) => void;
}

export const codeDocument = definePrimitive({
  name: 'code-editor',
  options: {
    value: 'string',
    readOnly: 'boolean',
    onValueChange: 'callback',
  },
  controlled: ['value'],
  state: (options: CodeDocumentOptions) => ({
    value: options.value ?? '',
    readOnly: Boolean(options.readOnly),
  }),
  sync: (options: CodeDocumentOptions) => ({
    value: options.value ?? '',
    readOnly: Boolean(options.readOnly),
  }),
  api: (context) => {
    const change = createChange(context);
    return {
      getValue: () => context.store.get().value,
      setValue(next: string) {
        if (context.store.get().readOnly) return false;
        const text = typeof next === 'string' ? next : String(next ?? '');
        return change('value', text, { reason: 'imperative' });
      },
    };
  },
  slots: (slot) => ({
    root: slot<object, { value: string; readOnly: boolean }>({
      state: (state) => ({ value: state.value, readOnly: state.readOnly }),
      attrs: (state) => ({
        'data-readonly': state.readOnly ? '' : undefined,
      }),
    }),
  }),
  agent: {
    actions: ['setValue'],
  },
});
