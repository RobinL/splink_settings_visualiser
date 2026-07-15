import {
  Activity,
  AlertCircle,
  Braces,
  Check,
  ChevronDown,
  ClipboardPaste,
  Database,
  FileJson,
  Gauge,
  Info,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  TableProperties,
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
import { matchWeightsSpec, muParametersSpec, waterfallData, waterfallSpec } from "./charts";
import {
  buildComparisonEvaluationSqls,
  buildEvaluationSql,
  discoverColumns,
  evaluatePair,
} from "./duckdb";
import {
  chartData,
  finalMatchWeight,
  humanReadableDescription,
  matchProbability,
  matchWeight,
  parseModel,
  termFrequencyAdjustment,
} from "./model";
import type {
  ColumnKind,
  ColumnType,
  ComparisonResult,
  NormalizedComparison,
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
    reader.onerror = () => reject(new Error("The selected file could not be read."));
    reader.readAsText(file);
  });
}

function parseFrequency(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatWeight(value: number | null): string {
  if (value === null) return "Not trained";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
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
  const nested = ["VARCHAR[]", "DOUBLE[]", "JSON", "CUSTOM"].includes(type.kind);
  const inputType = type.kind === "DOUBLE" ? "number" : type.kind === "DATE" ? "date" : type.kind === "TIMESTAMP" ? "datetime-local" : "text";
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
        <select value={value ?? ""} disabled={value === null} onChange={(event) => onChange(event.target.value)} aria-label={`${column} value`}>
          <option value="">Choose…</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : nested ? (
        <textarea value={value ?? ""} disabled={value === null} rows={compact ? 1 : 2} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} aria-label={`${column} value`} />
      ) : (
        <input type={inputType} value={value ?? ""} disabled={value === null} placeholder={placeholder} step={inputType === "number" ? "any" : undefined} onChange={(event) => onChange(event.target.value)} aria-label={`${column} value`} />
      )}
      <label className="null-toggle">
        <input type="checkbox" checked={value === null} onChange={(event) => onChange(event.target.checked ? null : "")} />
        <span>NULL</span>
      </label>
    </div>
  );
}

function EmptyState({ onModel }: { onModel: (model: NormalizedModel, raw: string, name: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);

  const ingest = (raw: string, name: string) => {
    try {
      onModel(parseModel(JSON.parse(raw)), raw, name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That JSON is not a valid Splink model.");
    }
  };
  const chooseFile = async (file?: File) => {
    if (!file) return;
    try {
      ingest(await readFile(file), file.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The selected file could not be read.");
    }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void chooseFile(event.dataTransfer.files[0]);
  };

  return (
    <main className="welcome-shell">
      <header className="welcome-brand"><Database size={24} /><span>Splink Model Studio</span></header>
      <section className="welcome-content">
        <div className="welcome-copy">
          <p className="eyebrow">DuckDB model inspector</p>
          <h1>See what your linkage model has learned.</h1>
          <p>Load a serialized Splink model to inspect its parameters, test record pairs, and trace every contribution to the final match score.</p>
          <div className="privacy-note"><Check size={16} /><span>Everything runs in this browser tab. Your model is not uploaded.</span></div>
        </div>
        <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
          <div className="file-mark"><FileJson size={30} /></div>
          <h2>Open a Splink model</h2>
          <p>Drop a <strong>model.json</strong> here, or choose how to load it.</p>
          <div className="load-actions">
            <button className="primary-button" onClick={() => input.current?.click()}><Upload size={17} />Choose JSON</button>
            <button className="secondary-button" onClick={() => setPasteOpen(true)}><ClipboardPaste size={17} />Paste JSON</button>
          </div>
          <input ref={input} hidden type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event.target.files?.[0])} />
          {error && <div className="load-error"><AlertCircle size={16} />{error}</div>}
        </div>
      </section>
      <footer className="welcome-footer">Compatible with serialized DuckDB settings from <code>linker.misc.save_model_to_json()</code></footer>
      {pasteOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="paste-title">
            <div className="modal-title"><div><p className="eyebrow">Model source</p><h2 id="paste-title">Paste model JSON</h2></div><button className="icon-button" title="Close" onClick={() => setPasteOpen(false)}><X size={19} /></button></div>
            <textarea autoFocus value={pasteValue} onChange={(event) => setPasteValue(event.target.value)} placeholder={'{\n  "sql_dialect": "duckdb",\n  "comparisons": […]\n}'} />
            <div className="modal-actions"><button className="secondary-button" onClick={() => setPasteOpen(false)}>Cancel</button><button className="primary-button" disabled={!pasteValue.trim()} onClick={() => ingest(pasteValue, "Pasted model")}><Braces size={17} />Inspect model</button></div>
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
  const [columnTypes, setColumnTypes] = useState<Record<string, ColumnType>>({});
  const [values, setValues] = useState<PairValues>(emptyValues);
  const [tfValues, setTfValues] = useState<Record<number, { left: string; right: string }>>({});
  const [gammas, setGammas] = useState<Array<number | null>>([]);
  const [comparisonErrors, setComparisonErrors] = useState<Record<number, string>>({});
  const [engineState, setEngineState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [engineError, setEngineError] = useState<string>();
  const [generatedSql, setGeneratedSql] = useState("");

  const deferredValues = useDeferredValue(values);
  const deferredTypes = useDeferredValue(columnTypes);
  const deferredTfValues = useDeferredValue(tfValues);

  const loadModel = (nextModel: NormalizedModel, raw: string, name: string) => {
    setModel(nextModel);
    setRawModel(raw);
    setSourceName(name);
    setView("overview");
    setColumns([]);
    setColumnTypes({});
    setValues(emptyValues);
    setTfValues({});
    setGammas([]);
    setComparisonErrors({});
    setEngineError(undefined);
  };

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    setEngineState("loading");
    discoverColumns(model)
      .then((discovered) => {
        if (cancelled) return;
        setColumns(discovered);
        setColumnTypes(Object.fromEntries(discovered.map((column) => [column, { kind: "VARCHAR" }])));
        setValues({
          left: Object.fromEntries(discovered.map((column) => [column, ""])),
          right: Object.fromEntries(discovered.map((column) => [column, ""])),
        });
        setEngineState("ready");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setEngineState("error");
        setEngineError(reason instanceof Error ? reason.message : "DuckDB could not inspect this model.");
      });
    return () => {
      cancelled = true;
    };
  }, [model]);

  useEffect(() => {
    if (!model || engineState !== "ready" || columns.length === 0) return;
    let cancelled = false;
    try {
      const sql = buildEvaluationSql(model, columns, deferredTypes, deferredValues);
      setGeneratedSql(sql);
      const comparisonSql = buildComparisonEvaluationSqls(
        model,
        columns,
        deferredTypes,
        deferredValues,
      );
      setGammas(model.comparisons.map(() => null));
      setComparisonErrors({});
      setEngineError(undefined);
      Promise.all(
        comparisonSql.map(async (statement) => {
          try {
            const [gamma] = await evaluatePair(statement);
            return { gamma, error: null };
          } catch (reason) {
            return {
              gamma: null,
              error: reason instanceof Error ? reason.message : "The comparison SQL failed.",
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
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "A typed value is invalid.";
      setGammas(model.comparisons.map(() => null));
      setComparisonErrors(
        Object.fromEntries(model.comparisons.map((_, index) => [index, message])),
      );
      setEngineError(message);
    }
    return () => {
      cancelled = true;
    };
  }, [model, columns, deferredTypes, deferredValues, engineState]);

  const results = useMemo<Array<ComparisonResult | null>>(() => {
    if (!model || gammas.length !== model.comparisons.length) return [];
    return model.comparisons.map((comparison, index) => {
      const gamma = gammas[index];
      if (gamma === null) return null;
      const level = comparison.comparison_levels.find((candidate) => candidate.comparison_vector_value === gamma) ?? comparison.comparison_levels.at(-1)!;
      const frequencies = deferredTfValues[index];
      return {
        comparison,
        gamma,
        level,
        matchWeight: matchWeight(level),
        tfAdjustment: termFrequencyAdjustment(comparison, level, parseFrequency(frequencies?.left), parseFrequency(frequencies?.right)),
      };
    });
  }, [model, gammas, deferredTfValues]);

  const successfulResults = useMemo(
    () => results.filter((result): result is ComparisonResult => result !== null),
    [results],
  );
  const hasCompleteResults =
    model != null &&
    successfulResults.length === (model?.comparisons.length ?? -1) &&
    Object.keys(comparisonErrors).length === 0;

  const parameterData = useMemo(() => (model ? chartData(model) : []), [model]);
  const matchWeightsChart = useMemo(() => matchWeightsSpec(parameterData), [parameterData]);
  const muChart = useMemo(() => muParametersSpec(parameterData), [parameterData]);
  const waterfallRows = useMemo(
    () =>
      hasCompleteResults && model
        ? waterfallData(model, successfulResults, deferredValues, columns)
        : [],
    [model, successfulResults, deferredValues, columns, hasCompleteResults],
  );
  const waterfallChart = useMemo(() => waterfallSpec(waterfallRows), [waterfallRows]);

  if (!model) return <EmptyState onModel={loadModel} />;

  const finalWeight = hasCompleteResults ? finalMatchWeight(model, successfulResults) : null;
  const comparisonLevelData = parameterData.filter(
    (datum) => datum.comparison_name !== "probability_two_random_records_match",
  );
  const trainedLevels = comparisonLevelData.filter(
    (datum) => datum.m_probability !== null && datum.u_probability !== null,
  ).length;
  const totalLevels = comparisonLevelData.length;

  const updateValue = (side: Side, column: string, value: string | null) => {
    setValues((current) => ({ ...current, [side]: { ...current[side], [column]: value } }));
  };
  const updateType = (column: string, kind: ColumnKind) => {
    setColumnTypes((current) => ({ ...current, [column]: { kind, customType: kind === "CUSTOM" ? "STRUCT(key VARCHAR)" : undefined } }));
  };
  const comparisonColumns = (comparison: NormalizedComparison): string[] => {
    const sql = comparison.comparison_levels.map((level) => level.sql_condition).join(" ").replaceAll('"', "").toLowerCase();
    return columns.filter((column) => sql.includes(`${column.toLowerCase()}_l`) || comparison.comparison_levels.some((level) => level.tf_adjustment_column === column));
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><Database size={21} /><span>Splink Model Studio</span></div>
        <div className="model-source"><FileJson size={15} /><span>{sourceName}</span><span className="duckdb-badge">DuckDB</span></div>
        <button className="secondary-button small" onClick={() => setModel(null)}><RefreshCw size={15} />Replace model</button>
      </header>
      <nav className="view-tabs" aria-label="Dashboard views">
        <button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}><Activity size={17} />Model overview</button>
        <button className={view === "pair" ? "active" : ""} onClick={() => setView("pair")}><SlidersHorizontal size={17} />Pair lab</button>
        <button className={view === "model" ? "active" : ""} onClick={() => setView("model")}><Braces size={17} />Model JSON</button>
        <div className={`engine-status ${engineState}`}>
          {engineState === "loading" ? <LoaderCircle size={14} className="spin" /> : engineState === "ready" ? <Check size={14} /> : <AlertCircle size={14} />}
          DuckDB {engineState === "ready" ? "ready" : engineState === "loading" ? "starting" : engineState}
        </div>
      </nav>

      {(
        <main className="dashboard-main overview-main">
          <section className="page-heading"><div><p className="eyebrow">Model overview</p><h1>{model.comparisons.length} comparisons, one trained decision system</h1><p>Inspect parameter balance and the evidence each level adds to a pairwise score.</p></div></section>
          <section className="metric-row" aria-label="Model summary">
            <article><span>Comparisons</span><strong>{model.comparisons.length}</strong><small>{columns.length || "…"} input columns</small></article>
            <article><span>Trained levels</span><strong>{trainedLevels}<em> / {totalLevels}</em></strong><small>{trainedLevels === totalLevels ? "All parameterized" : "Some values missing"}</small></article>
            <article><span>Prior match chance</span><strong>{(model.probability_two_random_records_match * 100).toPrecision(3)}%</strong><small>Before comparison evidence</small></article>
            <article><span>Link type</span><strong className="text-metric">{model.link_type.replaceAll("_", " ")}</strong><small>Serialized setting</small></article>
          </section>
          <section className="content-band model-summary"><div className="section-title"><div><p className="eyebrow">Plain-language structure</p><h2>How this model compares records</h2></div><Info size={18} /></div><pre>{humanReadableDescription(model)}</pre></section>
          <section className="content-band"><div className="section-title"><div><p className="eyebrow">Evidence strength</p><h2>Match weights</h2><p>Positive levels support a match; negative levels count against it.</p></div><Gauge size={20} /></div><VegaChart spec={matchWeightsChart} label="Match weights by comparison level" /></section>
          <section className="content-band"><div className="section-title"><div><p className="eyebrow">Parameter balance</p><h2>m and u probabilities</h2><p>Compare how often each level appears among matches and non-matches.</p></div><Activity size={20} /></div><VegaChart spec={muChart} label="M and U parameters by comparison level" /></section>
        </main>
      )}

      {(
        <main className="dashboard-main pair-main">
          <section className="page-heading pair-heading"><div><p className="eyebrow">Interactive scoring</p><h1>Pair lab</h1><p>Edit two synthetic records. DuckDB evaluates the model SQL locally as you type.</p></div>{finalWeight !== null && <div className="score-readout"><span>Final match weight</span><strong>{formatWeight(finalWeight)}</strong><small>{matchProbability(finalWeight).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 3 })} match probability</small></div>}</section>
          {engineError && <div className="evaluation-error"><AlertCircle size={18} /><div><strong>Pair could not be evaluated</strong><span>{engineError}</span></div></div>}
          <section className="content-band record-editor"><div className="section-title"><div><p className="eyebrow">Input records</p><h2>Values and data types</h2><p>Columns default to text. Choose a DuckDB type before entering dates, numbers, lists, or nested data.</p></div><TableProperties size={20} /></div>
            {engineState === "loading" ? <div className="loading-row"><LoaderCircle className="spin" size={20} />Discovering columns from the model SQL…</div> : (
              <div className="record-grid-wrap"><table className="record-grid"><thead><tr><th>Column</th><th>DuckDB type</th><th>Record L</th><th>Record R</th></tr></thead><tbody>{columns.map((column) => { const type = columnTypes[column] ?? { kind: "VARCHAR" as const }; return <tr key={column}><th>{column}</th><td><div className="type-select"><select value={type.kind} onChange={(event) => updateType(column, event.target.value as ColumnKind)}>{TYPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><ChevronDown size={14} /></div>{type.kind === "CUSTOM" && <input className="custom-type" value={type.customType ?? ""} onChange={(event) => setColumnTypes((current) => ({ ...current, [column]: { ...type, customType: event.target.value } }))} placeholder="STRUCT(city VARCHAR)" />}</td><td><InputEditor column={column} type={type} value={values.left[column] ?? ""} onChange={(value) => updateValue("left", column, value)} /></td><td><InputEditor column={column} type={type} value={values.right[column] ?? ""} onChange={(value) => updateValue("right", column, value)} /></td></tr>; })}</tbody></table></div>
            )}
          </section>
          {finalWeight !== null && <section className="content-band"><div className="section-title"><div><p className="eyebrow">Score composition</p><h2>Waterfall</h2><p>Each step shows how a comparison changes the cumulative score.</p></div><Gauge size={20} /></div><VegaChart spec={waterfallChart} label="Waterfall of pair match-weight contributions" /></section>}
          <section className="comparison-section"><div className="section-title"><div><p className="eyebrow">Level evaluator</p><h2>Comparison outcomes</h2><p>Each widget reuses the values above, so edits here update the whole pair.</p></div></div><div className="comparison-list">{model.comparisons.map((comparison, index) => { const result = results[index]; const usedColumns = comparisonColumns(comparison); const hasTf = comparison.comparison_levels.some((level) => level.tf_adjustment_column); return <article className="comparison-widget" key={`${comparison.output_column_name}-${index}`}><div className="comparison-head"><div><span className="comparison-number">{String(index + 1).padStart(2, "0")}</span><h3>{comparison.output_column_name}</h3></div>{result ? <div className={`level-result ${(result.matchWeight ?? 0) >= 0 ? "positive" : "negative"}`}><span>{result.level.label_for_charts}</span><strong>{formatWeight(result.matchWeight)}</strong></div> : <div className="level-result pending"><LoaderCircle className="spin" size={15} />Evaluating</div>}</div><div className="comparison-inputs">{usedColumns.map((column) => <div className="comparison-field" key={column}><span>{column}</span><div><label>L<InputEditor compact column={column} type={columnTypes[column] ?? { kind: "VARCHAR" }} value={values.left[column] ?? ""} onChange={(value) => updateValue("left", column, value)} /></label><label>R<InputEditor compact column={column} type={columnTypes[column] ?? { kind: "VARCHAR" }} value={values.right[column] ?? ""} onChange={(value) => updateValue("right", column, value)} /></label></div></div>)}</div>{hasTf && <div className="tf-inputs"><div><strong>Term frequency</strong><span>Optional proportions from 0 to 1</span></div><label>L<input type="number" min="0" max="1" step="any" value={tfValues[index]?.left ?? ""} onChange={(event) => setTfValues((current) => ({ ...current, [index]: { left: event.target.value, right: current[index]?.right ?? "" } }))} /></label><label>R<input type="number" min="0" max="1" step="any" value={tfValues[index]?.right ?? ""} onChange={(event) => setTfValues((current) => ({ ...current, [index]: { left: current[index]?.left ?? "", right: event.target.value } }))} /></label>{result && <output>{formatWeight(result.tfAdjustment)} TF</output>}</div>}<details className="level-details"><summary>Comparison levels <ChevronDown size={15} /></summary><div>{comparison.comparison_levels.map((level) => <div className={result?.gamma === level.comparison_vector_value ? "selected" : ""} key={`${level.comparison_vector_value}-${level.sql_condition}`}><span>{result?.gamma === level.comparison_vector_value && <Check size={14} />}{level.label_for_charts}</span><code>{level.sql_condition}</code><strong>γ {level.comparison_vector_value}</strong></div>)}</div></details></article>; })}</div></section>
          {generatedSql && <details className="sql-panel"><summary><span><Database size={16} />Generated DuckDB query</span><ChevronDown size={16} /></summary><pre>{generatedSql}</pre></details>}
        </main>
      )}

      {(
        <main className="dashboard-main model-main"><section className="page-heading"><div><h1>Settings</h1><p>The formatted JSON loaded into this browser tab.</p></div></section><section className="json-view"><pre>{JSON.stringify(JSON.parse(rawModel), null, 2)}</pre></section></main>
      )}
    </div>
  );
}