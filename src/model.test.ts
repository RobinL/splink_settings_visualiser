import { describe, expect, it } from "vitest";
import {
  buildComparisonEvaluationSqls,
  buildEvaluationSql,
  buildFunctionEvaluationSqls,
  displayLiteral,
} from "./duckdb";
import {
  chartData,
  finalMatchWeight,
  matchWeight,
  parseModel,
  termFrequencyAdjustment,
} from "./model";

const model = parseModel({
  sql_dialect: "duckdb",
  link_type: "dedupe_only",
  probability_two_random_records_match: 0.01,
  comparisons: [
    {
      output_column_name: "name",
      comparison_levels: [
        { sql_condition: "name_l IS NULL OR name_r IS NULL", is_null_level: true },
        {
          sql_condition: "name_l = name_r",
          label_for_charts: "Exact match",
          m_probability: 0.9,
          u_probability: 0.1,
          tf_adjustment_column: "name",
        },
        { sql_condition: "ELSE", m_probability: 0.1, u_probability: 0.9 },
      ],
    },
  ],
});

describe("Splink model normalization", () => {
  it("reconstructs comparison vector values in Splink order", () => {
    expect(model.comparisons[0].comparison_levels.map((level) => level.comparison_vector_value)).toEqual([
      -1,
      1,
      0,
    ]);
  });

  it("creates chart records and match weights from trained probabilities", () => {
    const records = chartData(model);
    expect(records).toHaveLength(3);
    expect(records[0].comparison_name).toBe("probability_two_random_records_match");
    expect(records.some((record) => record.comparison_vector_value === -1)).toBe(false);
    expect(matchWeight(model.comparisons[0].comparison_levels[1])).toBeCloseTo(Math.log2(9));
  });

  it("applies Splink's term-frequency adjustment formula", () => {
    const comparison = model.comparisons[0];
    expect(termFrequencyAdjustment(comparison, comparison.comparison_levels[1], 0.02, 0.03)).toBeCloseTo(
      Math.log2(0.1 / 0.03),
    );
  });

  it("returns no final score when a selected level is untrained", () => {
    expect(
      finalMatchWeight(model, [
        {
          comparison: model.comparisons[0],
          gamma: 1,
          level: model.comparisons[0].comparison_levels[1],
          matchWeight: null,
          tfAdjustment: 0,
        },
      ]),
    ).toBeNull();
  });
});

describe("DuckDB evaluation SQL", () => {
  it("formats pair values as copyable typed SQL literals", () => {
    expect(displayLiteral("O'Brien", { kind: "VARCHAR" })).toBe("'O''Brien'");
    expect(displayLiteral(null, { kind: "VARCHAR" })).toBe("NULL");
    expect(displayLiteral("1990-01-01", { kind: "DATE" })).toBe("DATE '1990-01-01'");
    expect(displayLiteral("42.5", { kind: "DOUBLE" })).toBe("42.5");
    expect(displayLiteral("true", { kind: "BOOLEAN" })).toBe("TRUE");
  });

  it("casts scalar, list, and struct values into a one-row pair", () => {
    const sql = buildEvaluationSql(
      model,
      ["name", "tags", "profile"],
      {
        name: { kind: "VARCHAR" },
        tags: { kind: "VARCHAR[]" },
        profile: { kind: "CUSTOM", customType: "STRUCT(city VARCHAR, score DOUBLE)" },
      },
      {
        left: { name: "O'Brien", tags: '["a"]', profile: '{"city":"Leeds","score":2}' },
        right: { name: "Robin", tags: '["b"]', profile: '{"city":"York","score":3}' },
      },
    );
    expect(sql).toContain("O''Brien");
    expect(sql).toContain("AS \"tags_l\"");
    expect(sql).toContain("STRUCT(city VARCHAR, score DOUBLE)");
    expect(sql).toContain("WHEN name_l = name_r THEN 1");
  });

  it("isolates comparison SQL so one binder error cannot block other outcomes", () => {
    const twoComparisonModel = parseModel({
      ...model,
      comparisons: [
        ...model.comparisons,
        {
          output_column_name: "age",
          comparison_levels: [
            { sql_condition: "age_l = age_r", m_probability: 0.8, u_probability: 0.2 },
            { sql_condition: "ELSE", m_probability: 0.2, u_probability: 0.8 },
          ],
        },
      ],
    });
    const statements = buildComparisonEvaluationSqls(
      twoComparisonModel,
      ["name", "age"],
      { name: { kind: "DOUBLE" }, age: { kind: "DOUBLE" } },
      { left: { name: "1", age: "42" }, right: { name: "2", age: "42" } },
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("name_l = name_r");
    expect(statements[0]).not.toContain("age_l = age_r");
    expect(statements[1]).toContain("age_l = age_r");
    expect(statements[1]).not.toContain("name_l = name_r");
  });

  it("preserves explicit nulls and evaluates discovered functions against the same pair", () => {
    const values = {
      left: { name: null },
      right: { name: "Robin" },
    };
    const evaluationSql = buildEvaluationSql(
      model,
      ["name"],
      { name: { kind: "VARCHAR" } },
      values,
    );
    const [functionSql] = buildFunctionEvaluationSqls(
      ["jaro_winkler_similarity(name_l, name_r)"],
      ["name"],
      { name: { kind: "VARCHAR" } },
      values,
    );

    expect(evaluationSql).toContain('CAST(NULL AS VARCHAR) AS "name_l"');
    expect(functionSql).toContain('CAST(NULL AS VARCHAR) AS "name_l"');
    expect(functionSql).toContain(
      "SELECT jaro_winkler_similarity(name_l, name_r) AS function_value",
    );
  });
});