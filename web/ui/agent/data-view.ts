import { definePrimitive } from '@ui-sdk/core';

export interface DataViewItem {
  value: string;
  label: string;
}

export interface DataViewOptions {
  summary?: string;
  items?: DataViewItem[];
}

export const dataView = definePrimitive({
  name: 'data-view',
  options: {
    summary: 'string',
    items: 'value',
  },
  controlled: ['summary'],
  state: (options: DataViewOptions) => ({
    summary: options.summary ?? '',
    items: options.items ?? [],
  }),
  sync: (options: DataViewOptions) => ({
    summary: options.summary ?? '',
    items: options.items ?? [],
  }),
  api: (context) => ({
    getItems: () => context.store.get().items,
  }),
  slots: (slot) => ({
    root: slot<object, { summary: string; count: number }>({
      state: (state) => ({ summary: state.summary, count: state.items.length }),
      attrs: (state) => ({
        'data-count': String(state.items.length),
      }),
    }),
  }),
  agent: {
    actions: [],
    items: (api) => api.getItems(),
  },
});
