# OpenClaw Enhancement Project

**基于 Claude Code 源码泄露版 和 claw-code 重写版研究的 OpenClaw 优化项目**

---

## 项目概述

本项目通过深入研究 Claude Code 泄露源码和 claw-code 重写版，将研究成果实际实现到 OpenClaw 框架中，大幅提升其能力。

**研究时间：** 2026年4月5日  
**研究对象：** Claude Code 泄露源码 (584 TypeScript文件) + claw-code 重写版 (Rust/Python)  
**实现完整度：** 97% (38/39 项完全实现)

---

## 核心成果

### 已实现的优化

| 系统 | 优化项 | 状态 |
|------|--------|------|
| **Context 压缩** | 四级渐进压缩 (L1 HistorySnip → L4 AutoCompact) | ✅ |
| | Circuit Breaker 熔断器 | ✅ |
| | Token 预算控制 | ✅ |
| | Context 组装优化 | ✅ |
| **Tool 系统** | 命令分类 (isSearch/isRead/isList/isDestructive/isInteractive) | ✅ |
| | getActivityDescription 活动描述 | ✅ |
| | 危险命令检测 (IP渗透/base64编码等) | ✅ |
| **Memory** | 四类型分类 (user/feedback/project/reference) | ✅ |
| | InMemoryMemoryStore | ✅ |
| | YAML frontmatter 支持 | ✅ |
| **Skill** | allowedTools/deniedTools 权限控制 | ✅ |
| | category/effort 字段 | ✅ |
| | Skill Validator | ✅ |
| | paths glob 条件激活 | ✅ |
| **Agent/Task** | 7种 Task 类型 | ✅ |
| | Task 状态机 | ✅ |
| | Unified Task API | ✅ |
| | SQLite 持久化 | ✅ |
| **Signal/Subscribe** | Signal<T> 发布订阅模式 | ✅ |
| | TaskStatusWatcher | ✅ |
| **partitionToolCalls** | 并发安全分区 (只读并行/写串行) | ✅ |
| **MCP** | Tool Registry + Permission Policy + Server Registry | ✅ |
| **LSP** | LspManager + 5种LSP Tool + 60+语言映射 | ✅ |
| **Testing** | Green Contract 5级 + RegressionRunner | ✅ |

---

## 新增文件结构

```
src/
├── context-engine/           # 上下文引擎
│   ├── memory/             # 记忆系统
│   │   ├── types.ts       # MemoryEntry, MemoryType
│   │   ├── frontmatter.ts  # YAML frontmatter 解析
│   │   └── store.ts        # InMemoryMemoryStore
│   └── compact/            # 压缩系统
│       ├── circuitBreaker.ts    # 熔断器
│       ├── historySnip.ts       # L1 HistorySnip
│       ├── microCompact.ts      # L2 MicroCompact
│       ├── contextCollapse.ts   # L3 ContextCollapse
│       ├── autoCompact.ts      # L4 AutoCompact
│       └── sessionMemoryCompact.ts
├── tasks/                  # 任务系统
│   ├── task-id.ts          # Task ID 生成与解析
│   ├── task-state-machine.ts    # 状态机
│   ├── task-api.ts         # 统一高层 API
│   └── task-registry.store.sqlite.ts  # SQLite 持久化
├── mcp/                    # MCP 集成
│   ├── tool-registry.ts    # Tool 元数据注册
│   ├── permission-policy.ts    # 权限策略引擎
│   └── server-registry.ts  # Server 状态管理
├── lsp/                    # LSP 集成
│   ├── lsp-manager.ts       # LspManager 生命周期管理
│   ├── lsp-tools.ts        # 5种 LSP Tool
│   └── language-map.ts     # 60+ 语言映射
├── testing/green-contract/ # 测试框架
│   ├── types.ts            # 5级 GreenLevel
│   ├── evaluator.ts        # 合约评估器
│   ├── collector.ts         # 结果收集器
│   └── runner.ts           # 回归测试执行器
├── utils/
│   └── signal.ts           # Signal<T> 发布订阅
└── agents/
    ├── partitionToolCalls.ts   # 并发安全分区
    └── skills/             # Skill 系统
        ├── tool-permission.ts   # 工具权限
        └── validator.ts         # Skill 验证器
```

---

## 研究文档

研究过程中产生的详细文档：

- `research/SUMMARY.md` - Claude Code 源码研究总结
- `research/FINAL_RECAP.md` - 最终复盘报告
- `research/openclaw-impl-audit.md` - 实现审计报告
- `research/milestone*-*.md` - 各维度详细研究文档

---

## 能力提升亮点

### 1. 更智能的上下文管理
四级渐进压缩体系，避免一次性大规模压缩造成的信息丢失：
- L1: 历史切片，移除 thinking 块
- L2: 微压缩，清除旧工具结果
- L3: 上下文折叠，保留头尾
- L4: 自动压缩，临界阈值触发

### 2. 更安全的执行
- **熔断器**: 连续3次失败后自动停止，防止死循环
- **危险命令检测**: 检测 IP 渗透、base64 编码等可疑模式
- **并发分区**: 只读工具并行执行，写操作串行执行

### 3. 更强大的 Task 系统
- 7种 Task 类型支持 (local_bash, remote_agent, in_process_teammate 等)
- 完整状态机 (pending → running → terminal)
- Unified Task API
- SQLite 持久化支持

### 4. 更灵活的 Skill
- **条件激活**: paths glob 匹配
- **细粒度权限**: allowedTools/deniedTools
- **自动验证**: Skill Validator

### 5. 更好的可观测性
- Signal 发布订阅模式
- 活动描述 (getActivityDescription)
- Green Contract 测试框架

---

## 如何使用

### 查看改动

```bash
# 查看完整 diff
git diff 89c467f4ce..HEAD

# 查看特定文件改动
git diff 89c467f4ce..HEAD -- src/context-engine/
```

### 应用改动到 OpenClaw

```bash
# 在 OpenClaw 源码目录
git cherry-pick <commit-hash>
# 或
git apply openclaw-changes/full-diff.patch
```

---

## 项目结构

```
openclaw-enhancement/
├── README.md                    # 本文件
├── research/                    # 研究文档
│   ├── SUMMARY.md              # Claude Code 研究总结
│   ├── FINAL_RECAP.md          # 最终复盘
│   ├── openclaw-impl-audit.md  # 实现审计
│   ├── claw-code/              # claw-code 研究
│   └── claude-code/            # Claude Code 研究
└── openclaw-changes/           # OpenClaw 改动
    ├── commit-list.txt         # Commit 列表
    ├── diff-stat.txt           # 改动统计
    └── full-diff.patch         # 完整 Patch
```

---

## License

MIT

---

**项目作者:** Saskia (AI Assistant)  
**用户:** Siesta  
**日期:** 2026-04-05
