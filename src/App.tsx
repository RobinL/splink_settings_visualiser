import {
  Activity,
  AlertCircle,
  Braces,
  Check,
  ChevronDown,
  ClipboardPaste,
  Database,
  Download,
  FileJson,
  Gauge,
  Info,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  matchWeightsSpec,
  muParametersSpec,
  waterfallData,
  waterfallSpec,
} from "./charts";
import {
  buildComparisonEvaluationSqls,
  buildBlockingRuleEvaluationSqls,
  buildEvaluationSql,
  buildFunctionEvaluationSqls,
  discoverColumns,
  discoverFunctionExpressions,
  evaluateExpression,
  evaluatePair,
  inferColumnTypes,
  serializeExampleData,
  substitutePairValues,
  valuesForColumnTypes,
} from "./duckdb";
import { examplePairValues } from "./heuristics";
import {
  chartData,
  editorStateFromExampleData,
  blockingRuleSql,
  finalMatchWeight,
  humanReadableDescription,
  matchWeight,
  parseModel,
} from "./model";
import type {
  ColumnKind,
  ColumnType,
  ComparisonResult,
  NormalizedModel,
  PairValues,
} from "./types";
import { VegaChart } from "./VegaChart";

type View = "overview" | "pair" | "model";
type Side = keyof PairValues;

const TYPE_OPTIONS: Array<{ value: ColumnKind; label: string }> = [
  { value: "VARCHAR", label: "Text" },
  { value: "DOUBLE", label: "Number" },
  { value: "BOOLEAN", label: "Boolean" },
  { value: "DATE", label: "Date" },
  { value: "TIMESTAMP", label: "Timestamp" },
  { value: "VARCHAR[]", label: "List of text" },
  { value: "DOUBLE[]", label: "List of numbers" },
  { value: "JSON", label: "JSON / dictionary" },
  { value: "CUSTOM", label: "Custom DuckDB type" },
];

const emptyValues: PairValues = { left: {}, right: {} };

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("The selected file could not be read."));
    reader.readAsText(file);
  });
}

function activatedLevelSql(condition: string, matchWeight: number | null): string {
  const weight = matchWeight === null ? "NULL" : matchWeight.toFixed(2);
  return /^\s*else\s*$/i.test(condition)
    ? `ELSE ${weight}`
    : `WHEN ${condition} THEN ${weight}`;
}

function pairValue(
  values: PairValues,
  side: Side,
  column: string,
): string | null {
  const value = values[side][column];
  return value === undefined ? "" : value;
}

function formatFunctionValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, (_, nested) =>
        typeof nested === "bigint" ? nested.toString() : nested,
      );
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface FunctionOutcome {
  expression: string;
  state: "loading" | "ready" | "error";
  value?: string;
}

interface BlockingRuleOutcome {
  rule: string;
  state: "loading" | "ready" | "error";
  activated?: boolean;
}

function InputEditor({
  column,
  type,
  value,
  onChange,
  compact = false,
}: {
  column: string;
  type: ColumnType;
  value: string | null;
  onChange: (value: string | null) => void;
  compact?: boolean;
}) {
  const nested = ["VARCHAR[]", "DOUBLE[]", "JSON", "CUSTOM"].includes(
    type.kind,
  );
  const inputType =
    type.kind === "DOUBLE"
      ? "number"
      : type.kind === "DATE"
        ? "date"
        : type.kind === "TIMESTAMP"
          ? "datetime-local"
          : "text";
  const placeholder =
    type.kind === "VARCHAR[]"
      ? '["alpha", "beta"]'
      : type.kind === "DOUBLE[]"
        ? "[10, 20]"
        : type.kind === "JSON" || type.kind === "CUSTOM"
          ? '{"key": "value"}'
          : column;
  return (
    <div className={`cell-editor ${compact ? "compact" : ""}`}>
      {type.kind === "BOOLEAN" ? (
        <select
          value={value ?? ""}
          disabled={value === null}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${column} value`}
        >
          <option value="">Choose…</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : nested ? (
        <textarea
          value={value ?? ""}
          disabled={value === null}
          rows={compact ? 1 : 2}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${column} value`}
        />
      ) : (
        <input
          type={inputType}
          value={value ?? ""}
          disabled={value === null}
          placeholder={placeholder}
          step={inputType === "number" ? "any" : undefined}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${column} value`}
        />
      )}
      <label className="null-toggle">
        <input
          type="checkbox"
          checked={value === null}
          onChange={(event) => onChange(event.target.checked ? null : "")}
        />
        <span>NULL</span>
      </label>
    </div>
  );
}

function PairTable({
  columns,
  columnTypes,
  values,
  tfAdjustmentColumns,
  tfAdjustments,
  onTypeChange,
  onCustomTypeChange,
  onValueChange,
  onTfAdjustmentChange,
  onSetAllNull,
}: {
  columns: string[];
  columnTypes: Record<string, ColumnType>;
  values: PairValues;
  tfAdjustmentColumns: string[];
  tfAdjustments: Record<string, number>;
  onTypeChange: (column: string, kind: ColumnKind) => void;
  onCustomTypeChange: (column: string, customType: string) => void;
  onValueChange: (side: Side, column: string, value: string | null) => void;
  onTfAdjustmentChange: (column: string, value: number) => void;
  onSetAllNull: () => void;
}) {
  return (
    <section className="content-band pair-table-editor">
      <div className="section-title">
        <div>
          <h2>Records</h2>
        </div>
        <button className="secondary-button null-all-button" onClick={onSetAllNull}>
          Set everything to NULL
        </button>
      </div>
      <div className="record-grid-wrap">
        <table className="record-grid pair-record-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Record L</th>
              <th>Record R</th>
              <th>Data type</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => {
              const type = columnTypes[column] ?? {
                kind: "VARCHAR" as const,
              };
              return (
                <tr key={column}>
                  <th>{column}</th>
                  {(["left", "right"] as Side[]).map((side) => (
                    <td key={side}>
                      <InputEditor
                        column={column}
                        type={type}
                        value={pairValue(values, side, column)}
                        onChange={(value) => onValueChange(side, column, value)}
                      />
                    </td>
                  ))}
                  <td>
                    <div className="type-select">
                      <select
                        aria-label={`${column} data type`}
                        value={type.kind}
                        onChange={(event) =>
                          onTypeChange(column, event.target.value as ColumnKind)
                        }
                      >
                        {TYPE_OPTIONS.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </div>
                    {type.kind === "CUSTOM" && (
                      <input
                        className="custom-type"
                        value={type.customType ?? ""}
                        onChange={(event) =>
                          onCustomTypeChange(column, event.target.value)
                        }
                        placeholder="STRUCT(city VARCHAR)"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tfAdjustmentColumns.length > 0 && (
        <div className="record-tf-adjustments">
          {tfAdjustmentColumns.map((column) => (
            <label className="tf-adjustment-slider" key={column}>
              <span>
                <span>
                  <code>{column}</code> term frequency adjustment (match weight)
                </span>
                <output>
                  {(tfAdjustments[column] ?? 1) >= 0 ? "+" : ""}
                  {(tfAdjustments[column] ?? 1).toFixed(1)}
                </output>
              </span>
              <input
                aria-label={`${column} term frequency adjustment`}
                type="range"
                min="-10"
                max="10"
                step="0.1"
                value={tfAdjustments[column] ?? 1}
                onChange={(event) =>
                  onTfAdjustmentChange(column, Number(event.target.value))
                }
              />
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

function PairPreview({ columns, values }: { columns: string[]; values: PairValues }) {
  return (
    <div className="pair-preview">
      <div className="record-grid-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {(["left", "right"] as Side[]).map((side) => (
              <tr aria-label={side === "left" ? "Record L" : "Record R"} key={side}>
                {columns.map((column) => (
                  <td key={column}>
                    <code>{pairValue(values, side, column) ?? "NULL"}</code>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Change the values in the form above to change this data</p>
    </div>
  );
}

function FunctionValues({
  outcomes,
  displayedExpressions,
}: {
  outcomes: FunctionOutcome[];
  displayedExpressions: Record<string, string>;
}) {
  if (outcomes.length === 0) return null;
  return (
    <div className="function-results comparison-functions">
      <h4>Function values</h4>
      <table>
        <tbody>
          {outcomes.map((outcome) => (
            <tr key={outcome.expression}>
              <th><code>{displayedExpressions[outcome.expression] ?? outcome.expression}</code></th>
              <td>
                {outcome.state === "loading"
                  ? "Evaluating…"
                  : outcome.state === "ready"
                    ? <output>{outcome.value}</output>
                    : <span className="function-unavailable">Unavailable for the selected data types</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({
  onModel,
}: {
  onModel: (model: NormalizedModel, raw: string, name: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [loadingExample, setLoadingExample] = useState<string>();

  const ingest = (raw: string, name: string) => {
    try {
      onModel(parseModel(JSON.parse(raw)), raw, name);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "That JSON is not a valid Splink model.",
      );
    }
  };
  const chooseFile = async (file?: File) => {
    if (!file) return;
    try {
      ingest(await readFile(file), file.name);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The selected file could not be read.",
      );
    }
  };
  const loadExample = async (name: string) => {
    setLoadingExample(name);
    setError(undefined);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${name}`);
      if (!response.ok) throw new Error(`The ${name} example could not be loaded.`);
      ingest(await response.text(), name);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `The ${name} example could not be loaded.`,
      );
    } finally {
      setLoadingExample(undefined);
    }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void chooseFile(event.dataTransfer.files[0]);
  };

  return (
    <main className="welcome-shell">
      <header className="welcome-brand">
        <Database size={24} />
        <span>Splink model visualiser</span>
      </header>
      <section className="welcome-content">
        <div className="welcome-copy">
          <p className="eyebrow">DuckDB model inspector</p>
          <h1>Splink model visualiser</h1>
          <p>
            See what your linkage model has learned. Inspect its parameters,
            test record pairs, and trace every contribution to the final match score.
          </p>
          <div className="privacy-note">
            <Check size={16} />
            <span>
              Everything runs in this browser tab. Your model is not uploaded.
            </span>
          </div>
        </div>
        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={drop}
        >
          <div className="file-mark">
            <FileJson size={30} />
          </div>
          <h2>Open a Splink model</h2>
          <p>
            Drop a <strong>model.json</strong> here, or choose how to load it.
          </p>
          <div className="load-actions primary-load-actions">
            <button
              className="primary-button"
              onClick={() => input.current?.click()}
            >
              <Upload size={17} />
              Choose JSON
            </button>
            <button
              className="secondary-button"
              onClick={() => setPasteOpen(true)}
            >
              <ClipboardPaste size={17} />
              Paste JSON
            </button>
          </div>
          <div className="load-actions example-load-actions">
            <button
              className="secondary-button"
              disabled={loadingExample !== undefined}
              onClick={() => void loadExample("splink_50k_historical.json")}
            >
              {loadingExample === "splink_50k_historical.json" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <FileJson size={17} />
              )}
              Load historical 50k example
            </button>
            <button
              className="secondary-button"
              disabled={loadingExample !== undefined}
              onClick={() => void loadExample("splink_fake_1000.json")}
            >
              {loadingExample === "splink_fake_1000.json" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <FileJson size={17} />
              )}
              Load fake 1,000 example
            </button>
            <button
              className="secondary-button"
              disabled={loadingExample !== undefined}
              onClick={() =>
                void loadExample("splink_fake_1000_with_example_data.json")
              }
            >
              {loadingExample === "splink_fake_1000_with_example_data.json" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <FileJson size={17} />
              )}
              Load fake 1,000 example with test data
            </button>
          </div>
          <input
            ref={input}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
          {error && (
            <div className="load-error">
              <AlertCircle size={16} />
              {error}
            </div>
          )}
        </div>
      </section>
      <footer className="welcome-footer">
        Compatible with serialized DuckDB settings from{" "}
        <code>linker.misc.save_model_to_json()</code>
      </footer>
      {pasteOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="paste-title"
          >
            <div className="modal-title">
              <div>
                <p className="eyebrow">Model source</p>
                <h2 id="paste-title">Paste model JSON</h2>
              </div>
              <button
                className="icon-button"
                title="Close"
                onClick={() => setPasteOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
            <textarea
              autoFocus
              value={pasteValue}
              onChange={(event) => setPasteValue(event.target.value)}
              placeholder={
                '{\n  "sql_dialect": "duckdb",\n  "comparisons": […]\n}'
              }
            />
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setPasteOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!pasteValue.trim()}
                onClick={() => ingest(pasteValue, "Pasted model")}
              >
                <Braces size={17} />
                Inspect model
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export function App() {
  const [model, setModel] = useState<NormalizedModel | null>(null);
  const [rawModel, setRawModel] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [view, setView] = useState<View>("overview");
  const [columns, setColumns] = useState<string[]>([]);
  const [columnTypes, setColumnTypes] = useState<Record<string, ColumnType>>(
    {},
  );
  const [values, setValues] = useState<PairValues>(emptyValues);
  const [gammas, setGammas] = useState<Array<number | null>>([]);
  const [comparisonErrors, setComparisonErrors] = useState<
    Record<number, string>
  >({});
  const [engineState, setEngineState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [engineError, setEngineError] = useState<string>();
  const [generatedSql, setGeneratedSql] = useState("");
  const [functionExpressions, setFunctionExpressions] = useState<string[][]>([]);
  const [functionOutcomes, setFunctionOutcomes] = useState<FunctionOutcome[][]>([]);
  const [showActualValues, setShowActualValues] = useState(false);
  const [displayedExpressions, setDisplayedExpressions] = useState<Record<string, string>>({});
  const [blockingRuleOutcomes, setBlockingRuleOutcomes] = useState<BlockingRuleOutcome[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [tfAdjustments, setTfAdjustments] = useState<Record<string, number>>({});

  const deferredValues = useDeferredValue(values);
  const deferredTypes = useDeferredValue(columnTypes);

  const loadModel = (nextModel: NormalizedModel, raw: string, name: string) => {
    setModel(nextModel);
    setRawModel(raw);
    setSourceName(name);
    setView("overview");
    setColumns([]);
    setColumnTypes({});
    setValues(emptyValues);
    setGammas([]);
    setComparisonErrors({});
    setEngineError(undefined);
    setFunctionExpressions([]);
    setFunctionOutcomes([]);
    setShowActualValues(false);
    setDisplayedExpressions({});
    setBlockingRuleOutcomes([]);
    setTfAdjustments(
      Object.fromEntries(
        nextModel.comparisons
          .filter((comparison) =>
            comparison.comparison_levels.some((level) => level.tf_adjustment_column),
          )
          .map((comparison) => [
            comparison.output_column_name,
            nextModel.example_data?.term_frequency_adjustments?.[
              comparison.output_column_name
            ] ?? 1,
          ]),
      ),
    );
  };

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    setEngineState("loading");
    discoverColumns(model)
      .then(async (discovered) => {
        const exampleValues = examplePairValues(discovered);
        const [expressions, inferredTypes] = await Promise.all([
          discoverFunctionExpressions(model),
          inferColumnTypes(model, discovered, exampleValues),
        ]);
        return { discovered, exampleValues, expressions, inferredTypes };
      })
      .then(({ discovered, exampleValues, expressions, inferredTypes }) => {
        if (cancelled) return;
        const compatibleValues = valuesForColumnTypes(
          exampleValues,
          inferredTypes,
        );
        const initialState = editorStateFromExampleData(
          model.example_data,
          discovered,
          inferredTypes,
          compatibleValues,
        );
        setColumns(discovered);
        setFunctionExpressions(expressions);
        setColumnTypes(initialState.columnTypes);
        setValues(initialState.values);
        setEngineState("ready");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setEngineState("error");
        setEngineError(
          reason instanceof Error
            ? reason.message
            : "DuckDB could not inspect this model.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [model]);

  useEffect(() => {
    if (!model || engineState !== "ready" || columns.length === 0) return;
    let cancelled = false;
    serializeExampleData(columns, deferredTypes, deferredValues)
      .then((exampleData) => {
        if (cancelled) return;
        setRawModel((current) => {
          const settings = JSON.parse(current) as Record<string, unknown>;
          settings.example_data = {
            ...exampleData,
            term_frequency_adjustments: tfAdjustments,
          };
          return JSON.stringify(settings, null, 2);
        });
      })
      .catch(() => {
        // Keep the last valid example_data while the user is editing an invalid value.
      });
    return () => {
      cancelled = true;
    };
  }, [
    model,
    engineState,
    columns,
    deferredTypes,
    deferredValues,
    tfAdjustments,
  ]);

  const blockingRules = useMemo(
    () => (model ? blockingRuleSql(model) : []),
    [model],
  );

  useEffect(() => {
    if (!model || engineState !== "ready" || columns.length === 0) return;
    if (blockingRules.length === 0) {
      setBlockingRuleOutcomes([]);
      return;
    }
    let cancelled = false;
    try {
      const statements = buildBlockingRuleEvaluationSqls(
        blockingRules,
        columns,
        deferredTypes,
        deferredValues,
      );
      setBlockingRuleOutcomes(
        blockingRules.map((rule) => ({ rule, state: "loading" })),
      );
      Promise.all(
        statements.map(async (statement, index) => {
          try {
            return {
              rule: blockingRules[index],
              state: "ready" as const,
              activated: Boolean(await evaluateExpression(statement)),
            };
          } catch {
            return {
              rule: blockingRules[index],
              state: "error" as const,
            };
          }
        }),
      ).then((outcomes) => {
        if (!cancelled) setBlockingRuleOutcomes(outcomes);
      });
    } catch {
      setBlockingRuleOutcomes(
        blockingRules.map((rule) => ({ rule, state: "error" })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [model, engineState, columns, blockingRules, deferredTypes, deferredValues]);

  useEffect(() => {
    if (!model || engineState !== "ready" || columns.length === 0) return;
    let cancelled = false;
    try {
      const sql = buildEvaluationSql(
        model,
        columns,
        deferredTypes,
        deferredValues,
      );
      setGeneratedSql(sql);
      const comparisonSql = buildComparisonEvaluationSqls(
        model,
        columns,
        deferredTypes,
        deferredValues,
      );
      const queuedFunctions = functionExpressions.flatMap(
        (expressions, comparisonIndex) =>
          expressions.map((expression) => ({ comparisonIndex, expression })),
      );
      const functionSql = buildFunctionEvaluationSqls(
        queuedFunctions.map(({ expression }) => expression),
        columns,
        deferredTypes,
        deferredValues,
      );
      setGammas(model.comparisons.map(() => null));
      setComparisonErrors({});
      setEngineError(undefined);
      setFunctionOutcomes(
        functionExpressions.map((expressions) =>
          expressions.map((expression) => ({ expression, state: "loading" })),
        ),
      );
      Promise.all(
        comparisonSql.map(async (statement) => {
          try {
            const [gamma] = await evaluatePair(statement);
            return { gamma, error: null };
          } catch (reason) {
            return {
              gamma: null,
              error:
                reason instanceof Error
                  ? reason.message
                  : "The comparison SQL failed.",
            };
          }
        }),
      ).then((outcomes) => {
        if (cancelled) return;
        setGammas(outcomes.map((outcome) => outcome.gamma));
        setComparisonErrors(
          Object.fromEntries(
            outcomes.flatMap((outcome, index) =>
              outcome.error === null ? [] : [[index, outcome.error]],
            ),
          ),
        );
      });
      Promise.all(
        functionSql.map(async (statement, index) => {
          const queued = queuedFunctions[index];
          try {
            return {
              comparisonIndex: queued.comparisonIndex,
              outcome: {
                expression: queued.expression,
                state: "ready" as const,
                value: formatFunctionValue(await evaluateExpression(statement)),
              },
            };
          } catch {
            return {
              comparisonIndex: queued.comparisonIndex,
              outcome: {
                expression: queued.expression,
                state: "error" as const,
              },
            };
          }
        }),
      ).then((outcomes) => {
        if (cancelled) return;
        setFunctionOutcomes(
          model.comparisons.map((_, comparisonIndex) =>
            outcomes
              .filter((item) => item.comparisonIndex === comparisonIndex)
              .map((item) => item.outcome),
          ),
        );
      });
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "A typed value is invalid.";
      setGammas(model.comparisons.map(() => null));
      setComparisonErrors(
        Object.fromEntries(
          model.comparisons.map((_, index) => [index, message]),
        ),
      );
      setEngineError(message);
      setFunctionOutcomes(
        functionExpressions.map((expressions) =>
          expressions.map((expression) => ({ expression, state: "error" })),
        ),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [
    model,
    columns,
    deferredTypes,
    deferredValues,
    engineState,
    functionExpressions,
  ]);

  const results = useMemo<Array<ComparisonResult | null>>(() => {
    if (!model || gammas.length !== model.comparisons.length) return [];
    return model.comparisons.map((comparison, index) => {
      const gamma = gammas[index];
      if (gamma === null) return null;
      const level =
        comparison.comparison_levels.find(
          (candidate) => candidate.comparison_vector_value === gamma,
        ) ?? comparison.comparison_levels.at(-1)!;
      return {
        comparison,
        gamma,
        level,
        matchWeight: matchWeight(level),
        tfAdjustment: level.tf_adjustment_column
          ? (tfAdjustments[comparison.output_column_name] ?? 1)
          : 0,
      };
    });
  }, [model, gammas, tfAdjustments]);

  useEffect(() => {
    if (!showActualValues) {
      setDisplayedExpressions({});
      return;
    }
    const expressions = [
      ...results.flatMap((result) => (result ? [result.level.sql_condition] : [])),
      ...functionOutcomes.flatMap((outcomes) =>
        outcomes.map((outcome) => outcome.expression),
      ),
    ];
    const uniqueExpressions = [...new Set(expressions)];
    let cancelled = false;
    setDisplayedExpressions({});
    substitutePairValues(uniqueExpressions, deferredTypes, deferredValues)
      .then((substituted) => {
        if (!cancelled) {
          setDisplayedExpressions(
            Object.fromEntries(
              uniqueExpressions.map((expression, index) => [
                expression,
                substituted[index],
              ]),
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setDisplayedExpressions({});
      });
    return () => {
      cancelled = true;
    };
  }, [showActualValues, results, functionOutcomes, deferredTypes, deferredValues]);

  const successfulResults = useMemo(
    () =>
      results.filter((result): result is ComparisonResult => result !== null),
    [results],
  );
  const hasCompleteResults =
    model != null &&
    successfulResults.length === (model?.comparisons.length ?? -1) &&
    Object.keys(comparisonErrors).length === 0;

  const parameterData = useMemo(() => (model ? chartData(model) : []), [model]);
  const matchWeightsChart = useMemo(
    () => matchWeightsSpec(parameterData),
    [parameterData],
  );
  const muChart = useMemo(
    () => muParametersSpec(parameterData),
    [parameterData],
  );
  const waterfallRows = useMemo(
    () =>
      hasCompleteResults && model
        ? waterfallData(model, successfulResults, deferredValues, columns)
        : [],
    [model, successfulResults, deferredValues, columns, hasCompleteResults],
  );
  const waterfallChart = useMemo(
    () => waterfallSpec(waterfallRows),
    [waterfallRows],
  );

  if (!model) return <EmptyState onModel={loadModel} />;

  const finalWeight = hasCompleteResults
    ? finalMatchWeight(model, successfulResults)
    : null;
  const comparisonLevelData = parameterData.filter(
    (datum) => datum.comparison_name !== "probability_two_random_records_match",
  );
  const trainedLevels = comparisonLevelData.filter(
    (datum) => datum.m_probability !== null && datum.u_probability !== null,
  ).length;
  const totalLevels = comparisonLevelData.length;

  const updateValue = (side: Side, column: string, value: string | null) => {
    setValues((current) => ({
      ...current,
      [side]: { ...current[side], [column]: value },
    }));
  };
  const updateType = (column: string, kind: ColumnKind) => {
    setColumnTypes((current) => ({
      ...current,
      [column]: {
        kind,
        customType: kind === "CUSTOM" ? "STRUCT(key VARCHAR)" : undefined,
      },
    }));
  };
  const setEverythingNull = () => {
    const nullValues = Object.fromEntries(columns.map((column) => [column, null]));
    setValues({ left: { ...nullValues }, right: { ...nullValues } });
  };
  const downloadSettings = async () => {
    setDownloading(true);
    try {
      const exampleData = await serializeExampleData(columns, columnTypes, values);
      const settings = JSON.parse(rawModel) as Record<string, unknown>;
      settings.example_data = {
        ...exampleData,
        term_frequency_adjustments: tfAdjustments,
      };
      const serialized = JSON.stringify(settings, null, 2);
      setRawModel(serialized);
      const url = URL.createObjectURL(
        new Blob([serialized], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = sourceName.endsWith(".json")
        ? sourceName
        : "splink_model_with_example_data.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      setEngineError(
        reason instanceof Error
          ? reason.message
          : "The settings could not be downloaded.",
      );
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Database size={21} />
          <span>Splink model visualiser</span>
        </div>
        <div className="model-source">
          <FileJson size={15} />
          <span>{sourceName}</span>
          <span className="duckdb-badge">DuckDB</span>
        </div>
        <button
          className="secondary-button small"
          disabled={downloading || engineState !== "ready"}
          onClick={() => void downloadSettings()}
        >
          {downloading ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Download size={15} />
          )}
          <span>Download settings with this test data</span>
        </button>
        <button
          className="secondary-button small"
          onClick={() => setModel(null)}
        >
          <RefreshCw size={15} />
          Replace model
        </button>
      </header>
      <nav className="view-tabs" aria-label="Dashboard views">
        <button
          className={view === "overview" ? "active" : ""}
          onClick={() => setView("overview")}
        >
          <Activity size={17} />
          Model overview
        </button>
        <button
          className={view === "pair" ? "active" : ""}
          onClick={() => setView("pair")}
        >
          <SlidersHorizontal size={17} />
          Pair lab
        </button>
        <button
          className={view === "model" ? "active" : ""}
          onClick={() => setView("model")}
        >
          <Braces size={17} />
          Model JSON
        </button>
        <div className={`engine-status ${engineState}`}>
          {engineState === "loading" ? (
            <LoaderCircle size={14} className="spin" />
          ) : engineState === "ready" ? (
            <Check size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
          DuckDB{" "}
          {engineState === "ready"
            ? "ready"
            : engineState === "loading"
              ? "starting"
              : engineState}
        </div>
      </nav>

      {
        <main className="dashboard-main overview-main">
          <section className="page-heading">
            <div>
              <p className="eyebrow">Model overview</p>
              <h1>
                {model.comparisons.length} comparisons, one trained decision
                system
              </h1>
              <p>
                Inspect parameter balance and the evidence each level adds to a
                pairwise score.
              </p>
            </div>
          </section>
          <section className="metric-row" aria-label="Model summary">
            <article>
              <span>Comparisons</span>
              <strong>{model.comparisons.length}</strong>
              <small>{columns.length || "…"} input columns</small>
            </article>
            <article>
              <span>Trained levels</span>
              <strong>
                {trainedLevels}
                <em> / {totalLevels}</em>
              </strong>
              <small>
                {trainedLevels === totalLevels
                  ? "All parameterized"
                  : "Some values missing"}
              </small>
            </article>
            <article>
              <span>Prior match chance</span>
              <strong>
                {(model.probability_two_random_records_match * 100).toPrecision(
                  3,
                )}
                %
              </strong>
              <small>Before comparison evidence</small>
            </article>
            <article>
              <span>Link type</span>
              <strong className="text-metric">
                {model.link_type.replaceAll("_", " ")}
              </strong>
              <small>Serialized setting</small>
            </article>
          </section>
          <section className="content-band model-summary">
            <div className="section-title">
              <div>
                <p className="eyebrow">Plain-language structure</p>
                <h2>How this model compares records</h2>
              </div>
              <Info size={18} />
            </div>
            <pre>{humanReadableDescription(model)}</pre>
          </section>
          <section className="content-band">
            <div className="section-title">
              <div>
                <p className="eyebrow">Evidence strength</p>
                <h2>Match weights</h2>
                <p>
                  Positive levels support a match; negative levels count against
                  it.
                </p>
              </div>
              <Gauge size={20} />
            </div>
            <VegaChart
              spec={matchWeightsChart}
              label="Match weights by comparison level"
            />
          </section>
          <section className="content-band">
            <div className="section-title">
              <div>
                <p className="eyebrow">Parameter balance</p>
                <h2>m and u probabilities</h2>
                <p>
                  Compare how often each level appears among matches and
                  non-matches.
                </p>
              </div>
              <Activity size={20} />
            </div>
            <VegaChart
              spec={muChart}
              label="M and U parameters by comparison level"
            />
          </section>
        </main>
      }

      {
        <main className="dashboard-main pair-main">
          {engineError && (
            <div className="evaluation-error">
              <AlertCircle size={18} />
              <div>
                <strong>Pair could not be evaluated</strong>
                <span>{engineError}</span>
              </div>
            </div>
          )}
          {engineState === "loading" ? (
            <div className="loading-row">
              <LoaderCircle className="spin" size={20} />
              Discovering columns from the model SQL…
            </div>
          ) : (
            <PairTable
              columns={columns}
              columnTypes={columnTypes}
              values={values}
              tfAdjustmentColumns={model.comparisons
                .filter((comparison) =>
                  comparison.comparison_levels.some(
                    (level) => level.tf_adjustment_column,
                  ),
                )
                .map((comparison) => comparison.output_column_name)}
              tfAdjustments={tfAdjustments}
              onTypeChange={updateType}
              onCustomTypeChange={(column, customType) =>
                setColumnTypes((current) => ({
                  ...current,
                  [column]: { ...current[column], customType },
                }))
              }
              onValueChange={updateValue}
              onTfAdjustmentChange={(column, value) =>
                setTfAdjustments((current) => ({
                  ...current,
                  [column]: value,
                }))
              }
              onSetAllNull={setEverythingNull}
            />
          )}
          {finalWeight !== null && (
            <section className="content-band">
              <div className="section-title">
                <div>
                  <p className="eyebrow">Score composition</p>
                  <h2>Waterfall</h2>
                  <p>
                    Each step shows how a comparison changes the cumulative
                    score.
                  </p>
                </div>
                <Gauge size={20} />
              </div>
              <VegaChart
                spec={waterfallChart}
                label="Waterfall of pair match-weight contributions"
              />
            </section>
          )}
          <section className="comparison-section">
            <div className="section-title">
              <div>
                <p className="eyebrow">Level evaluator</p>
                <h2>Comparison outcomes</h2>
                <p className="outcomes-note">Read-only results. Edit values and data types in Records above.</p>
              </div>
              <div className="expression-mode" role="group" aria-label="SQL expression display">
                <button
                  className={!showActualValues ? "active" : ""}
                  aria-pressed={!showActualValues}
                  onClick={() => setShowActualValues(false)}
                >
                  Column names
                </button>
                <button
                  className={showActualValues ? "active" : ""}
                  aria-pressed={showActualValues}
                  onClick={() => setShowActualValues(true)}
                >
                  Actual values
                </button>
              </div>
            </div>
            <PairPreview columns={columns} values={deferredValues} />
            <div className="comparison-list">
              {model.comparisons.map((comparison, index) => {
                const result = results[index];
                return (
                  <details
                    className="comparison-widget"
                    key={`${comparison.output_column_name}-${index}`}
                  >
                    <summary className="comparison-head">
                      <div>
                        <h3>{comparison.output_column_name}</h3>
                        <span className="comparison-expand-hint">
                          (<span className="expand-label">click to expand</span>
                          <span className="collapse-label">click to collapse</span>)
                          <ChevronDown size={17} />
                        </span>
                      </div>
                    </summary>
                    <div className="comparison-content">
                      <div className="activated-level">
                        <h4>Activated comparison level</h4>
                        {result ? (
                          <div
                            className={`level-result ${(result.matchWeight ?? 0) >= 0 ? "positive" : "negative"}`}
                          >
                            <code className="selected-level-sql">
                              {activatedLevelSql(
                                displayedExpressions[result.level.sql_condition] ??
                                  result.level.sql_condition,
                                result.matchWeight,
                              )}
                            </code>
                          </div>
                        ) : (
                          <div className="level-result pending">
                            <LoaderCircle className="spin" size={15} />
                            Evaluating
                          </div>
                        )}
                      </div>
                      <FunctionValues
                        outcomes={functionOutcomes[index] ?? []}
                        displayedExpressions={displayedExpressions}
                      />
                      <section className="level-details">
                        <h4>Comparison levels</h4>
                        <div>
                          {comparison.comparison_levels.map((level) => (
                            <div
                              className={
                                result?.gamma === level.comparison_vector_value
                                  ? "selected"
                                  : ""
                              }
                              key={`${level.comparison_vector_value}-${level.sql_condition}`}
                            >
                              <span>
                                {result?.gamma ===
                                  level.comparison_vector_value && (
                                  <Check size={14} />
                                )}
                                {level.label_for_charts}
                              </span>
                              <code>{level.sql_condition}</code>
                              <strong>γ {level.comparison_vector_value}</strong>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
          {blockingRules.length > 0 && (
            <section className="blocking-rules-section">
              <div className="section-title">
                <div>
                  <h2>Blocking rule hits</h2>
                </div>
              </div>
              <div className="blocking-rule-list">
                {blockingRuleOutcomes.map((outcome, index) => (
                  <div className="blocking-rule-row" key={`${index}-${outcome.rule}`}>
                    <code>{outcome.rule}</code>
                    <span className={`blocking-rule-status ${outcome.state === "ready" && outcome.activated ? "activated" : ""}`}>
                      {outcome.state === "loading"
                        ? "Evaluating"
                        : outcome.state === "error"
                          ? "Unavailable"
                          : outcome.activated
                            ? "Activated"
                            : "Not activated"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {generatedSql && (
            <details className="sql-panel">
              <summary>
                <span>
                  <Database size={16} />
                  Generated DuckDB query
                </span>
                <ChevronDown size={16} />
              </summary>
              <pre>{generatedSql}</pre>
            </details>
          )}
        </main>
      }

      {
        <main className="dashboard-main model-main">
          <details className="comparison-widget settings-disclosure">
            <summary className="comparison-head">
              <div>
                <h2>Settings</h2>
                <span className="comparison-expand-hint">
                  (<span className="expand-label">click to expand</span>
                  <span className="collapse-label">click to collapse</span>)
                  <ChevronDown size={17} />
                </span>
              </div>
            </summary>
            <div className="comparison-content">
              <section className="json-view">
                <pre>{JSON.stringify(JSON.parse(rawModel), null, 2)}</pre>
              </section>
            </div>
          </details>
        </main>
      }
    </div>
  );
}
