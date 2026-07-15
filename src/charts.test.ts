import { describe, expect, it } from "vitest";
import matchWeightsTemplate from "../splink/splink/internals/files/chart_defs/match_weights_interactive_history.json";
import muParametersTemplate from "../splink/splink/internals/files/chart_defs/m_u_parameters_interactive_history.json";
import waterfallTemplate from "../splink/splink/internals/files/chart_defs/match_weights_waterfall.json";
import {
  matchWeightsSpec,
  muParametersSpec,
  waterfallData,
  waterfallSpec,
} from "./charts";
import { chartData, matchWeight, parseModel } from "./model";

interface MutableMatchWeightsSpec {
  data: { values: unknown };
  params?: unknown;
  transform?: unknown;
  vconcat: [
    { encoding: { x: { scale: { domain: number[] } } } },
    { encoding: { x: { scale: { domain: number[] } } } },
  ];
}

interface MutableMuSpec {
  data: { values: unknown };
  params?: unknown;
  transform?: unknown;
}

interface MutableWaterfallSpec {
  data: { values: unknown };
  params: [{ bind: { max: number } }];
  transform: unknown[];
}

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
        },
        {
          sql_condition: "ELSE",
          label_for_charts: "All other",
          m_probability: 0.1,
          u_probability: 0.9,
        },
      ],
    },
  ],
});

describe("Splink Vega-Lite specifications", () => {
  it("uses the match-weights template with Splink's static-chart mutations", () => {
    const data = chartData(model);
    const expected = structuredClone(matchWeightsTemplate) as unknown as MutableMatchWeightsSpec;
    delete expected.params;
    delete expected.transform;
    expected.data.values = data;
    const maxValue = Math.ceil(
      Math.max(...data.map((record) => Math.abs(record.log2_bayes_factor ?? 0))),
    );
    expected.vconcat[0].encoding.x.scale.domain = [-maxValue, maxValue];
    expected.vconcat[1].encoding.x.scale.domain = [-maxValue, maxValue];

    expect(matchWeightsSpec(data)).toEqual(expected);
  });

  it("uses the m/u template with Splink's static-chart mutations", () => {
    const data = chartData(model);
    const expected = structuredClone(muParametersTemplate) as unknown as MutableMuSpec;
    delete expected.params;
    delete expected.transform;
    expected.data.values = data.filter(
      (record) => record.comparison_name !== "probability_two_random_records_match",
    );

    expect(muParametersSpec(data)).toEqual(expected);
  });

  it("uses Splink's waterfall fields, values, and filter mutation", () => {
    const level = model.comparisons[0].comparison_levels[1];
    const data = waterfallData(
      model,
      [
        {
          comparison: model.comparisons[0],
          gamma: level.comparison_vector_value,
          level,
          matchWeight: matchWeight(level),
          tfAdjustment: 0,
        },
      ],
      { left: { name: "Ada" }, right: { name: "Ada" } },
      ["name"],
    );
    expect(data.map((record) => record.column_name)).toEqual(["Prior", "name", "Final score"]);
    expect(data[1]).toMatchObject({ value_l: "Ada", value_r: "Ada", record_number: 0 });

    const expected = structuredClone(waterfallTemplate) as unknown as MutableWaterfallSpec;
    expected.data.values = data;
    expected.params[0].bind.max = data.length - 1;
    expected.transform.splice(1, 0, { filter: "(datum.bayes_factor !== 1.0)" });
    expect(waterfallSpec(data)).toEqual(expected);
  });
});