import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbEhWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type {
  ColumnKind,
  ColumnType,
  NormalizedComparison,
  NormalizedModel,
  PairValues,
  SplinkExampleData,
} from "./types";
import { candidateKindsForColumn, isDateLikeColumn } from "./heuristics";

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

interface DuckDBParsedSql {
  error: boolean;
  error_message?: string;
  statements: Array<{ node: Record<string, unknown> }>;
}

async function parseSqlAst(
  connection: duckdb.AsyncDuckDBConnection,
  sql: string,
): Promise<DuckDBParsedSql> {
  const statement = await connection.prepare(
    "SELECT json_serialize_sql(CAST(? AS VARCHAR), skip_null := true) AS ast",
  );
  try {
    const result = await statement.query(sql);
    const astValue = result.toArray()[0]?.ast;
    if (typeof astValue !== "string") throw new Error("DuckDB returned no parsed SQL tree.");
    const parsed = JSON.parse(astValue, (key, value: unknown) =>
      key === "query_location" ? undefined : value,
    ) as DuckDBParsedSql;
    if (parsed.error) throw new Error(parsed.error_message ?? "DuckDB could not parse the model SQL.");
    return parsed;
  } finally {
    await statement.close();
  }
}

async function deserializeSqlAst(
  connection: duckdb.AsyncDuckDBConnection,
  ast: DuckDBParsedSql,
): Promise<string> {
  const statement = await connection.prepare(
    "SELECT json_deserialize_sql(CAST(? AS VARCHAR)) AS sql",
  );
  try {
    const result = await statement.query(JSON.stringify(ast));
    const sql = result.toArray()[0]?.sql;
    if (typeof sql !== "string") throw new Error("DuckDB could not regenerate function SQL.");
    return sql.trim().replace(/;$/, "");
  } finally {
    await statement.close();
  }
}

function collectFunctionNodes(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFunctionNodes(item, output));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (
    record.class === "FUNCTION" &&
    typeof record.function_name === "string" &&
    record.is_operator !== true
  ) {
    output.push(record);
  }
  Object.values(record).forEach((item) => collectFunctionNodes(item, output));
}

function selectWithExpression(
  template: DuckDBParsedSql,
  expression: Record<string, unknown>,
): DuckDBParsedSql {
  const ast = structuredClone(template);
  const selectNode = ast.statements[0]?.node;
  if (!selectNode || !Array.isArray(selectNode.select_list)) {
    throw new Error("DuckDB returned an unexpected SELECT tree.");
  }
  selectNode.select_list = [structuredClone(expression)];
  return ast;
}

function basePairColumn(reference: string): string | null {
  const tableMatch = reference.match(/^(?:l|r)\.(.+)$/i);
  if (tableMatch) return tableMatch[1];
  const suffixMatch = reference.match(/^(.+)_(?:l|r)$/i);
  return suffixMatch?.[1] ?? null;
}

function replacePairColumns(
  value: unknown,
  replacements: Map<string, Record<string, unknown>>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replacePairColumns(item, replacements));
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.class === "COLUMN_REF" && Array.isArray(record.column_names)) {
    const names = record.column_names.filter((name): name is string => typeof name === "string");
    const replacement = replacements.get(names.join("."));
    if (replacement) return structuredClone(replacement);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      replacePairColumns(item, replacements),
    ]),
  );
}

function comparisonColumnUsage(ast: DuckDBParsedSql): Set<string>[] {
  const selectList = ast.statements[0]?.node.select_list;
  if (!Array.isArray(selectList)) {
    throw new Error("DuckDB returned an unexpected comparison SELECT tree.");
  }
  return selectList.map((expression) => {
    const references = new Set<string>();
    collectColumnReferences(expression, references);
    return new Set(
      [...references]
        .map(basePairColumn)
        .filter((column): column is string => column !== null),
    );
  });
}

function valuesForCandidate(
  values: PairValues,
  column: string,
  kind: ColumnKind,
): PairValues {
  const examples: Record<ColumnKind, [string, string]> = {
    VARCHAR: ["example", "sample"],
    DOUBLE: ["42", "43"],
    BOOLEAN: ["true", "false"],
    DATE: ["1990-01-01", "1990-01-02"],
    TIMESTAMP: ["1990-01-01T12:00", "1990-01-02T12:00"],
    "VARCHAR[]": ['["example"]', '["sample"]'],
    "DOUBLE[]": ["[42]", "[43]"],
    JSON: ['{"value":"example"}', '{"value":"sample"}'],
    CUSTOM: ["{}", "{}"],
  };
  const [fallbackLeft, fallbackRight] = examples[kind];
  return {
    left: {
      ...values.left,
      [column]: fallbackLeft,
    },
    right: {
      ...values.right,
      [column]: fallbackRight,
    },
  };
}

export function valuesForColumnTypes(
  values: PairValues,
  columnTypes: Record<string, ColumnType>,
): PairValues {
  return Object.entries(columnTypes).reduce(
    (current, [column, type]) =>
      type.kind === "VARCHAR"
        ? current
        : valuesForCandidate(current, column, type.kind),
    values,
  );
}

async function queriesSucceed(
  connection: duckdb.AsyncDuckDBConnection,
  queries: string[],
): Promise<boolean> {
  try {
    for (const query of queries) await connection.query(query);
    return true;
  } catch {
    return false;
  }
}

export async function discoverColumns(model: NormalizedModel): Promise<string[]> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const parsedSql = `SELECT ${model.comparisons
      .map((comparison, index) => comparisonCase(comparison, `gamma_${index}`))
      .join(", ")}`;
    const ast = await parseSqlAst(connection, parsedSql);
    const references = new Set<string>();
    collectColumnReferences(ast, references);
    const columns = [...references]
      .map(basePairColumn)
      .filter((column): column is string => column !== null);
    model.comparisons.forEach((comparison) => {
      comparison.comparison_levels.forEach((level) => {
        if (level.tf_adjustment_column) columns.push(level.tf_adjustment_column);
      });
    });
    for (const expression of Object.values(model.example_data?.derived_columns ?? {})) {
      const derivedAst = await parseSqlAst(connection, `SELECT ${expression}`);
      const derivedReferences = new Set<string>();
      collectColumnReferences(derivedAst, derivedReferences);
      columns.push(...derivedReferences);
    }
    return [...new Set(columns)];
  } finally {
    await connection.close();
  }
}

export async function inferColumnTypes(
  model: NormalizedModel,
  columns: string[],
  values: PairValues,
): Promise<Record<string, ColumnType>> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const parsedSql = `SELECT ${model.comparisons
      .map((comparison, index) => comparisonCase(comparison, `gamma_${index}`))
      .join(", ")}`;
    const usage = comparisonColumnUsage(await parseSqlAst(connection, parsedSql));
    const inferred: Record<string, ColumnType> = Object.fromEntries(
      columns.map((column) => [
        column,
        model.example_data?.column_types[column] ?? {
          kind: isDateLikeColumn(column) ? "DATE" : "VARCHAR",
        },
      ]),
    );

    for (const column of columns) {
      const relevantIndexes = usage.flatMap((usedColumns, index) =>
        usedColumns.has(column) ? [index] : [],
      );
      if (relevantIndexes.length === 0) continue;

      const fallback: ColumnType = {
        kind: isDateLikeColumn(column) ? "DATE" : "VARCHAR",
      };
      const candidates = [
        model.example_data?.column_types[column],
        ...candidateKindsForColumn(column).map((kind) => ({ kind }) as ColumnType),
      ].filter((type): type is ColumnType => type !== undefined);
      const uniqueCandidates = candidates.filter(
        (candidate, index) =>
          candidates.findIndex(
            (other) => JSON.stringify(other) === JSON.stringify(candidate),
          ) === index,
      );
      let selected: ColumnType | undefined;
      for (const candidate of uniqueCandidates) {
        const candidateTypes = { ...inferred, [column]: candidate };
        const candidateValues = valuesForCandidate(values, column, candidate.kind);
        const statements = buildComparisonEvaluationSqls(
          model,
          columns,
          candidateTypes,
          candidateValues,
        );
        if (
          await queriesSucceed(
            connection,
            relevantIndexes.map((index) => statements[index]),
          )
        ) {
          selected = candidate;
          break;
        }
      }
      inferred[column] = selected ?? fallback;
    }
    return inferred;
  } finally {
    await connection.close();
  }
}

export async function discoverFunctionExpressions(model: NormalizedModel): Promise<string[][]> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const parsedSql = `SELECT ${model.comparisons
      .map((comparison, index) => comparisonCase(comparison, `gamma_${index}`))
      .join(", ")}`;
    const ast = await parseSqlAst(connection, parsedSql);
    const template = await parseSqlAst(connection, "SELECT 1");
    const selectList = ast.statements[0]?.node.select_list;
    if (!Array.isArray(selectList)) {
      throw new Error("DuckDB returned an unexpected comparison SELECT tree.");
    }
    const expressionsByComparison: string[][] = [];
    for (const comparisonExpression of selectList) {
      const functionNodes: Record<string, unknown>[] = [];
      collectFunctionNodes(comparisonExpression, functionNodes);
      const generated: string[] = [];
      for (const node of functionNodes) {
        generated.push(
          await deserializeSqlAst(connection, selectWithExpression(template, node)),
        );
      }
      expressionsByComparison.push([
        ...new Set(generated.map((sql) => sql.slice("SELECT ".length))),
      ]);
    }
    return expressionsByComparison;
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

export function displayLiteral(raw: string | null, type: ColumnType): string {
  if (raw === null) return "NULL";
  if (type.kind !== "VARCHAR" && raw.trim() === "") return "NULL";
  if (type.kind === "VARCHAR") return quoteString(raw);
  if (type.kind === "DOUBLE") {
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`'${raw}' is not a valid number.`);
    return String(number);
  }
  if (type.kind === "BOOLEAN") {
    if (!/^(true|false)$/i.test(raw)) throw new Error(`'${raw}' is not a valid boolean.`);
    return raw.toUpperCase();
  }
  if (type.kind === "DATE") return `DATE ${quoteString(raw)}`;
  if (type.kind === "TIMESTAMP") return `TIMESTAMP ${quoteString(raw)}`;
  return typedLiteral(raw, type);
}

export async function substitutePairValues(
  expressions: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
): Promise<string[]> {
  if (expressions.length === 0) return [];
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const replacements = new Map<string, Record<string, unknown>>();
    for (const [side, suffix] of [["left", "l"], ["right", "r"]] as const) {
      for (const [column, raw] of Object.entries(values[side])) {
        const type = columnTypes[column] ?? { kind: "VARCHAR" as const };
        const literalAst = await parseSqlAst(
          connection,
          `SELECT ${displayLiteral(raw, type)}`,
        );
        const literal = literalAst.statements[0]?.node.select_list;
        if (!Array.isArray(literal) || typeof literal[0] !== "object" || literal[0] === null) {
          throw new Error("DuckDB returned an unexpected literal tree.");
        }
        replacements.set(`${column}_${suffix}`, literal[0] as Record<string, unknown>);
        replacements.set(`${suffix}.${column}`, literal[0] as Record<string, unknown>);
      }
    }

    const substituted: string[] = [];
    for (const expression of expressions) {
      if (/^\s*else\s*$/i.test(expression)) {
        substituted.push(expression);
        continue;
      }
      const ast = await parseSqlAst(connection, `SELECT ${expression}`);
      const selectList = ast.statements[0]?.node.select_list;
      if (!Array.isArray(selectList) || !selectList[0]) {
        throw new Error("DuckDB returned an unexpected expression tree.");
      }
      ast.statements[0].node.select_list = [
        replacePairColumns(selectList[0], replacements),
      ];
      const sql = await deserializeSqlAst(connection, ast);
      substituted.push(sql.slice("SELECT ".length));
    }
    return substituted;
  } finally {
    await connection.close();
  }
}

function recordCtes(
  alias: "l" | "r",
  side: keyof PairValues,
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string>,
): string[] {
  const derivations = Object.entries(derivedColumns).filter(
    ([column, expression]) => columns.includes(column) && expression.trim(),
  );
  const derivedNames = new Set(derivations.map(([column]) => column));
  const projected = columns
    .filter((column) => !derivedNames.has(column))
    .map((column) => {
      const type = columnTypes[column] ?? { kind: "VARCHAR" as const };
      const raw = values[side][column] === undefined ? "" : values[side][column];
      return `${typedLiteral(raw, type)} AS ${quoteIdentifier(column)}`;
    });
  const baseName = `${alias}_base`;
  const ctes = [
    `${baseName} AS (SELECT\n  ${projected.length > 0 ? projected.join(",\n  ") : "1 AS __placeholder"}\n)`,
  ];
  let source = baseName;
  derivations.forEach(([column, expression], index) => {
    const target = `${alias}_derived_${index}`;
    ctes.push(
      `${target} AS (SELECT *, (${expression}) AS ${quoteIdentifier(column)} FROM ${source})`,
    );
    source = target;
  });
  ctes.push(`${alias} AS (SELECT * FROM ${source})`);
  return ctes;
}

function pairCte(
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string>,
): string {
  const records = [
    ...recordCtes("l", "left", columns, columnTypes, values, derivedColumns),
    ...recordCtes("r", "right", columns, columnTypes, values, derivedColumns),
  ];
  const pairColumns = columns.flatMap((column) => {
    return [
      `l.${quoteIdentifier(column)} AS ${quoteIdentifier(`${column}_l`)}`,
      `r.${quoteIdentifier(column)} AS ${quoteIdentifier(`${column}_r`)}`,
    ];
  });
  return `WITH ${records.join(",\n")},\npair AS (SELECT\n  ${pairColumns.join(",\n  ")}\nFROM l CROSS JOIN r\n)`;
}

export function buildBlockingRuleEvaluationSqls(
  rules: string[],
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string> = {},
): string[] {
  const records = `WITH ${[
    ...recordCtes("l", "left", columns, columnTypes, values, derivedColumns),
    ...recordCtes("r", "right", columns, columnTypes, values, derivedColumns),
  ].join(",\n")}`;
  return rules.map(
    (rule) =>
      `${records}\nSELECT COALESCE((${rule}), FALSE) AS function_value\nFROM l CROSS JOIN r`,
  );
}

export function buildEvaluationSql(
  model: NormalizedModel,
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string> = model.example_data?.derived_columns ?? {},
): string {
  const gammas = model.comparisons.map((comparison, index) =>
    comparisonCase(comparison, `gamma_${index}`),
  );
  return `${pairCte(columns, columnTypes, values, derivedColumns)}\nSELECT\n  ${gammas.join(",\n  ")}\nFROM pair`;
}

export function buildComparisonEvaluationSqls(
  model: NormalizedModel,
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string> = model.example_data?.derived_columns ?? {},
): string[] {
  return model.comparisons.map((comparison) =>
    buildEvaluationSql(
      { ...model, comparisons: [comparison] },
      columns,
      columnTypes,
      values,
      derivedColumns,
    ),
  );
}

export function buildFunctionEvaluationSqls(
  expressions: string[],
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string> = {},
): string[] {
  const pair = pairCte(columns, columnTypes, values, derivedColumns);
  return expressions.map(
    (expression) => `${pair}\nSELECT ${expression} AS function_value\nFROM pair`,
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

export async function evaluateExpression(sql: string): Promise<unknown> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const result = await connection.query(sql);
    const row = result.toArray()[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("DuckDB returned no function result.");
    return row.function_value;
  } finally {
    await connection.close();
  }
}

export async function materializeDerivedValues(
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string>,
): Promise<PairValues> {
  const derivedNames = columns.filter((column) => column in derivedColumns);
  if (derivedNames.length === 0) return values;
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const projections = derivedNames.flatMap((column) =>
      (["l", "r"] as const).map(
        (suffix) =>
          `CAST(${quoteIdentifier(`${column}_${suffix}`)} AS VARCHAR) AS ${quoteIdentifier(`${column}_${suffix}`)}`,
      ),
    );
    const result = await connection.query(
      `${pairCte(columns, columnTypes, values, derivedColumns)}\nSELECT\n  ${projections.join(",\n  ")}\nFROM pair`,
    );
    const row = result.toArray()[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("DuckDB returned no derived record values.");
    const resolved: PairValues = {
      left: { ...values.left },
      right: { ...values.right },
    };
    for (const column of derivedNames) {
      const left = row[`${column}_l`];
      const right = row[`${column}_r`];
      resolved.left[column] = left === null ? null : String(left);
      resolved.right[column] = right === null ? null : String(right);
    }
    return resolved;
  } finally {
    await connection.close();
  }
}

export async function serializeExampleData(
  columns: string[],
  columnTypes: Record<string, ColumnType>,
  values: PairValues,
  derivedColumns: Record<string, string> = {},
): Promise<SplinkExampleData> {
  const database = await getDatabase();
  const connection = await database.connect();
  try {
    const serializableColumns = columns.filter(
      (column) => !(column in derivedColumns),
    );
    const jsonArguments = (suffix: "l" | "r") =>
      serializableColumns
        .flatMap((column) => [
          quoteString(column),
          quoteIdentifier(`${column}_${suffix}`),
        ])
        .join(", ");
    const result = await connection.query(
      `${pairCte(columns, columnTypes, values, derivedColumns)}\nSELECT\n` +
        `  CAST(json_object(${jsonArguments("l")}) AS VARCHAR) AS record_l,\n` +
        `  CAST(json_object(${jsonArguments("r")}) AS VARCHAR) AS record_r\n` +
        "FROM pair",
    );
    const row = result.toArray()[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("DuckDB returned no example data.");
    return {
      version: 1,
      column_types: Object.fromEntries(
        serializableColumns.map((column) => [
          column,
          columnTypes[column] ?? { kind: "VARCHAR" as const },
        ]),
      ),
      record_l: JSON.parse(String(row.record_l)) as Record<string, unknown>,
      record_r: JSON.parse(String(row.record_r)) as Record<string, unknown>,
      derived_columns:
        Object.keys(derivedColumns).length > 0 ? derivedColumns : undefined,
    };
  } finally {
    await connection.close();
  }
}