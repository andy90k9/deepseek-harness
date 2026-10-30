# 错误码

Feature: `e2e-artifact-db`
Updated: 2026-10-30

每个失败 run 持久化 `error_code` + `error_operation`。调用方按 `code` 分支，不解析 `message`。

## 稳定码

| code | HTTP | 何时 | 处理所有者 | 之后状态 |
|------|------|------|------------|----------|
| `run_not_found` | 404 | `GET` 未知 `run_id` | API | 无变更 |
| `blob_not_found` | 404 | digest 无对象 | API | 无变更 |
| `invalid_request` | 400 | 缺字段、空 prompt、相对 workspace | API | 不创建 run |
| `key_missing` | 200 | 无 `DEEPSEEK_API_KEY` | Orchestrator | `skipped` |
| `session_id_unknown` | 409 | `--session-id` 无持久 Session | Orchestrator | `aborted` |
| `session_id_occupied` | 409 | 同进程已有 Agent 占用该 id | Orchestrator | `aborted` |
| `session_cwd_mismatch` | 409 | 续跑 cwd / preset 与记录不符 | Orchestrator | `aborted` |
| `dsh_exit_nonzero` | 200 | headless 退出 1 | Orchestrator | `failed` 或 `aborted`（看 `turn_end_kind`） |
| `dsh_timeout` | 200 | 超过 `timeout_ms` | Orchestrator | `aborted`；杀子进程 |
| `jsonl_not_found` | 200 | `generationLogPath` 不存在 | Collector | `failed` |
| `jsonl_corrupt` | 200 | 完整帧校验失败 | Collector | `failed` |
| `artifact_copy_missing` | 200 | 声明路径采集时不存在 | Collector | 该行 `missing`；run `failed` |
| `artifact_unreadable` | 200 | 目录、symlink、权限 | Collector | 该行 `unreadable`；run `failed` |
| `changes_unavailable` | 200 | Session 已 dispose | Collector | 摘要行 `unavailable`；不单独令 run fail |
| `storage_busy` | 503 | sqlite 写锁被占 | ETL | 立即失败，不重试忙等 |
| `version_mismatch` | 500 | domain / `user_version` 不符 | ETL | 拒绝打开 |
| `invalid_record` | 500 | zod 校验失败 | ETL | 该写入拒绝，内存不变 |
| `backend_not_found` | 500 | route 指向未注册 backend | 启动 | 进程不起来 |
| `assert_digest_mismatch` | 200 | blob 重哈希 ≠ 行内 digest | Assertor | run `failed` |
| `assert_baseline_mismatch` | 200 | 未触碰文件与基线不同 | Assertor | run `failed` |
| `assert_case_missing` | 200 | 期望 case_id 无行 | Assertor | run `failed` |

`message` 含失败主体与下一步：例如 `present path /work/report.json missing at collect time; declare a live regular file`。

## 所有权

| 失败类 | 报告者 | 清理 |
|--------|--------|------|
| 请求校验 | API | 无副作用 |
| dsh 启动/退出 | Orchestrator | 杀子进程；工作区由创建方 `afterEach` dispose |
| 采集 | Collector | 已写入的 blob 保留（内容寻址）；缺失文件不写 blob |
| 入库 | ETL | 被拒的 `put` 不改内存；sqlite 锁冲突整批失败 |
| 断言 | Assertor | 只读，不改行；由编排器把 status 更新为 `failed` |

未知结果（超时且无法确认子进程已退出）保持 `running` 并暴露 `dsh_timeout`，禁止报 `passed`。

## 重试

安全重试：`storage_busy`、`dsh_timeout`（已确认进程退出）、网络性 blob PUT。
每次重试新 `run_id`。
禁止：对 `version_mismatch`、`invalid_record`、`session_id_unknown` 自动重试。
