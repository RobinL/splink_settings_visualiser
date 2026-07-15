Splink is a probabilistic data linkage library that outputs a range of visualisations that help the user understand the trained model.

In particular the following visualisations are most important:
- linker.visualisations.match_weights_chart
- linker.visualisations.m_u_parameters_chart
- linker.visualisations.waterfall_chart

and note also:
linker_detailed._settings_obj.human_readable_description


Note that Splink models have a serialised format with:
linker.misc.save_model_to_json()

Your task is to produce a static web page (vite) that ingests the Splink model JSON and displays the visualisations on a nice dashboard.

Note that the Splink model JSON does not include any of the original record linkage data so it will, for instance, tell you how the date of birth field is compared and what the match weights are but it will not give you examples of datese of birth.

Note also Splink is multi backend.  However, for the purpose of this dashboard, let's make it support only DuckDB.

We can render these without example data:
- linker.visualisations.match_weights_chart
- linker.visualisations.m_u_parameters_chart

But we cannot render
- linker.visualisations.waterfall_chart

without example data.

In order to render the waterfall chart I want you to do something clever:
I want the code to 'work out' what columns are in use.  You may need to use some sort of sql parising for this.

I then want the interface to show the two records being compared as rows i.e. one column for each of the columns referred to in the sql in the comparison levels

The cells are editable, and they can handle differnt types of input (e.g. string, numberic, date, but also nested things like list of strings, dict, list of dict etc.) depending on the data type of the column.

Don't try to infer the data type (i don't believe this is possible).  Default each one to a string, but there should be control(s) that allow you to change

The app stores default values the string columns.

Then, look in Splink source code for how you can convert the comparison levels in the model JSON into SQL queries that can be executed against the DuckDB backend.  In particular, write code that will generate the sql query so we can execute the query that gives you the data required for the waterfall chart and then show the waterfall chart.

Use DuckDB WASM for execution.

In addition, for each comparison, we want a widget that allows the user to enter data for the column(s) for that comparison, and it tells you which comparison level it evaluates to

Feel free to run things in Splink to understand how all this works, you can use a script like this if it helps:

```

import splink.comparison_library as cl
from splink import DuckDBAPI, Linker, SettingsCreator, block_on, splink_datasets

db_api = DuckDBAPI()

df = splink_datasets.fake_1000

settings = SettingsCreator(
    link_type="dedupe_only",
    comparisons=[
        cl.ExactMatch("first_name"),
        cl.ExactMatch("surname"),
        cl.ExactMatch("dob"),
        cl.ExactMatch("city").configure(term_frequency_adjustments=True),
        cl.ExactMatch("email"),
    ],
    blocking_rules_to_generate_predictions=[
        block_on("first_name"),
        block_on("surname"),
    ],
    max_iterations=2,
)

linker = Linker(df, settings, db_api=db_api)

linker.training.estimate_probability_two_random_records_match(
    [block_on("first_name", "surname")], recall=0.7
)

linker.training.estimate_u_using_random_sampling(max_pairs=1e6)

linker.training.estimate_parameters_using_expectation_maximisation(block_on("dob"))

pairwise_predictions = linker.inference.predict(threshold_match_weight=-10)

clusters = linker.clustering.cluster_pairwise_predictions_at_threshold(
    pairwise_predictions, 0.95
)

clusters.as_duckdbpyrelation()
```


