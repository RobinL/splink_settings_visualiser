# Splink Model Studio

A static Vite dashboard for inspecting serialized Splink DuckDB models. It runs
entirely in the browser: model JSON, synthetic record values, and DuckDB queries
do not leave the current tab.

## Run locally

```bash
npm install
npm run dev
```

Open the displayed URL and load JSON returned by
`linker.misc.save_model_to_json()`.

## Features

- Match-weight, m/u, and waterfall charts rendered with Splink's own Vega-Lite
  specifications for visual consistency with the Python library.
- DuckDB SQL AST parsing to discover input columns used by comparison levels.
- Explicit text, numeric, boolean, date, timestamp, list, JSON, and custom
  DuckDB column types.
- Editable left/right synthetic records, evaluated by DuckDB WASM.
- Per-comparison level results and a match-weight waterfall.
- Optional term-frequency inputs using Splink's adjustment formula.
- Generated evaluation SQL and the original model JSON for inspection.

Only DuckDB models and standard Splink-generated comparison SQL are supported.
Custom SQL must use functions available in DuckDB WASM and Splink's `_l`/`_r`
pair-column naming convention.

## Checks

```bash
npm test
npm run lint
npm run build
```

## Deploy

Publish the production build to the `gh-pages` branch:

```bash
pnpm run deploy
```

The same script can be run with `npm run deploy`. The deployed project is served
at <https://robinlinacre.com/splink_settings_visualiser/>.