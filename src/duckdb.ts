import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbEhWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type {
  ColumnType,
  NormalizedComparison,
  NormalizedModel,
  PairValues,
} from "./types";

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbMvpWasm, mainWorker: duckdbMvpWorker },
  eh: { mainModule: duckdbEhWasm, mainWorker: duckdbEhWorker },
};

const SAFE_CUSTOM_TYPE = new RegExp("^[\\w\\s(),\\[\\]]+$");

let databasePromise: Promise<duckdb.AsyncDuckDB> | undefined;

export function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  databasePromise ??= (async () => {
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    if (!bundle.mainWorker) throw new Error("DuckDB could not select a browser worker.");
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const database = new duckdb.AsyncDuckDB(logger, worker);
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return database;
  })();
  return databasePromise;
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function comparisonCase(comparison: NormalizedComparison, alias: string): string {
  const clauses = comparison.comparison_levels.map((level) => {
    if (/^\s*else\s*$/i.test(level.sql_condition)) {
      return `ELSE ${level.comparison_vector_value}`;
    }
    return `WHEN ${level.sql_condition} THEN ${level.comparison_vector_value}`;
  });
  return `CASE ${clauses.join(" ")} END AS ${quoteIdentifier(alias)}`;
}

function collectColumnReferences(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectColumnReferences(item, output));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.class === "COLUMN_REF" && Array.isArray(record.column_names)) {
    const names = record.column_names.filter((name): name is string => typeof name === "string");
    if (names.length > 0) output.add(names.join("."));
  }
  Object.values(record).forEach((item) => collectColumnReferences(item, output));
}

function basePairColumn(reference: string): string | null {
  const tableMatch = reference.match(/^(?:l|r)\.(.+)$/i);
  if (tableMatch) return tableMatch[1];
  const suffixMatch = reference.match(/^(.+)_(?:l|r)$/i);
  return suffixMatch?.[1] ?? null;
}

export async function discoverColumns(model: NormalizedModel): Promise<string[]> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const parsedSql = `SELECT ${model.comparisons
      .map((comparison, index) => comparisonCase(comparison, `gamma_${index}`))
      .join(", ")}`;
    const result = await connection.query(
      `SELECT json_serialize_sql(${quoteString(parsedSql)}, skip_null := true) AS ast`,
    );
    const astValue = result.toArray()[0]?.ast;
    if (typeof astValue !== "string") throw new Error("DuckDB returned no parsed SQL tree.");
    const references = new Set<string>();
    collectColumnReferences(JSON.parse(astValue), references);
    const columns = [...references]
      .map(basePairColumn)
      .filter((column): column is string => column !== null);
    model.comparisons.forEach((comparison) => {
      comparison.comparison_levels.forEach((level) => {
        if (level.tf_adjustment_column) columns.push(level.tf_adjustment_column);
      });
    });
    return [...new Set(columns)].sort((left, right) => left.localeCompare(right));
  } finally {
    await connection.close();
  }
}

function sqlType(type: ColumnType): string {
  if (type.kind !== "CUSTOM") return type.kind;
  const custom = type.customType?.trim();
  if (!custom || !SAFE_CUSTOM_TYPE.test(custom)) {
    throw new Error("Custom DuckDB types may contain names, spaces, parentheses, commas, and brackets.");
  }
  return custom;
}

function typedLiteral(raw: string | null, type: ColumnType): string {
  const targetType = sqlType(type);
  if (raw === null) return `CAST(NULL AS ${targetType})`;
  if (type.kind !== "VARCHAR" && raw.trim() === "") return `CAST(NULL AS ${targetType})`;
  if (type.kind === "DOUBLE") {
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`'${raw}' is not a valid number.`);
    return `CAST(${number} AS DOUBLE)`;
  }
  if (type.kind === "BOOLEAN") {
    if (!/^(true|false)$/i.test(raw)) throw new Error(`'${raw}' is not a valid boolean.`);
    return `CAST(${raw.toLowerCase()} AS BOOLEAN)`;
  }
  if (type.kind === "VARCHAR") return `CAST(${quoteString(raw)} AS VARCHAR)`;
  if (type.kind === "DATE" || type.kind === "TIMESTAMP") {
    return `CAST(${quoteString(raw)} AS ${targetType})`;
  }
  if (type.kind === "JSON") {
    JSON.parse(raw);
    return `CAST(${quoteString(raw)} AS JSON)`;
  }
  JSON.parse(raw);
  return `CAST(CAST(${quoteString(raw)} AS JSON) AS ${targetType})`;
}

export function buildEvaluationSql(
  model: NormalizedModel,
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
): string {
  const pairColumns = columns.flatMap((column) => {
    const type = columnTypes[column] ?? { kind: "VARCHAR" as const };
    return [
      `${typedLiteral(values.left[column] ?? "", type)} AS ${quoteIdentifier(`${column}_l`)}`,
      `${typedLiteral(values.right[column] ?? "", type)} AS ${quoteIdentifier(`${column}_r`)}`,
    ];
  });
  const gammas = model.comparisons.map((comparison, index) =>
    comparisonCase(comparison, `gamma_${index}`),
  );
  return `WITH pair AS (SELECT\n  ${pairColumns.join(",\n  ")}\n)\nSELECT\n  ${gammas.join(",\n  ")}\nFROM pair`;
}

export function buildComparisonEvaluationSqls(
  model: NormalizedModel,
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
): string[] {
  return model.comparisons.map((comparison) =>
    buildEvaluationSql(
      { ...model, comparisons: [comparison] },
      columns,
      columnTypes,
      values,
    ),
  );
}

export async function evaluatePair(sql: string): Promise<number[]> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const result = await connection.query(sql);
    const row = result.toArray()[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("DuckDB returned no comparison result.");
    return Object.values(row).map((value) => Number(value));
  } finally {
    await connection.close();
  }
}