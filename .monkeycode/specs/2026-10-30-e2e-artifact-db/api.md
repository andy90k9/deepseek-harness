# API 规范

Feature: `e2e-artifact-db`
Updated: 2026-10-30

本页定义编排器对调用方暴露的 HTTP JSON API、TypeScript 库 API 和 CLI。dsh 自身的 `--json` 事件流保持 headless 契约，本页不重新规定。

Base path: `/api/v1`
Content-Type: `application/json; charset=utf-8`

所有成功响应：

```json
{ "ok": true, "data": {} }
```

所有失败响应：

```json
{ "ok": false, "error": { "code": "storage_busy", "message": "...", "operation": "etl.upsert", "run_id": "run_..." } }
```

`code` 取值见 [errors.md](errors.md)。

## 1. HTTP

### 1.1 POST /runs

排队并执行一次 run。

Request:

```json
{
  "task_id": "checkout_flow",
  "prompt": "optional override; omit to load the versioned prompt",
  "workspace": "/abs/path/to/worktree",
  "profile": "headless",
  "session_id": null,
  "timeout_ms": 1800000
}
```

| 字段 | 类型 | 必填 | 规则 |
|------|------|------|------|
| `task_id` | string | 是 | glossary 中的 `task_id` |
| `prompt` | string | 否 | 覆盖 prompt 库；空字符串拒绝 |
| `workspace` | string | 是 | 绝对路径，必须存在且为目录 |
| `profile` | `"headless"` \| `"sdk"` | 否 | 默认 `headless` |
| `session_id` | string \| null | 否 | 传入则作为 `--session-id`；未知 id → `aborted` |
| `timeout_ms` | integer | 否 | 正整数，默认 1800000 |

Response `201`：

```json
{
  "ok": true,
  "data": {
    "run_id": "run_019d0a15-1bf6-7bbd-b6ff-d500c99e5d6a",
    "status": "queued"
  }
}
```

编排器在返回后异步拉起 dsh。调用方用 1.2 轮询。同步阻塞调用走 1.6 CLI。

### 1.2 GET /runs/{run_id}

Response `200`：

```json
{
  "ok": true,
  "data": {
    "run_id": "run_019d0a15-1bf6-7bbd-b6ff-d500c99e5d6a",
    "session_id": "session-019d0a15-1bf6-7bbd-b6ff-d500c99e5d6a",
    "task_id": "checkout_flow",
    "profile": "headless",
    "status": "passed",
    "dsh_exit_code": 0,
    "turn_end_kind": "completed",
    "started_at": "2026-10-30T08:00:00.000Z",
    "finished_at": "2026-10-30T08:04:12.000Z",
    "log_uri": "file:///var/lib/dsh/sessions/--workspace--/session-019d0a15-1bf6-7bbd-b6ff-d500c99e5d6a/session.v4.jsonl",
    "error": null
  }
}
```

`404` → `run_not_found`。

### 1.3 GET /runs/{run_id}/artifacts

Response `200`：

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "path": "/work/report.json",
        "digest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "blob_uri": "blob://sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "description": "vitest json report",
        "copy_status": "copied"
      }
    ]
  }
}
```

`copy_status`：`copied` | `missing` | `unreadable`。

### 1.4 GET /runs/{run_id}/cases

Response `200`：`items[]` 每项 `{ case_id, outcome, detail }`。`outcome`：`passed` | `failed` | `skipped`。报告尚未解析时 `items` 为空数组。

### 1.5 GET /blobs/{digest}

返回文件字节。`Content-Type` 由入库时记录的 sniff 决定，未知则为 `application/octet-stream`。`404` → `blob_not_found`。

### 1.6 幂等与并发

- `POST /runs` 每次颁发新 `run_id`。
- 同一 `run_id` 的 upsert 是幂等的：重复 ETL 覆盖同键行。
- M1 sqlite：同一 db 文件禁止并行 `POST` 写；编排器串行化或分文件。

## 2. TypeScript 库 API

包名（拟）：`@deepseek-ai/dsh-e2e-orchestrator`。M1 作为 out-of-tree Host 插件 + 编排库，不改 shipped profile。

```ts
export interface StartRunRequest {
  taskId: string
  prompt?: string
  workspace: string
  profile?: 'headless' | 'sdk'
  sessionId?: string
  timeoutMs?: number
}

export interface RunRecord {
  runId: string
  sessionId: string | null
  taskId: string
  profile: 'headless' | 'sdk'
  status: RunStatus
  dshExitCode: number | null
  turnEndKind: string | null
  startedAt: string
  finishedAt: string | null
  logUri: string | null
  error: { code: string; message: string; operation: string } | null
}

export type RunStatus =
  | 'queued' | 'running' | 'collecting' | 'upserting'
  | 'passed' | 'failed' | 'aborted' | 'skipped'

export interface ArtifactRecord {
  path: string
  digest: string | null
  blobUri: string | null
  description: string | null
  copyStatus: 'copied' | 'missing' | 'unreadable'
}

export interface CaseRecord {
  caseId: string
  outcome: 'passed' | 'failed' | 'skipped'
  detail: Record<string, unknown> | null
}

export interface Orchestrator {
  start(request: StartRunRequest): Promise<{ runId: string }>
  wait(runId: string): Promise<RunRecord>
  get(runId: string): Promise<RunRecord>
  listArtifacts(runId: string): Promise<ArtifactRecord[]>
  listCases(runId: string): Promise<CaseRecord[]>
  close(): Promise<void>
}
```

`wait` 阻塞到终态（`passed` | `failed` | `aborted` | `skipped`）。SDK 路径必须在 `close()` 中 `await harness.close()`。

M1 Host 插件内部（不导出给模型）：

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const runRecordSchema = z.object({
  sessionId: z.string().nullable(),
  taskId: z.string(),
  profile: z.enum(['headless', 'sdk']),
  status: z.enum(['queued', 'running', 'collecting', 'upserting', 'passed', 'failed', 'aborted', 'skipped']),
  dshExitCode: z.number().int().nullable(),
  turnEndKind: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  logUri: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string(), operation: z.string() }).nullable(),
})

export const e2eResultsSpec = defineDomain({
  name: 'e2e_results',
  version: 1,
  tables: {
    runs: domainTable(runRecordSchema),
    artifacts: domainTable(z.object({
      runId: z.string(),
      path: z.string(),
      digest: z.string().nullable(),
      blobUri: z.string().nullable(),
      description: z.string().nullable(),
      copyStatus: z.enum(['copied', 'missing', 'unreadable']),
    })),
    case_results: domainTable(z.object({
      runId: z.string(),
      caseId: z.string(),
      outcome: z.enum(['passed', 'failed', 'skipped']),
      detail: z.record(z.string(), z.unknown()).nullable(),
    })),
    change_summaries: domainTable(z.object({
      runId: z.string(),
      seq: z.number().int(),
      turn: z.number().int(),
      source: z.enum(['host', 'git_fallback', 'unavailable']),
      summary: z.unknown().nullable(),
    })),
  },
})
```

`runs` 表 key = `run_id`。`artifacts` key = `${runId}\n${path}`。`case_results` key = `${runId}\n${caseId}`。`change_summaries` key = `${runId}\n${seq}`。

## 3. CLI

```sh
# 同步跑完并打印 run_id 与 status
dsh-e2e run --task checkout_flow --workspace /abs/work

# 查询
dsh-e2e show run_019d0a15-1bf6-7bbd-b6ff-d500c99e5d6a
```

实现通过库 API，不自造 dsh 入口 bin。内部仍调用 `dsh --profile headless`。

## 4. Headless `--json` 消费约定

编排器解析 stdout NDJSON，只认这些 type：

| type | 用途 |
|------|------|
| `session` | 取 `session_id` |
| `final` | 参考文本，写入 `meta.final_response_ref` 可选 |
| `error` | 启动/驱动失败，run `aborted` |
| `tool_call` / `tool_result` | 过程审计，默认不入库 |
| 其它 | 忽略 |

`turn/end` 从 Session JSONL 读取，不从 `--json` 流猜测。`reason.kind` 映射：

| kind | run.status 初值（断言前） |
|------|---------------------------|
| `completed` 且 exit 0 | `collecting` |
| `aborted` | `aborted` |
| `error` / `blocked` / `max-tokens` / `interrupted` | `failed` |
| `forked` | `aborted`（headless 拒绝 fork/subagent session） |

## 5. 认证

HTTP 面仅绑定 loopback。生产若暴露，由部署侧反向代理终止 TLS 并注入身份；本规范不发明 token 方案。
