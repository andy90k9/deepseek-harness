# 端到端测试产物回流规范

Feature: `e2e-artifact-db`
Updated: 2026-10-30
Status: 规范草案（实施前按 `.agents/notes/README.md` 沉淀为 `proposed/testing` Agent Note）

用 DeepSeek Harness（dsh）驱动端到端测试任务，把运行结果与产物回流到结构化存储，并由独立断言层复核。本目录是该能力的规范首页：需求、设计、HTTP/库 API、库表与错误码都在这里。

## 文档目录

| 文件 | 职责 |
|------|------|
| [glossary.md](glossary.md) | 术语与标识符规则 |
| [requirements.md](requirements.md) | EARS 需求与验收标准 |
| [design.md](design.md) | 架构、组件、回流路径、正确性约束 |
| [api.md](api.md) | Orchestrator HTTP API、TypeScript 库 API、CLI |
| [schema.md](schema.md) | Postgres DDL、storage-domain 记录、blob 布局 |
| [errors.md](errors.md) | 稳定错误码与处理所有权 |

## 已锁定决策

| ID | 决策 |
|----|------|
| D1 | M1 用内置 `dsh-storage-sqlite` 域 `e2e_results`；终态用外部 Postgres + 内容寻址 blob 存 |
| D2 | 回流四类：`present` 交付文件内容、当场采集的 `workspace/changes` 摘要、Session JSONL 的 `log_uri`、测试运行器机器可读报告解析出的用例行。`finalResponse` 只作参考字段 |
| D3 | M0–M1 默认 `dsh --profile headless --json`；需要多轮时升级 SDK；Webhook 为 experimental，M0–M2 不接 |
| D4 | CI 必跑 keyless 快照回归；with-key 真实运行无 `DEEPSEEK_API_KEY` 时整层 self-skip |
| D5 | 入库前脱敏；JSONL 归档只存 `log_uri`；blob 按 digest 去重；TTL 由编排器配置 |

## 与仓库契约的对齐要点

- 运行入口一律 `dsh --profile <name>`，见 `docs/architecture.md#application-launch`。
- `present` 只声明路径，不复制内容；ZIP 导出同样只含声明。见 `packages/deliverables/tool-present/README.md`。
- `workspace/changes` 摘要驻留 Host，Session dispose 后不可查。见 `packages/deliverables/workspace-changes/README.md`。
- Session 日志路径是 `root/<project-key>/<encoded-id>/session.vN.jsonl[.zstd]`，不是 `root/<uuid>/session.vN.jsonl`。见 `packages/session/session-persistence-jsonl/README.md`。
- storage-domain 域名必须匹配 `UNIT_NAME_RE` = `^[a-z][a-z0-9_]*$`，因此域名为 `e2e_results`。
- Headless 未知 `--session-id` 在任务开始前失败，不会静默开空历史。
- `run_id` 由编排器颁发，与 `session_id` 分离：复用 `--session-id` 是续跑同一对话，不是独立新 run。
