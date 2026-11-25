'use client';

import type { ReactNode } from 'react';
import { createParts } from '@ui-sdk/react/primitive';
import { dataView, type DataViewItem } from './data-view';

const { Root: DataViewRoot } = createParts(dataView, { root: 'div' });

export function DataView({
  label,
  summary,
  items,
  className,
  children,
}: {
  label: string;
  summary?: string;
  items: DataViewItem[];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <DataViewRoot
      aria-label={label}
      summary={summary ?? ''}
      items={items}
      className={className}
    >
      {children}
    </DataViewRoot>
  );
}

export type { DataViewItem };
