# 术语与标识符

Feature: `e2e-artifact-db`
Updated: 2026-10-30

本页是标识符、状态机和路径规则的唯一家园。其他规范只引用，不复述。

## 术语

| 术语 | 定义 |
|------|------|
| Run | 编排器一次端到端调用：准备独立工作区、拉起 dsh、采集产物、upsert 记录、交给断言层 |
| Session | dsh 持久对话，身份为 `SessionId`。Headless 默认 `session-<uuid>`（保留 UUID 连字符）；SDK `session()` 默认 `session-<uuid无连字符>` |
| Artifact | `present` 声明的交付文件在回流器复制后的内容寻址副本 |
| Blob store | 按 sha256 去重存放文件字节的目录或对象存储 |
| Collector | 运行结束后立即采集 JSONL 声明、工作区文件字节和 `workspace/changes` 摘要的进程内或紧随其后的离线步骤 |
| ETL | 路径 B 的独立进程：解析、复制、脱敏、upsert 到 Postgres |
| Assertor | 与写入方分离的只读复核：查库、比对 digest、解析测试运行器报告 |
| Task prompt | 版本化用例文本：环境、步骤、期望产物、必须 `present` 的交付指令 |

## 标识符

| 字段 | 规则 | 颁发者 |
|------|------|--------|
| `run_id` | `run_` + UUID v4 规范字符串（含连字符），例 `run_019d0a15-1bf6-7bbd-b6ff-d500c99e5d6a` | 编排器，在拉起 dsh **之前** |
| `session_id` | dsh 实际采用的 `SessionId` 原文，空白计入。Headless `--json` 的起始 `session` 事件给出 | dsh |
| `task_id` | 版本化 prompt 库中的稳定用例键，`[a-z][a-z0-9_]{1,63}` | prompt 库 |
| `attempt` | 同一 `run_id` 的重试序号，从 `1` 起的正整数。失败后续跑分配**新** `run_id` | 编排器 |
| `artifact_id` | `art_` + UUID v4 | ETL / Host 插件在复制成功后 |
| `digest` | 小写 hex sha256，64 字符 | 回流器对文件字节计算 |
| `case_id` | 测试运行器报告中的用例标识，同一 `run_id` 内唯一 | 报告解析器 |
| `blob_uri` | `blob://sha256/<digest>` 或对象存储 URI | blob 存 |

`run_id` 与 `session_id` 一对一。复用 `--session-id` 续跑同一对话时，编排器仍颁发新 `run_id`，旧 run 保持终态。Headless 对未知 `--session-id` 在任务开始前失败，编排器将该失败记为 `aborted`，不创建空 Session。

## 状态机

`e2e_run.status`：

```text
queued --> running --> collecting --> upserting --> passed
                                   --> failed
                     --> aborted
                     --> skipped
```

| 状态 | 进入条件 |
|------|----------|
| `queued` | 编排器已分配 `run_id`，尚未 exec dsh |
| `running` | dsh 进程已启动 |
| `collecting` | dsh 已退出，回流器正在读工作区与 JSONL |
| `upserting` | 元数据写入存储 |
| `passed` | 断言层独立复核通过 |
| `failed` | dsh 非 0 退出，或断言失败 |
| `aborted` | 启动前失败、取消、或未知 `--session-id` |
| `skipped` | 无 `DEEPSEEK_API_KEY`，真实运行层 self-skip |

`e2e_run.dsh_exit_code` 与 `status` 独立：`exit_code = 0` 只表示 headless 认为 turn 完成，通过判定仍由断言层给出。

## 路径

Session JSONL 当前代（writer = 4，`compression: 'none'`）：

```text
<root>/<project-key>/<encoded-session-id>/session.v4.jsonl
```

`compression: 'zstd'` 时文件名为 `session.v4.jsonl.zstd`。`<project-key>` 由 cwd 经 `projectKey()` 得到；`<encoded-session-id>` 由 `encodeSegment(session_id)` 得到。ETL 禁止假设 `root/<session_id>/session.vN.jsonl`。

`present` 事件 `deliverables/presented.data.files[].path` 是绝对路径。回流器按该路径读字节；文件缺失记 `artifact_copy_missing`，不把声明当成已归档。

## 命名约束

storage-domain 的域名与表名必须匹配 `UNIT_NAME_RE` = `^[a-z][a-z0-9_]*$`。

| 用途 | 合法名 | 非法名 |
|------|--------|--------|
| 域 | `e2e_results` | `e2e-results` |
| 表 | `runs` `artifacts` `case_results` `change_summaries` | 含连字符的任何名 |
