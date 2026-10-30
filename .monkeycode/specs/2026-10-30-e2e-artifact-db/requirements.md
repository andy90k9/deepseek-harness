# Requirements Document

## Introduction

编排器用 dsh 在真实工作目录执行端到端任务，把运行结果、交付文件内容和用例明细回流到结构化存储，再由独立断言层复核。本规范覆盖 M0 手动贯通到 M2 外部库入库。Webhook 与 ACP 列为后续范围。

## Glossary

见 [glossary.md](glossary.md)。本页使用的系统名是 **E2E Orchestrator**（编排器）、**Collector**（采集器）、**ETL**、**Assertor**（断言层）。

## Requirements

### Requirement 1 — 运行入口

**User Story:** AS 测试编排者, I want 用官方 dsh profile 跑一条端到端任务, so that 执行层与发货入口一致。

#### Acceptance Criteria

1. WHEN 编排器启动一次真实运行, THE E2E Orchestrator SHALL invoke `dsh --profile headless --json` with the task prompt as the positional argument or stdin.
2. WHEN `DEEPSEEK_API_KEY` is unset, THE E2E Orchestrator SHALL mark the run `skipped` and execute the keyless snapshot regression layer.
3. WHEN the caller needs multi-turn injection, THE E2E Orchestrator SHALL use `dsh --profile sdk` through `@deepseek-ai/dsh-sdk-client` and SHALL call `close()` after the owned interval.
4. WHERE a Node application is launched, THE E2E Orchestrator SHALL use a shipped dsh profile and SHALL keep package bins and public SDK argv escapes out of the launch path.

### Requirement 2 — 运行身份

**User Story:** AS 回流器, I want 稳定的 run 幂等键, so that 重试不会覆盖另一次独立运行。

#### Acceptance Criteria

1. WHEN a run is queued, THE E2E Orchestrator SHALL allocate `run_id` before exec.
2. WHEN headless emits the opening `session` event, THE Collector SHALL persist `session_id` as the exact string from that event.
3. WHEN the caller passes `--session-id` for an unknown identity, THE E2E Orchestrator SHALL record `status = aborted` without creating an empty Session.
4. WHEN a failed run is retried, THE E2E Orchestrator SHALL allocate a new `run_id` and MAY reuse `session_id` only as a conversation continuation.

### Requirement 3 — 产物边界

**User Story:** AS 断言层, I want 回流内容来自世界状态, so that 通过判定不依赖模型自述。

#### Acceptance Criteria

1. WHEN `present` succeeds, THE Collector SHALL copy each declared file's bytes into the blob store and SHALL store `(path, digest, blob_uri)`.
2. WHEN a declared path is missing, unreadable, or no longer a regular file, THE Collector SHALL record `artifact_copy_missing` for that path and SHALL continue other files.
3. WHEN dsh exits, THE Collector SHALL read `ctx.workspaceChanges.summary` before Session dispose, or run an external `git diff` fallback after dispose.
4. WHEN a test runner writes JUnit XML, vitest JSON, or pytest JSON, THE ETL SHALL parse case rows into `e2e_case_result`.
5. THE Assertor SHALL treat `finalResponse` as a reference field and SHALL derive pass/fail from exit code, `turn/end.reason`, stored rows, and blob digest.

### Requirement 4 — 存储落点

**User Story:** AS 平台维护者, I want M1 用内置 SQLite、终态用 Postgres, so that 起步无需外部库且报表可联查。

#### Acceptance Criteria

1. WHEN M1 is active, THE Host plugin SHALL open domain `e2e_results` version 1 through `ctx.storageDomain` on backend `sqlite`.
2. WHEN M2 is active, THE ETL SHALL upsert into Postgres tables defined in [schema.md](schema.md).
3. WHEN sqlite is the medium, THE writer SHALL be a single process; concurrent CI workers SHALL use per-run database files or defer writes to a post-run single writer.
4. WHEN a domain spec version differs from the stored unit version, THE opener SHALL fail with `version-mismatch`.

### Requirement 5 — 独立断言

**User Story:** AS CI, I want 用独立只读连接复核入库结果, so that 写入方的自我汇报不能充当通过证据。

#### Acceptance Criteria

1. WHEN asserting M1, THE Assertor SHALL open a separate `node:sqlite` read-only connection to the same database file.
2. WHEN asserting M2, THE Assertor SHALL open a read-only Postgres role distinct from the ETL writer role.
3. WHEN an artifact row exists, THE Assertor SHALL re-hash the blob bytes and SHALL require equality with `digest`.
4. WHEN the task declares untouched baseline files, THE Assertor SHALL compare those files byte-for-byte with the baseline.

### Requirement 6 — 采集时效

**User Story:** AS 回流器, I want 在 Host 进程失效前拿到变更摘要, so that `workspace/changes` 卡不会丢。

#### Acceptance Criteria

1. WHEN headless is about to exit, THE Collector SHALL capture `workspace/changes` summaries for every `workspace/changes` event sequence in the owned interval.
2. WHEN the Host process has already disposed the Session, THE Collector SHALL record `changes_unavailable` and SHALL store the git-diff fallback when a repository exists.
3. THE Collector SHALL keep the repository index, objects, work tree, and refs unmodified.

### Requirement 7 — 脱敏与保留

**User Story:** AS 安全负责人, I want JSONL 全量事件不直接进业务库, so that prompt 与工具输出不会扩散。

#### Acceptance Criteria

1. WHEN upserting metadata, THE ETL SHALL store `log_uri` pointing at the archived JSONL and SHALL keep prompt bodies out of `e2e_run.meta`.
2. WHEN `task_ref` is persisted, THE ETL SHALL store a hash plus a redacted summary.
3. WHEN TTL elapses, THE retention job SHALL delete blob objects unreferenced by any remaining `e2e_artifact` row, then delete expired run rows.

### Requirement 8 — 错误可见性

**User Story:** AS 编排者, I want 每次失败都有稳定错误码, so that CI 能分类重试。

#### Acceptance Criteria

1. WHEN a run ends in `failed` or `aborted`, THE E2E Orchestrator SHALL persist a `code` from [errors.md](errors.md) plus the affected operation.
2. WHEN blob copy fails for one file, THE Collector SHALL keep other files and SHALL leave the run `failed` if any declared deliverable is missing.
3. WHEN sqlite write lock contention occurs, THE writer SHALL fail immediately with `storage_busy` and SHALL avoid busy-wait retry.
