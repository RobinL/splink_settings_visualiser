import type { VisualizationSpec } from "vega-embed";
import matchWeightsTemplate from "../splink/splink/internals/files/chart_defs/match_weights_interactive_history.json";
import muParametersTemplate from "../splink/splink/internals/files/chart_defs/m_u_parameters_interactive_history.json";
import waterfallTemplate from "../splink/splink/internals/files/chart_defs/match_weights_waterfall.json";
import {
  bayesFactorDescription,
  chartData,
  finalMatchWeight,
  priorWeight,
} from "./model";
import type {
  ChartDatum,
  ComparisonResult,
  NormalizedComparison,
  NormalizedModel,
  PairValues,
} from "./types";

interface SplinkMatchWeightsSpec {
  data: { values: unknown };
  params?: unknown;
  transform?: unknown;
  vconcat: [
    { encoding: { x: { scale: { domain: number[] } } } },
    { encoding: { x: { scale: { domain: number[] } } } },
  ];
}

interface SplinkMuSpec {
  data: { values: unknown };
  params?: unknown;
  transform?: unknown;
}

interface SplinkWaterfallSpec {
  data: { values: unknown };
  params?: unknown;
  transform: unknown[];
}

export function matchWeightsSpec(data: ChartDatum[]): VisualizationSpec {
  const spec = structuredClone(matchWeightsTemplate) as unknown as SplinkMatchWeightsSpec;
  delete spec.params;
  delete spec.transform;
  spec.data.values = data;

  const finiteWeights = data
    .map((record) => record.log2_bayes_factor)
    .filter((weight): weight is number => weight !== null && Number.isFinite(weight))
    .map(Math.abs);
  const maxValue = Math.max(1, Math.ceil(Math.max(...finiteWeights)));
  spec.vconcat[0].encoding.x.scale.domain = [-maxValue, maxValue];
  spec.vconcat[1].encoding.x.scale.domain = [-maxValue, maxValue];
  return spec as unknown as VisualizationSpec;
}

export function muParametersSpec(data: ChartDatum[]): VisualizationSpec {
  const spec = structuredClone(muParametersTemplate) as unknown as SplinkMuSpec;
  delete spec.params;
  delete spec.transform;
  spec.data.values = data.filter(
    (record) => record.comparison_name !== "probability_two_random_records_match",
  );
  return spec as unknown as VisualizationSpec;
}

export interface WaterfallDatum {
  bar_sort_order: number;
  record_number: number;
  column_name: string;
  label_for_charts: string;
  sql_condition: string | null;
  log2_bayes_factor: number | null;
  bayes_factor: number | null;
  comparison_vector_value: number | null;
  m_probability: number | null;
  u_probability: number | null;
  bayes_factor_description: string | null;
  value_l: string;
  value_r: string;
  term_frequency_adjustment: boolean | null;
}

function inputColumnsForComparison(
  comparison: NormalizedComparison,
  columns: string[],
): string[] {
  const sql = comparison.comparison_levels
    .map((level) => level.sql_condition)
    .join(" ")
    .replaceAll('"', "")
    .toLowerCase();
  return columns.filter(
    (column) =>
      sql.includes(`${column.toLowerCase()}_l`) ||
      comparison.comparison_levels.some((level) => level.tf_adjustment_column === column),
  );
}

function displayValue(value: string | null | undefined): string {
  return value === null ? "None" : (value ?? "");
}

function termFrequencyDescription(column: string, bayesFactor: number): string {
  const start = `Term frequency adjustment on ${column} makes comparison`;
  if (bayesFactor >= 1) return `${start} ${bayesFactor.toFixed(2)} times more likely to be a match`;
  const multiplier = bayesFactor > 0 ? 1 / bayesFactor : Number.POSITIVE_INFINITY;
  return `${start} ${multiplier.toFixed(2)} times less likely to be a match`;
}

export function waterfallData(
  model: NormalizedModel,
  results: ComparisonResult[],
  values: PairValues,
  columns: string[],
): WaterfallDatum[] {
  const prior = model.probability_two_random_records_match;
  const priorBayesFactor = prior / (1 - prior);
  const rows: WaterfallDatum[] = [
    {
      bar_sort_order: 0,
      record_number: 0,
      column_name: "Prior",
      label_for_charts: "Starting match weight (prior)",
      sql_condition: null,
      log2_bayes_factor: priorWeight(model),
      bayes_factor: priorBayesFactor,
      comparison_vector_value: null,
      m_probability: null,
      u_probability: null,
      bayes_factor_description: null,
      value_l: "",
      value_r: "",
      term_frequency_adjustment: null,
    },
  ];

  const detailedRecords = chartData(model);
  results.forEach((result) => {
    const detailed = detailedRecords.find(
      (record) =>
        record.comparison_name === result.comparison.output_column_name &&
        record.comparison_vector_value === result.gamma,
    );
    const usedColumns = inputColumnsForComparison(result.comparison, columns);
    const baseRecord: WaterfallDatum = {
      bar_sort_order: rows.length,
      record_number: 0,
      column_name: result.comparison.output_column_name,
      label_for_charts: detailed?.label_for_charts ?? result.level.label_for_charts,
      sql_condition: result.level.sql_condition,
      log2_bayes_factor: result.matchWeight,
      bayes_factor: result.matchWeight === null ? null : 2 ** result.matchWeight,
      comparison_vector_value: result.gamma,
      m_probability: detailed?.m_probability ?? null,
      u_probability: detailed?.u_probability ?? null,
      bayes_factor_description:
        detailed?.bayes_factor_description ??
        bayesFactorDescription(
          result.level.label_for_charts,
          result.matchWeight === null ? null : 2 ** result.matchWeight,
        ),
      value_l: usedColumns.map((column) => displayValue(values.left[column])).join(", "),
      value_r: usedColumns.map((column) => displayValue(values.right[column])).join(", "),
      term_frequency_adjustment: false,
    };
    rows.push(baseRecord);

    if (result.comparison.comparison_levels.some((level) => level.tf_adjustment_column)) {
      const tfColumn = result.level.tf_adjustment_column;
      const tfBayesFactor = 2 ** result.tfAdjustment;
      rows.push({
        ...baseRecord,
        bar_sort_order: rows.length,
        column_name: `tf_${result.comparison.output_column_name}`,
        label_for_charts: tfColumn
          ? `Term freq adjustment on ${tfColumn}`
          : baseRecord.label_for_charts,
        log2_bayes_factor: tfColumn ? result.tfAdjustment : 0,
        bayes_factor: tfColumn ? tfBayesFactor : 1,
        m_probability: null,
        u_probability: null,
        bayes_factor_description: tfColumn
          ? termFrequencyDescription(tfColumn, tfBayesFactor)
          : baseRecord.bayes_factor_description,
        value_l: tfColumn ? displayValue(values.left[tfColumn]) : "",
        value_r: tfColumn ? displayValue(values.right[tfColumn]) : "",
        term_frequency_adjustment: true,
      });
    }
  });

  const finalWeight = finalMatchWeight(model, results);
  if (finalWeight !== null) {
    rows.push({
      bar_sort_order: rows.length,
      record_number: 0,
      column_name: "Final score",
      label_for_charts: "Final score",
      sql_condition: null,
      log2_bayes_factor: finalWeight,
      bayes_factor: 2 ** finalWeight,
      comparison_vector_value: null,
      m_probability: null,
      u_probability: null,
      bayes_factor_description: null,
      value_l: "",
      value_r: "",
      term_frequency_adjustment: null,
    });
  }
  return rows;
}

export function waterfallSpec(data: WaterfallDatum[]): VisualizationSpec {
  const spec = structuredClone(waterfallTemplate) as unknown as SplinkWaterfallSpec;
  delete spec.params;
  spec.data.values = data;
  spec.transform.splice(0, 1, { filter: "(datum.bayes_factor !== 1.0)" });
  return spec as unknown as VisualizationSpec;
}