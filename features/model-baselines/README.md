# Model baselines (ADR-0066)

One file per model id (`<id>--<model>.json`, `/` in the model id spelled `--`), holding the last committed scorecard for
that model: `{ "<cell>": { "passed": k, "trials": n } }`. `just e2e-model` writes the run's scorecard to
`features/.tmp/model-scorecard.json`; a cell below its FLOOR fails the scenario, a cell below its BASELINE while above
the floor is reported. Update a baseline by copying the cells from a run you have read. A model with no file here
reports and never drifts.
