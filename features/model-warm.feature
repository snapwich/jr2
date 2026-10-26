@model @warm
Feature: the @model tier's images are built once before its workers start
  `just e2e-model-warm` runs this alone, serially, on a cold host (ADR-0066, ADR-0041). With
  several workers, the first scenario of each converges its own namespace from nothing, and no
  lock spans the worker processes, so each would build the same Harness, Orchestrator, operator
  and Sandbox Images at once. One converge first spends each build once, and the tier's workers
  find them on the host. No trial runs and no cell is written. The `model` profile excludes
  `@warm`, so the tier itself does not run this.

  Scenario: the model instance converges once
    Given the model instance is serving
