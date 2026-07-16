export type Probability = number | null | "level not observed";

export interface SplinkComparisonLevel {
  sql_condition: string;
  label_for_charts?: string;
  is_null_level?: boolean;
  m_probability?: Probability;
  u_probability?: Probability;
  tf_adjustment_column?: string | null;
  tf_adjustment_weight?: number;
  tf_minimum_u_value?: number;
  disable_tf_exact_match_detection?: boolean;
  comparison_vector_value?: number;
}

export interface SplinkComparison {
  output_column_name: string;
  comparison_description?: string;
  comparison_levels: SplinkComparisonLevel[];
}

export interface SplinkBlockingRule {
  blocking_rule: string;
  sql_dialect?: string;
}

export interface SplinkModel {
  sql_dialect?: string;
  link_type: string;
  probability_two_random_records_match: number;
  comparisons: SplinkComparison[];
  blocking_rules_to_generate_predictions?: Array<SplinkBlockingRule | string>;
  example_data?: SplinkExampleData;
}

export interface NormalizedLevel extends SplinkComparisonLevel {
  label_for_charts: string;
  comparison_vector_value: number;
}

export interface NormalizedComparison extends Omit<SplinkComparison, "comparison_levels"> {
  comparison_levels: NormalizedLevel[];
}

export interface NormalizedModel extends Omit<SplinkModel, "comparisons"> {
  comparisons: NormalizedComparison[];
}

export type ColumnKind =
  | "VARCHAR"
  | "DOUBLE"
  | "BOOLEAN"
  | "DATE"
  | "TIMESTAMP"
  | "VARCHAR[]"
  | "DOUBLE[]"
  | "JSON"
  | "CUSTOM";

export interface ColumnType {
  kind: ColumnKind;
  customType?: string;
}

export interface SplinkExampleData {
  version: 1;
  column_types: Record<string, ColumnType>;
  record_l: Record<string, unknown>;
  record_r: Record<string, unknown>;
  derived_columns?: Record<string, string>;
  term_frequency_adjustments?: Record<string, number>;
}

export interface PairValues {
  left: Record<string, string | null>;
  right: Record<string, string | null>;
}

export interface ComparisonResult {
  comparison: NormalizedComparison;
  gamma: number;
  level: NormalizedLevel;
  matchWeight: number | null;
  tfAdjustment: number;
}

export interface ChartDatum {
  comparison_name: string;
  comparison_sort_order: number;
  label_for_charts: string;
  sql_condition: string | null;
  comparison_vector_value: number;
  max_comparison_vector_value: number;
  m_probability: number | null;
  u_probability: number | null;
  m_probability_description: string | null;
  u_probability_description: string | null;
  bayes_factor: number | null;
  log2_bayes_factor: number | null;
  bayes_factor_description: string | null;
  probability_two_random_records_match: number;
  has_tf_adjustments: boolean;
  tf_adjustment_column: string | null;
  tf_adjustment_weight: number | null;
  is_null_level: boolean;
}