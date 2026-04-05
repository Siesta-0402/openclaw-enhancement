# Milestone 6: Programming Framework

> 研究日期：2026-04-05
> 源码路径：~/Desktop/claude-code-main/

---

## 1. 概览

Claude Code 的编程框架围绕 **Tool 执行**、**Coordinator 多 Agent 协调** 和 **Streaming Tool 执行** 三个核心模块构建。

---

## 2. Tool 体系（src/tools/）

### 2.1 目录结构

```
src/tools/
├── AgentTool/          # AgentTool：派生新 Worker Agent
├── AskUserQuestionTool/ # 向用户提问
├── BashTool/           # Bash 命令执行
├── BriefTool/          # 简短输出工具
├── ConfigTool/         # 配置管理
├── EnterPlanModeTool/  # 进入 Plan 模式
├── EnterWorktreeTool/  # 进入 Git Worktree
├── ExitPlanModeTool/   # 退出 Plan 模式
├── ExitWorktreeTool/   # 退出 Git Worktree
├── FileEditTool/       # 文件编辑（核心工具）
├── FileReadTool/       # 文件读取
├── FileWriteTool/      # 文件写入
├── GlobTool/           # 文件模式匹配
├── GrepTool/           # 文本搜索
├── LSPTool/            # Language Server Protocol
├── MCPTool/            # Model Context Protocol 工具
├── NotebooksEditTool/  # Jupyter notebook 编辑
├── PowerShellTool/     # PowerShell 支持
├── ReadMcpResourceTool/ # 读取 MCP 资源
├── REPLTool/           # 交互式 REPL
├── ScheduleCronTool/   # 定时任务
├── SendMessageTool/    # 向 Agent 发送消息
├── SkillTool/          # Skill 调用
├── SleepTool/          # 延迟/等待
├── SyntheticOutputTool/ # 合成输出
├── TaskCreateTool/     # 创建任务
├── TaskGetTool/        # 获取任务
├── TaskListTool/       # 列出任务
├── TaskOutputTool/     # 任务输出
├── TaskStopTool/       # 停止任务
├── TaskUpdateTool/     # 更新任务
├── TeamCreateTool/     # 创建团队
├── TeamDeleteTool/     # 删除团队
├── TodoWriteTool/      # Todo 写入
├── ToolSearchTool/     # 工具搜索
├── WebFetchTool/       # 网页抓取
├── WebSearchTool/      # 网页搜索
├── shared/             # 共享工具代码
├── utils.ts            # 工具辅助函数
└── coordinatorMode.ts  # Coordinator 模式工具上下文
```

### 2.2 核心设计模式

**每个 Tool 都是一个独立模块**，通常包含：
- `constants.ts` — 工具名称、描述
- `prompt.ts` 或 `index.ts` — 工具定义（Zod schema + 描述）
- `toolName.ts` — 工具名常量

**工具元数据标记**（在 tools.ts 中读取）：
- `hasNamedArgs` — 参数是否命名
- `needsPermission` — 是否需要权限确认
- `offByDefault` — 默认关闭
- `isReadOnly` — 只读工具
- `backfillObservableInput` — 填充可见输入

**共享工具实用函数**（tools/utils.ts）：
```typescript
// 为用户消息打上 sourceToolUseID 标签，防止 UI 重复显示 "is running"
tagMessagesWithToolUseID(messages, toolUseID)

// 从父 AssistantMessage 中提取 tool_use block 的 ID
getToolUseIDFromParentMessage(parentMessage, toolName)
```

---

## 3. Tool 执行编排（src/services/tools/）

### 3.1 toolOrchestration.ts — 并发/串行分区执行

**核心函数：`runTools()`**

```typescript
async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate>
```

**分区策略（partitionToolCalls）：**

Claude Code 将 Tool 调用分为两类批次：
1. **Concurrency-safe 批次**：多个连续的只读工具 → 并发执行
2. **非安全批次**：单个非只读工具 → 串行执行

```typescript
// 伪代码逻辑
for (const { isConcurrencySafe, blocks } of partitionToolCalls(toolUseMessages)) {
  if (isConcurrencySafe) {
    // 并发执行（上限 10 个并发，由 CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY 控制）
    yield* runToolsConcurrently(blocks)
  } else {
    // 串行执行
    yield* runToolsSerially(blocks)
  }
}
```

**并发控制参数：**
```typescript
function getMaxToolUseConcurrency(): number {
  return parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}
```

**Context Modifier 机制：**
工具执行后可以返回 `contextModifier`，用于更新 `toolUseContext`（例如 `addMemory`、`updateReadFileState` 等）。这些 modifier 在并发批次完成后统一应用到 context 上。

### 3.2 StreamingToolExecutor — 流式工具执行

当 `streamingToolExecution` feature 开启时，`StreamingToolExecutor` 允许在模型流式输出的同时提前开始工具执行，而不是等待完整响应。

**设计思路：**
- 模型输出 tool_use block 时立即开始对应工具执行
- 工具结果在模型还在输出时就返回给模型
- 显著降低 TTFT（首次工具结果等待时间）

**与普通模式的区别：**
```typescript
// 普通模式：等待所有 tool_use 收集完毕后再执行
const toolUpdates = runTools(toolUseBlocks, ...)

// 流式模式：边收边执行
const streamingToolExecutor = new StreamingToolExecutor(tools, canUseTool, context)
for (const toolBlock of msgToolUseBlocks) {
  streamingToolExecutor.addTool(toolBlock, message)
}
for (const result of streamingToolExecutor.getCompletedResults()) {
  yield result.message
}
```

### 3.3 toolExecution.ts — 单个工具执行

`runToolUse()` 是单个 tool_use 的实际执行函数：
1. 调用 `canUseTool()` 检查权限
2. 通过 `findToolByName()` 定位工具
3. 验证输入 schema
4. 调用工具的 execute 函数
5. 处理权限请求/提升
6. 返回结果消息

---

## 4. Coordinator 多 Agent 框架（src/coordinator/）

### 4.1 coordinatorMode.ts

Coordinator 模式是 Claude Code 的**多 Worker 并行 Agent** 架构。

**核心环境变量：**
```typescript
process.env.CLAUDE_CODE_COORDINATOR_MODE  // 开启 Coordinator 模式
process.env.CLAUDE_CODE_SIMPLE             // 简化模式（只用 Bash/Read/Edit）
```

**角色定义：**
- **Coordinator（主 Agent）**：理解用户目标 → 分解任务 → 派发 Worker → 汇总结果
- **Worker（子 Agent）**：执行具体研究/实现/验证任务

**Worker 可用工具过滤：**
```typescript
const workerTools = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  ? [BASH_TOOL_NAME, FILE_READ_TOOL_NAME, FILE_EDIT_TOOL_NAME]
  : Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
      .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
```

**内部 Worker 工具**（Coordinator 保留，不派发）：
```typescript
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,    // 创建团队
  TEAM_DELETE_TOOL_NAME,    // 删除团队
  SEND_MESSAGE_TOOL_NAME,   // 发送消息
  SYNTHETIC_OUTPUT_TOOL_NAME, // 合成输出
])
```

**Coordinator 系统提示设计：**
- 明确角色定位：Coordinator 是面向用户的，Worker 结果是内部信号
- 强调**不感谢/不确认 Worker 结果**，直接汇总给用户
- 强制要求**合成（Synthesize）**：收到 Worker 研究结果后，必须自己理解后再派发实现任务

**任务分阶段：**
| Phase | 执行者 | 目的 |
|-------|-------|------|
| Research | Workers（并行） | 调研、找文件、理解问题 |
| Synthesis | **Coordinator** | 读取发现、理解问题、编写实现规范 |
| Implementation | Workers | 按规范实现 |
| Verification | Workers | 验证变更有效 |

**继续 vs 重新派发的决策矩阵：**

| 情况 | 机制 | 原因 |
|------|------|------|
| 研究探索的文件正好是要编辑的 | **继续**（SendMessage） | Worker 已加载相关文件上下文 |
| 研究范围广但实现范围窄 | **重新派发** | 避免引入探索噪声 |
| 修正失败或延续最近工作 | **继续** | Worker 有错误上下文 |
| 验证别的 Worker 刚写的代码 | **重新派发** | 验证者应独立，不带实现假设 |
| 完全不相关的任务 | **重新派发** | 无可复用上下文 |

**AgentTool 结果通知格式：**
Worker 结果通过 `<task-notification>` XML 标签传递给 Coordinator：
```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable status summary}</summary>
  <result>{agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

---

## 5. 缺失文件

- `src/apiMicrocompact.ts` — 未找到（可能路径不同或已重构）

---

## 6. 关键设计洞察

1. **工具并发安全模型**：Claude Code 通过 `isConcurrencySafe` 标记而非工具名称白名单来判断是否可并发——这是更健壮的设计，允许工具声明自己的并发安全性。

2. **Streaming Tool Execution**：允许模型边输出 tool_use 边开始执行，是降低延迟的关键优化。

3. **Coordinator 的严格 Synthesize 要求**：Coordinator 被强制要求在继续 Worker 前先自己理解研究结果，防止盲目委托。

4. **多 Worker 并行 + 单 Worker 串行**：Research 阶段鼓励充分并行，Implementation 阶段则按文件分区串行化。
