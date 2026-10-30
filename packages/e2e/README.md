# e2e — End-to-end orchestration

Run `dsh` headless against a real workspace, collect deliverable artifacts and workspace changes, persist results through the `storage-domain` seam, and assert world-state from an independent read-only connection. The orchestrator is the single entry point that moves a run through `queued → running → collecting → upserting → {passed|failed|aborted|skipped}`.

## Packages

| Package | Role |
|---|---|
| [`orchestrator/`](orchestrator/README.md) | M1 orchestration core: run_id allocation, `dsh --profile headless --json` exec, JSONL parsing, blob copy, ETL upsert, and assertor helpers |

## Scope

- **M1 only** in the current work: SQLite storage-domain (`e2e_results`, version 1), headless `--json` execution, filesystem content-addressed blob store.
- M2 (Postgres + offline ETL) and HTTP surface are specified in `.monkeycode/specs/2026-10-30-e2e-artifact-db/` but not yet implemented here.
- This group never injects tools or prompt text into Sessions; Host-side, model-invisible only.
