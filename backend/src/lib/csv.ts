import { parse } from "csv-parse/sync";

/** A row keyed by *normalised* header (lowercased, alphanumeric only). */
export type Row = Record<string, string>;

export interface ParsedCsv {
  rows: Row[];
  /** Normalised header keys present in the file. */
  headers: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Parse raw CSV bytes into normalised row objects. Never touches disk. */
export function parseCsv(buf: Buffer): ParsedCsv {
  const text = buf.toString("utf8").replace(/^﻿/, "");
  let records: string[][];
  try {
    records = parse(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }) as string[][];
  } catch {
    return { rows: [], headers: [] };
  }
  if (records.length === 0) return { rows: [], headers: [] };

  const rawHeaders = records[0];
  const headers = rawHeaders.map(norm);
  const rows = records.slice(1).map((rec) => {
    const o: Row = {};
    headers.forEach((h, i) => {
      if (h) o[h] = (rec[i] ?? "").toString().trim();
    });
    return o;
  });
  return { rows, headers };
}

/** First non-empty value among the given header aliases. */
export function pick(row: Row, aliases: string[]): string {
  for (const a of aliases) {
    const key = norm(a);
    const v = row[key];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

/** Does the file contain at least one of these header aliases? */
export function hasColumn(headers: string[], aliases: string[]): boolean {
  const set = new Set(headers);
  return aliases.some((a) => set.has(norm(a)));
}
