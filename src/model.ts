import type {
  ChartDatum,
  ColumnKind,
  ColumnType,
  ComparisonResult,
  NormalizedComparison,
  NormalizedLevel,
  NormalizedModel,
  PairValues,
  SplinkExampleData,
  SplinkModel,
} from "./types";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const COLUMN_KINDS = new Set<ColumnKind>([
  "VARCHAR",
  "DOUBLE",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "VARCHAR[]",
  "DOUBLE[]",
  "JSON",
  "CUSTOM",
]);

function validateExampleData(value: unknown): asserts value is SplinkExampleData {
  if (!isObject(value) || value.version !== 1) {
    throw new Error("example_data must be a version 1 object.");
  }
  if (!isObject(value.column_types) || !isObject(value.record_l) || !isObject(value.record_r)) {
    throw new Error("example_data must contain column_types, record_l, and record_r objects.");
  }
  for (const [column, type] of Object.entries(value.column_types)) {
    if (!isObject(type) || !COLUMN_KINDS.has(type.kind as ColumnKind)) {
      throw new Error(`example_data has an invalid type for '${column}'.`);
    }
    if (type.kind === "CUSTOM" && typeof type.customType !== "string") {
      throw new Error(`example_data custom type '${column}' requires customType.`);
    }
  }
  if (value.term_frequency_adjustments !== undefined) {
    if (!isObject(value.term_frequency_adjustments)) {
      throw new Error("example_data term_frequency_adjustments must be an object.");
    }
    for (const [comparison, adjustment] of Object.entries(value.term_frequency_adjustments)) {
      if (typeof adjustment !== "number" || !Number.isFinite(adjustment)) {
        throw new Error(`example_data has an invalid TF adjustment for '${comparison}'.`);
      }
    }
  }
}

export function parseModel(value: unknown): NormalizedModel {
  if (!isObject(value)) throw new Error("The model must be a JSON object.");
  if (value.sql_dialect && value.sql_dialect !== "duckdb") {
    throw new Error(`This viewer supports DuckDB models; received '${String(value.sql_dialect)}'.`);
  }
  if (!Array.isArray(value.comparisons) || value.comparisons.length === 0) {
    throw new Error("The model does not contain any comparisons.");
  }
  const prior = value.probability_two_random_records_match;
  if (typeof prior !== "number" || prior <= 0 || prior >= 1) {
    throw new Error("probability_two_random_records_match must be between 0 and 1.");
  }

  const model = value as unknown as SplinkModel;
  if (model.example_data !== undefined) validateExampleData(model.example_data);
  if (
    model.blocking_rules_to_generate_predictions !== undefined &&
    !Array.isArray(model.blocking_rules_to_generate_predictions)
  ) {
    throw new Error("blocking_rules_to_generate_predictions must be an array.");
  }
  const comparisons: NormalizedComparison[] = model.comparisons.map((comparison, index) => {
    if (!comparison.output_column_name || !Array.isArray(comparison.comparison_levels)) {
      throw new Error(`Comparison ${index + 1} is missing its name or levels.`);
    }
    let counter = comparison.comparison_levels.filter((level) => !level.is_null_level).length - 1;
    const levels: NormalizedLevel[] = comparison.comparison_levels.map((level) => {
      if (typeof level.sql_condition !== "string") {
        throw new Error(`A level in '${comparison.output_column_name}' has no SQL condition.`);
      }
      const comparisonVectorValue =
        level.comparison_vector_value ?? (level.is_null_level ? -1 : counter--);
      return {
        ...level,
        label_for_charts: level.label_for_charts ?? level.sql_condition,
        comparison_vector_value: comparisonVectorValue,
      };
    });
    return { ...comparison, comparison_levels: levels };
  });
  return { ...model, comparisons };
}

export function blockingRuleSql(model: NormalizedModel): string[] {
  return (model.blocking_rules_to_generate_predictions ?? []).flatMap((rule) => {
    const sql = typeof rule === "string" ? rule : rule.blocking_rule;
    return typeof sql === "string" && sql.trim() ? [sql] : [];
  });
}

function editorValue(value: unknown, type: ColumnType): string | null {
  if (value === null) return null;
  if (
    type.kind === "VARCHAR" ||
    type.kind === "DOUBLE" ||
    type.kind === "DATE" ||
    type.kind === "TIMESTAMP"
  ) {
    return String(value);
  }
  if (type.kind === "BOOLEAN") return String(value).toLowerCase();
  return JSON.stringify(value);
}

export function editorStateFromExampleData(
  exampleData: SplinkExampleData | undefined,
  columns: string[],
  fallbackTypes: Record<string, ColumnType>,
  fallbackValues: PairValues,
): { columnTypes: Record<string, ColumnType>; values: PairValues } {
  if (!exampleData) return { columnTypes: fallbackTypes, values: fallbackValues };
  const columnTypes = Object.fromEntries(
    columns.map((column) => [
      column,
      exampleData.column_types[column] ?? fallbackTypes[column] ?? { kind: "VARCHAR" },
    ]),
  );
  const values: PairValues = {
    left: { ...fallbackValues.left },
    right: { ...fallbackValues.right },
  };
  for (const [side, record] of [
    ["left", exampleData.record_l],
    ["right", exampleData.record_r],
  ] as const) {
    for (const column of columns) {
      if (Object.prototype.hasOwnProperty.call(record, column)) {
        values[side][column] = editorValue(record[column], columnTypes[column]);
      }
    }
  }
  return { columnTypes, values };
}

export function numericProbability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function matchWeight(level: NormalizedLevel): number | null {
  if (level.is_null_level) return 0;
  const m = numericProbability(level.m_probability);
  const u = numericProbability(level.u_probability);
  return m !== null && u !== null && m > 0 && u > 0 ? Math.log2(m / u) : null;
}

function formatOneIn(value: number): string {
  if (!Number.isFinite(value)) return "inf";
  if (value >= 100) return Math.round(value).toLocaleString("en-US");
  return Number(value.toPrecision(4)).toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function probabilityDescription(
  probability: number | null,
  label: string,
  population: "matching" | "non-matching",
): string {
  if (probability === null) return "";
  const percentage = Number((probability * 100).toPrecision(4));
  return `Amongst ${population} record comparisons, ${percentage}% of records (i.e. one in ${formatOneIn(1 / probability)}) are in the ${label.toLowerCase()} comparison level`;
}

export function bayesFactorDescription(label: string, bayesFactor: number | null): string {
  const start = `If comparison level is \`${label.toLowerCase()}\` then comparison is`;
  if (bayesFactor === null) return "";
  if (bayesFactor === Number.POSITIVE_INFINITY) return `${start} certain to be a match`;
  if (bayesFactor === 0) return `${start} impossible to be a match`;
  if (bayesFactor >= 1) return `${start} ${formatOneIn(bayesFactor)} times more likely to be a match`;
  return `${start} ${formatOneIn(1 / bayesFactor)} times less likely to be a match`;
}

export function chartData(model: NormalizedModel): ChartDatum[] {
  const levelRecords = model.comparisons.flatMap((comparison, comparisonIndex) => {
    const nonNullLevels = comparison.comparison_levels.filter((level) => !level.is_null_level);
    const labels = comparison.comparison_levels.map((level) => level.label_for_charts);
    const hasDuplicateLabels = new Set(labels).size !== labels.length;
    return comparison.comparison_levels
      .filter((level) => !level.is_null_level)
      .map((level) => {
        const label = hasDuplicateLabels
          ? `${level.comparison_vector_value}. ${level.label_for_charts}`
          : level.label_for_charts;
        const m = numericProbability(level.m_probability);
        const u = numericProbability(level.u_probability);
        const weight = matchWeight(level);
        const bayesFactor = m !== null && u !== null ? m / u : null;
        return {
          comparison_name: comparison.output_column_name,
          comparison_sort_order: comparisonIndex,
          label_for_charts: label,
          sql_condition: level.sql_condition,
          comparison_vector_value: level.comparison_vector_value,
          max_comparison_vector_value: nonNullLevels.length - 1,
          m_probability: m,
          u_probability: u,
          m_probability_description: probabilityDescription(m, label, "matching"),
          u_probability_description: probabilityDescription(u, label, "non-matching"),
          bayes_factor: bayesFactor,
          log2_bayes_factor: weight,
          bayes_factor_description: bayesFactorDescription(label, bayesFactor),
          probability_two_random_records_match: model.probability_two_random_records_match,
          has_tf_adjustments: Boolean(level.tf_adjustment_column),
          tf_adjustment_column: level.tf_adjustment_column ?? null,
          tf_adjustment_weight: level.tf_adjustment_column ? (level.tf_adjustment_weight ?? 1) : null,
          is_null_level: false,
        };
      });
  });
  const prior = model.probability_two_random_records_match;
  const priorBayesFactor = prior / (1 - prior);
  const priorDescription = `The probability that two random records drawn at random match is ${prior.toFixed(3)} or one in ${formatOneIn(1 / prior)} records.This is equivalent to a starting match weight of ${Math.log2(priorBayesFactor).toFixed(3)}.`;
  return [
    {
      comparison_name: "probability_two_random_records_match",
      comparison_sort_order: -1,
      label_for_charts: "",
      sql_condition: null,
      comparison_vector_value: 0,
      max_comparison_vector_value: 0,
      m_probability: null,
      u_probability: null,
      m_probability_description: null,
      u_probability_description: null,
      bayes_factor: priorBayesFactor,
      log2_bayes_factor: Math.log2(priorBayesFactor),
      bayes_factor_description: priorDescription,
      probability_two_random_records_match: prior,
      has_tf_adjustments: false,
      tf_adjustment_column: null,
      tf_adjustment_weight: null,
      is_null_level: false,
    },
    ...levelRecords,
  ];
}

export function priorWeight(model: NormalizedModel): number {
  const prior = model.probability_two_random_records_match;
  return Math.log2(prior / (1 - prior));
}

function exactMatchU(comparison: NormalizedComparison, column: string): number | null {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normal = (sql: string) => sql.replaceAll('"', "").replace(/\s+/g, "").toLowerCase();
  const forward = new RegExp(`^${escaped.toLowerCase()}_l=${escaped.toLowerCase()}_r$`);
  const reverse = new RegExp(`^${escaped.toLowerCase()}_r=${escaped.toLowerCase()}_l$`);
  const level = comparison.comparison_levels.find((candidate) => {
    const sql = normal(candidate.sql_condition);
    return forward.test(sql) || reverse.test(sql);
  });
  return numericProbability(level?.u_probability);
}

export function termFrequencyAdjustment(
  comparison: NormalizedComparison,
  level: NormalizedLevel,
  leftFrequency?: number | null,
  rightFrequency?: number | null,
): number {
  const column = level.tf_adjustment_column;
  const weight = level.tf_adjustment_weight ?? 1;
  const isElse = /^\s*else\s*$/i.test(level.sql_condition);
  if (!column || weight === 0 || level.is_null_level || isElse) return 0;
  const frequencies = [leftFrequency, rightFrequency].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (frequencies.length === 0) return 0;
  const baseU = level.disable_tf_exact_match_detection
    ? numericProbability(level.u_probability)
    : exactMatchU(comparison, column);
  if (baseU === null || baseU <= 0) return 0;
  const actualU = Math.max(...frequencies, level.tf_minimum_u_value ?? 0);
  return weight * (Math.log2(baseU) - Math.log2(actualU));
}

export function humanReadableDescription(model: NormalizedModel): string {
  const comparisons = model.comparisons.map((comparison) => {
    const labels = comparison.comparison_levels
      .filter((level) => !level.is_null_level)
      .map((level) => level.label_for_charts)
      .join(", ");
    return `${comparison.output_column_name}: ${labels}`;
  });
  return [
    "SUMMARY OF LINKING MODEL",
    "The similarity of pairwise record comparisons is assessed as follows:",
    ...comparisons,
  ].join("\n\n");
}

export function finalMatchWeight(model: NormalizedModel, results: ComparisonResult[]): number | null {
  if (results.some((result) => result.matchWeight === null)) return null;
  return results.reduce(
    (total, result) => total + (result.matchWeight ?? 0) + result.tfAdjustment,
    priorWeight(model),
  );
}

export const matchProbability = (weight: number): number => 1 / (1 + 2 ** -weight);