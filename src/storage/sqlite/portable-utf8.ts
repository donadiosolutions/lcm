import type { SQLOutputValue } from "node:sqlite";
import { PortableTransferError } from "../portable-transfer.js";

type Row = Record<string, SQLOutputValue>;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
function typeColumn(name: string): string { return `_portable_utf8_type_${name}`; }

/**
 * Preserve stored TEXT bytes across the driver boundary. Callers must admit an
 * UTF-8 database and bound every projected value in SQL before using this list.
 * Non-TEXT values retain their native storage class rather than being coerced.
 */
export function sqliteUtf8Projection(columns: readonly string[]): string {
  return columns.map(name => {
    const column = quote(name);
    return `CASE WHEN typeof(${column})='text' THEN CAST(${column} AS BLOB) ELSE ${column} END AS ${column}, typeof(${column}) AS ${quote(typeColumn(name))}`;
  }).join(", ");
}

/** Fatal decoding also preserves a real U+FFFD or leading U+FEFF exactly. */
export function decodeSqliteUtf8Row(row: Row, columns: readonly string[]): Row {
  const result = { ...row };
  for (const name of columns) {
    const tag = typeColumn(name);
    if (row[tag] === "text") {
      const raw = row[name];
      if (!(raw instanceof Uint8Array)) throw new PortableTransferError("unsupported-capability");
      let value: string;
      try { value = decoder.decode(raw); }
      catch { throw new PortableTransferError("unsupported-capability"); }
      if (value.includes("\0")) throw new PortableTransferError("unsupported-capability");
      result[name] = value;
    }
    delete result[tag];
  }
  return result;
}
