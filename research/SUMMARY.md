# claw-code Rewrite Research — 完整总结

## 项目概述

**claw-code** 是 ultraworkers 组织下的一个开源项目，核心目标：证明 AI coding harness 可以**完全自主维护**。

- **star 里程碑**：史上最快达到 50K stars 的仓库（2 小时内）
- **时间**：2026-03-31 → 2026-04-03（4 天，292 commits）
- **技术栈**：Rust（主战场）+ Python（镜像元数据层）
- **协调哲学**：claws 协作，humans 设定方向

---

## 架构概览

### 三层协调系统

1. **OmX**（workflow layer）：将短指令转为结构化执行协议，支持并行多 Agent
2. **clawhip**（event router）：事件和通知路由，保持监控在 context window 之外
3. **OmO**（multi-agent coordination）：多 Agent 规划/交接/分歧解决

### 人类接口是 Discord

不是 terminal，不是 tmux——人类在 Discord 发消息，然后去睡觉，claws 读完指令自动干活。

### Rust 9 Crates

```
rust/crates/
├── rusty-claude-cli/     # CLI 主程序
├── runtime/               # 运行时核心（含 TaskRegistry, PermissionEnforcer, bash_validation 等）
├── tools/                 # 40 个 tool specs 的暴露和执行
├── commands/              # 命令 surface
├── plugins/               # 插件系统
├── api/                   # API 层
├── mock-anthropic-service/ # 模拟 Anthropic 服务（测试用）
├── compat-harness/         # 兼容性测试 harness
└── telemetry/             # 遥测
```

---

## Python 重写分析

Python `src/` 树是一个**镜像元数据层**，不是运行时替代：

- `models.py`：集中式 immutable dataclass（Subsystem, PortingModule, UsageSummary, TurnResult 等）
- `query_engine.py`：会话管理（turn 限制、token 预算、compaction、streaming、持久化）
- `tools.py` / `commands.py`：从 JSON 快照加载，用 lru_cache 惰性缓存，提供过滤/搜索/shim 执行
- **真实可执行代码在 Rust**，Python 是理解和追踪工具

---

## 工具和命令系统

### Python 快照层

- `reference_data/commands_snapshot.json`：命令元数据快照
- `reference_data/tools_snapshot.json`：工具元数据快照
- 统一的 `PortingModule` 结构 + `lru_cache` 加载

### Rust 真实工具 Surface

40 个 tool specs，包括：
- **核心**：bash, read_file, write_file, edit_file, glob_search, grep_search
- **高级**：Task* (6个), Team*, Cron*, LSP, MCP lifecycle
- **产品**：WebFetch, WebSearch, TodoWrite, Agent, Skill, Config 等

权限系统完整实现：PermissionEnforcer + workspace boundary + read-only mode。

---

## AI 自主维护系统

### CLAUDE.md 规则

- Rust: `cargo clippy --workspace --all-targets -- -D warnings`
- 双 surface 规则：`src/` + `tests/` 必须一起更新
- 小步审查，禁止自动覆写 CLAUDE.md

### 三 Bot 协作

- **jobdori**：feature 分支提交
- **clawhip**：事件路由和状态同步
- **claw-code[bot]**：CI gate 和 merge

### 9-Lane 并行开发

每条 lane 独立追踪（commit hash, LOC, 状态），PARITY.md 诚实记录进度和剩余限制。

### 自动恢复配方

Failure Taxonomy → Recovery Recipe → 一次自动恢复 → 再升级。覆盖：trust gate、prompt misdelivery、stale branch、compile 失败、MCP handshake 失败等。

### Worker 状态机

`Spawning → TrustRequired → ReadyForPrompt → PromptAccepted → Running → Blocked/Finished/Failed`

---

## 关键洞察

1. **代码是证据，系统才是产品**：claw-code 的价值不在于复刻了 Claude Code，而在于展示了"AI 协作建造软件"是可行的
2. **瓶颈转移**：打字速度不再是瓶颈，稀缺的是架构清晰性和判断力
3. **Rust > TypeScript**：Python 作为中间层，最终可执行代码迁移到 Rust（性能、安全、部署）
4. **事件 > 日志**：typed lane events 替代文本日志，让 claws 真正自动化
5. **Partial success is first-class**：部分成功的 MCP 启动也要结构化报告

---

## 研究文件索引

| 文件 | 内容 |
|------|------|
| `milestone1-architecture.md` | 整体架构、三层系统、9-lane、5阶段 roadmap |
| `milestone2-python-rewrite.md` | dataclass 设计、QueryEngine、Python 元数据层定位 |
| `milestone3-tools-commands.md` | 工具/命令快照机制、权限系统、Rust 40 tools |
| `milestone4-autonomous-maintenance.md` | 三 Bot 协作、CLAUDE.md 规则、自动恢复机制 |
| `SUMMARY.md` | 本文件，综合总结 |

---

## 遗漏检查结果 (2026-04-05)

### 源码路径
`/tmp/claw-code-rewrite/`

### 已研究文件/目录
- README.md, PHILOSOPHY.md, PARITY.md, ROADMAP.md
- src/port_manifest.py, models.py, query_engine.py
- src/tools.py, commands.py
- rust/ 目录结构
- CLAUDE.md

### 已研究新增 (2026-04-05)

| 文件 | 行数 | 状态 |
|------|------|------|
| `src/runtime.py` | ~192 | ✅ 已研究 |
| `src/main.py` | ~213 | ✅ 已研究 |
| `src/parity_audit.py` | ~140 | ✅ 已研究 |
| `src/query_engine.py` | ~196 | ✅ 已研究（补充） |

### 未研究的重要文件（按重要性排序）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/QueryEngine.py` | - | Python 版 QueryEngine，与 query_engine.py 关系待确认 |
| `src/context.py` | 47 | PortContext 定义，源码/测试/资产路径管理 |
| `src/history.py` | - | 历史会话管理（Python 版） |
| `src/task.py` | - | Task 抽象（Python 版） |
| `src/tasks.py` | - | 任务管理（Python 版） |
| `src/Tool.py` | - | Tool 定义（Python 版） |
| `src/setup.py` | 77 | 设置流程（Python 版） |
| `USAGE.md` | - | Rust/claw CLI 使用指南 |
| `rust/MOCK_PARITY_HARNESS.md` | - | Mock LLM 测试框架说明 |
| `rust/mock_parity_scenarios.json` | - | Mock 测试场景定义 |
| `rust/TUI-ENHANCEMENT-PLAN.md` | - | TUI 增强计划 |
| `rust/scripts/run_mock_parity_harness.sh` | - | Mock 测试运行脚本 |
| `rust/crates/` 子目录内容 | - | 各 crate 的内部结构未逐一研究 |

### rust/ 目录结构概览（已见框架，未深入）
```
rust/crates/
├── rusty-claude-cli/      # CLI 主程序
├── runtime/               # 运行时核心
├── tools/                 # 40 个 tool specs
├── commands/              # 命令 surface
├── plugins/               # 插件系统
├── api/                   # API 层
├── mock-anthropic-service/ # 模拟 Anthropic 服务
├── compat-harness/         # 兼容性测试 harness
└── telemetry/             # 遥测
```

### 建议
1. **高优先级**：`src/QueryEngine.py`（与 query_engine.py 关系不明）
2. **中优先级**：`src/context.py`、`USAGE.md`
3. **低优先级**：Python 各个 TypeScript 移植文件（history.py, task.py 等）与 milestone 文档重复度高

---

## 新增研究 (Milestone 5)

### runtime.py — PortRuntime 类

**核心发现**：

1. **Prompt 路由算法**：基于 token 匹配的启发式路由，command/tool 各取最佳后按分数混合填充 limit
2. **bootstrap_session**：完整模拟查询流程：context 构建 → 路由 → 命令/工具执行 → API 模拟 → 持久化
3. **保守权限模型**：`bash` 相关工具默认拒绝（`destructive shell execution remains gated in the Python port`）
4. **turn_loop**：支持最多 max_turns 轮对话，遇到 `stop_reason != 'completed'` 时提前终止

### main.py — CLI 入口

**25个子命令**，覆盖：
- 镜像命令/工具清单查询
- 路由和引导会话报告
- 一致性审计（`parity-audit`）
- 多种运行时分支模拟（remote/ssh/teleport/direct-connect/deep-link）
- 会话持久化和恢复

### parity_audit.py — 一致性校验

**设计目标**：对比 Python 工作区 vs TypeScript 存档的覆盖率：
- 21个根文件映射 + 33个目录映射
- 5个审计维度：根文件、目录、总文件比、命令条目、工具条目
- 引用数据来自 `reference_data/archive_surface_snapshot.json` 等 ground-truth JSON

**Python 定位**：这是**镜像+审计工具**，不是生产替代品。`QueryEnginePort.submit_message()` 不做真实 API 调用，只模拟流程并生成摘要。
