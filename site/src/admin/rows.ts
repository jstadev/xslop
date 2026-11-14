// Tolerant readers for admin answers: a missing or mistyped field gives a safe default, so one odd row never breaks a view.

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

export const bool = (row: Row, name: string): boolean => row[name] === true;

export const obj = (v: unknown): Row => (isRow(v) ? v : {});

export const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);

/** A string, or null when the field is missing or empty. */
export function strOrNull(row: Row, name: string): string | null {
  const v = row[name];
  return typeof v === 'string' && v !== '' ? v : null;
}
