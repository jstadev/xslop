// Tolerant readers for admin list rows. SPEC 5.6 names the routes but not every field,
// so the console accepts a bare array or {items|<name>: [...]}, and camelCase or snake_case keys.

export type Row = Record<string, unknown>;

export const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

export function listFrom(body: unknown, name: string): Row[] {
  const list = Array.isArray(body) ? body : isRow(body) ? (body[name] ?? body.items ?? body.rows) : null;
  return Array.isArray(list) ? list.filter(isRow) : [];
}

export function field(row: Row, ...names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined) return row[name];
  return undefined;
}

export function str(row: Row, ...names: string[]): string {
  const v = field(row, ...names);
  return typeof v === 'string' ? v : '';
}

export function num(row: Row, ...names: string[]): number | null {
  const v = field(row, ...names);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
