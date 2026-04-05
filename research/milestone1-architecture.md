# Milestone 1: 架构概览

## 整体架构设计理念

claw-code 是一个"用 AI 建造 AI 代码"的公开演示项目。其核心不是代码本身，而是**协调系统**——人类给方向，AI 爪（claws）执行工作。

---

## 核心理念：人类设定方向，AI 执行劳动

> *"The bottleneck is no longer typing speed. The scarce resource is: architectural clarity, task decomposition, judgment, taste, conviction about what is worth building."*

claw-code 证明了：
- 一个开源编程 harness 可以**完全自主维护**
- **多只 claws 可以并行协作**
- 通过 Discord 频道即可管理整个项目
- 规划/执行/审查/重试循环全部自动化

---

## 三层系统架构

```
┌─────────────────────────────────────────────┐
│         Discord (人类指令入口)                │
└─────────────┬───────────────────────────────┘
              │
┌─────────────▼───────────────────────────────┐
│   OmX (oh-my-codex) — 工作流层               │
│   将短指令转为结构化执行协议                   │
│   - planning keywords                        │
│   - execution modes                          │
│   - persistent verification loops            │
│   - parallel multi-agent workflows           │
└─────────────┬───────────────────────────────┘
              │
┌─────────────▼───────────────────────────────┐
│  clawhip — 事件和通知路由                     │
│  监控: git commits, tmux, issues/PRs,         │
│  生命周期事件, channel 投递                    │
│  目标: 让信息传递在 agent context window 之外  │
└─────────────┬───────────────────────────────┘
              │
┌─────────────▼───────────────────────────────┐
│  OmO (oh-my-openagent) — 多 Agent 协调        │
│  规划/交接/分歧解决/验证循环                    │
└─────────────────────────────────────────────┘
```

---

## 仓库结构（Python + Rust 双轨）

```
claw-code-rewrite/
├── src/                     # Python 移植工作区
│   ├── main.py              # CLI 入口
│   ├── models.py            # dataclass 模型层
│   ├── port_manifest.py     # 工作区清单生成
│   ├── query_engine.py      # 查询/会话引擎
│   ├── commands.py          # 命令端口元数据
│   ├── tools.py             # 工具端口元数据
│   ├── task.py              # 任务级别规划结构
│   └── reference_data/      # 快照 JSON（来自原 TS 源码）
│
├── rust/                    # Rust 重写工作区（当前主战场）
│   └── crates/
│       ├── rusty-claude-cli # CLI 主程序
│       ├── runtime/          # 运行时核心
│       ├── tools/             # 工具 surface（40 个 tool specs）
│       ├── commands/         # 命令 surface
│       ├── plugins/           # 插件系统
│       ├── api/               # API 层
│       ├── mock-anthropic-service/  # 模拟服务（测试用）
│       ├── compat-harness/    # 兼容性测试 harness
│       └── telemetry/         # 遥测
│
├── tests/                   # Python 验证
├── PARITY.md               # 9-lane 并行开发追踪文档
├── ROADMAP.md              # 5 阶段 roadmap
└── CLAUDE.md               # AI 维护规则（给 Claude Code 自己读）
```

---

## 9-Lane 并行开发系统

PARITY.md 记录了 9 条并行开发 lane 的状态：

| Lane | 功能 | 状态 |
|------|------|------|
| 1 | Bash validation | merged |
| 2 | CI fix | merged |
| 3 | File-tool | merged |
| 4 | TaskRegistry | merged |
| 5 | Task wiring | merged |
| 6 | Team+Cron | merged |
| 7 | MCP lifecycle | merged |
| 8 | LSP client | merged |
| 9 | Permission enforcement | merged |

Rust 现状：
- 292 commits on main / 293 across branches
- 9 crates in workspace
- 48,599 tracked Rust LOC
- 2,568 test LOC
- 3 authors (Bellman/Yeachan Heo + 2 bots)

---

## Python 工作区定位

Python `src/` 树是一个**镜像元数据工作区**，不追求运行时等价，而是：
1. 从 reference_data 加载原 TS 快照
2. 用 dataclass 建模系统结构
3. 提供 query_engine 做会话管理和 token 预算控制
4. 保持 parity 可追踪性

真正可执行的是 Rust 工作区。

---

## Roadmap 5 阶段方向

1. **Phase 1** — 可靠的 Worker Boot（trust prompt、ready handshake）
2. **Phase 2** — Event-Native Clawhip 集成（typed lane events）
3. **Phase 3** — Branch/Test 感知 + 自动恢复
4. **Phase 4** — Claws-First 任务执行（typed task packets + policy engine）
5. **Phase 5** — Plugin/MCP 生命周期成熟

---

## 关键设计哲学

- **Terminal is transport, not truth** — tmux/TUI 是实现细节，真实状态在更高层
- **Events over scraped prose** — 结构化 typed events > 文本日志
- **Policy is executable** — 合并/重试/rebase/清理规则机器可执行
- **Recovery before escalation** — 已知失败模式先自愈，再升级
- **Partial success is first-class** — 部分启动成功也要结构化报告
