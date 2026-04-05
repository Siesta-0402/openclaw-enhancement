# Milestone 4: AI 自主维护系统

## 概述

claw-code 不仅仅是一个 AI 编程工具的克隆——它是一个**由 AI 自主构建和维护的开源项目**。项目本身就是用它宣扬的方法论建造的。

---

## CLAUDE.md — AI 的工作规则

```markdown
## Detected stack
- Languages: Rust.
- Frameworks: none detected from the supported starter markers.

## Verification
- Run Rust verification from `rust/`: `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- `src/` and `tests/` are both present; update both surfaces together when code changes.

## Repository shape
- `rust/` contains the Rust workspace and active CLI/runtime implementation.
- `src/` contains source files that should stay consistent with generated guidance and tests.
- `tests/` contains validation surfaces that should be reviewed alongside code changes.

## Working agreement
- Prefer small, reviewable changes and keep generated bootstrap files aligned with actual repo workflows.
- Keep shared defaults in `.claude.json`; reserve `.claude/settings.local.json` for machine-local overrides.
- Do not overwrite existing `CLAUDE.md` content automatically; update it intentionally when repo workflows change.
```

关键点：
1. **双 surface 规则**：`src/` 和 `tests/` 必须一起更新
2. **Clippy 严格模式**：`--all-targets -- -D warnings`（warning 当 error）
3. **小步审查**：偏好小、可审查的改动
4. **禁止自动覆盖**：CLAUDE.md 不得被自动覆写

---

## 三 Bot 协作体系

项目使用 3 个"身份"并行工作：

| 身份 | 角色 | 职责 |
|------|------|------|
| **jobdori** | 主执行 claw | 提交 feature 分支，处理 lane work |
| **clawhip** | 协调层 | 事件路由，通知分发，状态同步 |
| **claw-code[bot]** | CI/合并 | PR 检查，merge gate |

```
jobdori/*  branches  →  PR  →  claw-code[bot] CI  →  human review  →  merge to main
                            ↑
                     clawhip monitors & routes
```

---

## 9-Lane 并行开发追踪

每条 lane 是独立的功能分支，在 PARITY.md 中详细记录：

```
Lane 1: bash-validation     → branch: jobdori/bash-validation-submodules
Lane 2: CI fix              → branch: jobdori/fix-ci-sandbox
Lane 3: file-tool           → branch: jobdori/file-tool-edge-cases
Lane 4: TaskRegistry        → branch: jobdori/task-runtime
Lane 5: Task wiring         → branch: jobdori/task-registry-wiring
Lane 6: Team+Cron           → branch: jobdori/team-cron-runtime
Lane 7: MCP lifecycle       → branch: jobdori/mcp-lifecycle
Lane 8: LSP client          → branch: jobdori/lsp-client
Lane 9: Permission enforce  → branch: jobdori/permission-enforcement
```

每条 lane 有：
- Feature commit hash
- Merge commit hash
- LOC 变化
- 当前状态（merged / branch-only）

---

## 自主恢复机制

PARITY.md 列出的失败分类和恢复策略：

### 失败分类（Failure Taxonomy）

```rust
enum WorkerFailureKind {
    TrustGate,       // trust prompt 未解决
    PromptDelivery,  // prompt 发送到了 shell 而非 agent
    Protocol,        // 协议层错误
    Provider,        // LLM provider 错误
}
```

### 自动恢复配方

```rust
// 已知失败模式 → 自动恢复
if trust_gate_unresolved → auto_trust_known_repo
if prompt_misdelivered → auto_recover_prompt_misdelivery + replay_prompt
if stale_branch → merge_forward_before_broad_tests
if compile_red_after_refactor → rebuild_workspace
if mcp_handshake_failure → retry_mcp_connect
```

每种恢复尝试一次，然后再升级。

---

## 事件驱动的 Lane 状态

clawhip 驱动的 canonical lane events：

```
lane.started        → 新 lane 开始
lane.ready          → lane 准备好接收工作
lane.blocked        → lane 被阻塞
lane.red            → 测试失败
lane.green          → 测试通过
lane.commit.created → 新 commit
lane.pr.opened      → PR 开启
lane.merge.ready    → 可以合并
lane.finished       → lane 完成
lane.failed         → lane 失败
branch.stale_against_main → 分支落后 main
```

这些是**结构化 typed events**，不是日志文本。

---

## 会话控制 API（Rust 实现）

Rust 实现了完整的 worker 生命周期状态机：

```rust
enum WorkerStatus {
    Spawning,          // 正在启动
    TrustRequired,      // 需要信任确认
    ReadyForPrompt,     // 准备好接收 prompt
    PromptAccepted,     // prompt 已接受
    Running,            // 运行中
    Blocked,            // 被阻塞
    Finished,           // 完成
    Failed,             // 失败
}
```

关键保证：
- prompts 绝不早于 `ReadyForPrompt` 发送
- trust prompt 状态可检测且发出事件
- shell misdelivery 可识别为一级失败状态

---

## 自主维护 vs 传统维护对比

| 维度 | 传统开源项目 | claw-code |
|------|------------|-----------|
| 维护主体 | 人类开发者 | AI claws + 人类监督 |
| 任务分配 | 人力分配 | Discord 消息 → 分解 → claws 执行 |
| 进度追踪 | GitHub issues/PR | PARITY.md + 9-lane 系统 |
| 恢复 | 人工定位 bug | 自动恢复配方 |
| 状态报告 | 人工写 changelog | 结构化 lane events → Discord 摘要 |
| 质量门 | 人工 review | clippy warnings-as-errors + CI gate |
| 方向设定 | 人类决策 | 人类设定方向，claws 执行 |

---

## 实际运作数据

- **292 commits on main / 293 across branches**（4 天内）
- **48,599 Rust LOC** + **2,568 test LOC**
- **3 authors**: Bellman/Yeachan Heo + 2 bots
- **时间范围**: 2026-03-31 → 2026-04-03
- **达成**: 史上最快达到 50K stars 的仓库（2 小时内）

---

## 哲学意义

> *"The code is evidence. The coordination system is the product lesson."*

claw-code 证明了：
1. 开源项目可以**完全由 AI claws 驱动开发**
2. 人类不需要在 terminal 里 micromanage 每一步
3. Discord 可以成为比 GitHub Issues 更高效的人类指令入口
4. "小步审查 + 自动化恢复"可以支撑高速度同时保持质量
5. **架构清晰性和判断力**才是 AI 时代的稀缺资源，而非打字速度
