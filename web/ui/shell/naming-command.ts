export function namingCommand(name: string, keywords: string[]) {
  const label = `智能命名 · ${name}`;
  return { label, value: [label, ...keywords].join(' ') };
}
