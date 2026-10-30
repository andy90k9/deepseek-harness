# 库表与存储布局

Feature: `e2e-artifact-db`
Updated: 2026-10-30

路径 B（Postgres）是终态关系模型。路径 A（sqlite domain）是 document-per-row 投影，字段与下表 JSON 兼容。

## 1. Postgres DDL

```sql
CREATE TYPE e2e_run_status AS ENUM (
  'queued', 'running', 'collecting', 'upserting',
  'passed', 'failed', 'aborted', 'skipped'
);

CREATE TYPE e2e_copy_status AS ENUM ('copied', 'missing', 'unreadable');
CREATE TYPE e2e_case_outcome AS ENUM ('passed', 'failed', 'skipped');
CREATE TYPE e2e_change_source AS ENUM ('host', 'git_fallback', 'unavailable');

CREATE TABLE e2e_run (
  run_id         text PRIMARY KEY,
  session_id     text,
  profile        text NOT NULL CHECK (profile IN ('headless', 'sdk')),
  task_id        text NOT NULL,
  task_hash      text NOT NULL,
  task_summary   text NOT NULL,
  dsh_exit_code  integer,
  turn_end_kind  text,
  status         e2e_run_status NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  log_uri        text,
  error_code     text,
  error_message  text,
  error_operation text,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT e2e_run_id_prefix CHECK (run_id LIKE 'run_%'),
  CONSTRAINT e2e_run_terminal_exit CHECK (
    status NOT IN ('passed', 'failed') OR dsh_exit_code IS NOT NULL
  )
);

CREATE INDEX e2e_run_session_id_idx ON e2e_run (session_id);
CREATE INDEX e2e_run_task_status_idx ON e2e_run (task_id, status, started_at DESC);

CREATE TABLE e2e_artifact (
  run_id       text NOT NULL REFERENCES e2e_run (run_id) ON DELETE CASCADE,
  path         text NOT NULL,
  digest       text,
  blob_uri     text,
  description  text,
  copy_status  e2e_copy_status NOT NULL,
  copied_at    timestamptz NOT NULL,
  PRIMARY KEY (run_id, path),
  CONSTRAINT e2e_artifact_copied_digest CHECK (
    (copy_status = 'copied' AND digest IS NOT NULL AND blob_uri IS NOT NULL)
    OR (copy_status <> 'copied' AND digest IS NULL AND blob_uri IS NULL)
  ),
  CONSTRAINT e2e_artifact_digest_hex CHECK (
    digest IS NULL OR digest ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE e2e_case_result (
  run_id   text NOT NULL REFERENCES e2e_run (run_id) ON DELETE CASCADE,
  case_id  text NOT NULL,
  outcome  e2e_case_outcome NOT NULL,
  detail   jsonb,
  PRIMARY KEY (run_id, case_id)
);

CREATE TABLE e2e_change_summary (
  run_id  text NOT NULL REFERENCES e2e_run (run_id) ON DELETE CASCADE,
  seq     integer NOT NULL,
  turn    integer NOT NULL,
  source  e2e_change_source NOT NULL,
  summary jsonb,
  PRIMARY KEY (run_id, seq),
  CONSTRAINT e2e_change_unavailable CHECK (
    (source = 'unavailable' AND summary IS NULL)
    OR (source <> 'unavailable')
  )
);

CREATE TABLE e2e_blob (
  digest      text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  media_type  text NOT NULL DEFAULT 'application/octet-stream',
  storage_uri text NOT NULL,
  created_at  timestamptz NOT NULL
);
```

Writer 角色：`e2e_etl`（INSERT/UPDATE/DELETE）。
Assertor 角色：`e2e_assert`（SELECT）。

## 2. Upsert 语义

```sql
INSERT INTO e2e_run (run_id, session_id, profile, task_id, task_hash, task_summary, status, started_at, meta)
VALUES ($1, $2, $3, $4, $5, $6, 'queued', now(), '{}'::jsonb)
ON CONFLICT (run_id) DO UPDATE SET
  session_id = COALESCE(EXCLUDED.session_id, e2e_run.session_id),
  status = EXCLUDED.status,
  dsh_exit_code = COALESCE(EXCLUDED.dsh_exit_code, e2e_run.dsh_exit_code),
  turn_end_kind = COALESCE(EXCLUDED.turn_end_kind, e2e_run.turn_end_kind),
  finished_at = COALESCE(EXCLUDED.finished_at, e2e_run.finished_at),
  log_uri = COALESCE(EXCLUDED.log_uri, e2e_run.log_uri),
  error_code = EXCLUDED.error_code,
  error_message = EXCLUDED.error_message,
  error_operation = EXCLUDED.error_operation,
  meta = e2e_run.meta || EXCLUDED.meta;
```

`e2e_artifact` / `e2e_case_result` / `e2e_change_summary` 按主键 `ON CONFLICT DO UPDATE`。
`e2e_blob` 按 `digest` 插入，冲突忽略（内容寻址）。

禁止把 `session_id` 当作 run 主键。同一 `session_id` 可对应多行 `e2e_run`（续跑）。

## 3. 路径 A：sqlite domain 投影

域：`e2e_results` version `1`。

物理表（由 backend 创建，调用方不手写 DDL）：

```text
u_e2e_results_runs
u_e2e_results_artifacts
u_e2e_results_case_results
u_e2e_results_change_summaries
```

每表 `(key TEXT PRIMARY KEY, value TEXT)`，`value` 为 JSON。key 规则见 [api.md](api.md) 第 2 节。

schema 演进：升高 `defineDomain` 的 `version` 并手迁数据；旧库直接打开会 `version-mismatch`。Postgres 用常规 migration 工具。

## 4. Blob 布局

本地目录：

```text
<blob-root>/sha256/<digest[0:2]>/<digest>
```

对象存储 key 相同。`blob_uri` 本地为 `blob://sha256/<digest>`。与 session-log-export 的 `files/<digest>/<name>` 思路一致：digest 寻址，名字只留在 `e2e_artifact.path`。

复制算法：

1. 对 `deliverables/presented` 每个 `files[].path` `open` + `fstat`。
2. 非 regular file → `unreadable`。
3. 流式 sha256，写入临时文件，`fsync`，rename 到 digest 路径（已存在则删临时文件）。
4. upsert `e2e_artifact` 与 `e2e_blob`。

子代理的 `present` 不会自动出现在父会话事件里。父任务 prompt 必须要求父会话自己 `present`。

## 5. JSONL 事件抽取

| 事件 type | 写入 |
|-----------|------|
| header `type=session` | `session_id`, `log_uri` |
| `deliverables/presented` | artifact 候选路径 |
| `workspace/changes` | `seq` + `turn`；摘要从 Host API 取 |
| `turn/end` | 最后一条的 `reason.kind` → `turn_end_kind` |

`deliverables/presented` payload：

```ts
{ turn: number; callId: string; files: { path: string; description?: string }[] }
```

路径为绝对路径。后续编辑会改变打开到的内容；ETL 复制的是采集时刻的字节。

## 6. 脱敏

`e2e_run.meta` 允许字段：`profile`, `workspace_basename`, `timeout_ms`, `attempt`。
禁止字段：prompt 全文、工具输出、环境变量、API key。
`task_hash` = sha256(规范化 prompt UTF-8)。
`task_summary` ≤ 200 字符，人工编写的用例标题，不是模型输出。
