# Milestone 7: Agent Framework（Agent 框架）

> 研究日期：2026-04-05
> 源码路径：~/Desktop/claude-code-main/

---

## 1. 概览

Claude Code 的 Agent 框架以 **Task 抽象** 为核心，结合 **Query 循环状态机** 实现任务的创建、执行、追踪和终止。

---

## 2. Task 抽象体系

### 2.1 Task 类型定义（src/Task.ts）

```typescript
export type TaskType =
  | 'local_bash'       // 本地 Bash 命令
  | 'local_agent'      // 本地 Agent（in-process）
  | 'remote_agent'     // 远程 Agent
  | 'in_process_teammate' // 进程内队友
  | 'local_workflow'   // 本地工作流脚本
  | 'monitor_mcp'      // MCP 监控
  | 'dream'            // 异步 Dream 任务

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
```

**Task ID 前缀约定：**
```typescript
const TASK_ID_PREFIXES = {
  local_bash: 'b',         // backward compat
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}
```

**Task ID 编码：**
- 使用 36 进制（0-9 + a-z），8 位随机字节
- 36^8 ≈ 2.8 万亿组合，防暴力 symlink 攻击
- 格式：`{prefix}{8-char-random}`

### 2.2 Task 接口（src/Task.ts）

```typescript
export type Task = {
  name: string
  type: TaskType
  // 所有实现都使用 setAppState — getAppState/abortController 在 kill 中未使用
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

**注意：** spawn/render 方法已被移除（#22546），kill 是 Task 接口的唯一方法。

### 2.3 Task 基类状态（TaskStateBase）

```typescript
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string        // 关联的 Tool Use ID
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string        // 输出文件路径（持久化输出）
  outputOffset: number      // 读取偏移量（支持 tail -f 风格）
  notified: boolean         // 是否已通知完成
}
```

### 2.4 Task 注册表（src/tasks.ts）

```typescript
export function getAllTasks(): Task[] {
  return [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
    ...(feature('WORKFLOW_SCRIPTS') ? [LocalWorkflowTask] : []),
    ...(feature('MONITOR_TOOL') ? [MonitorMcpTask] : []),
  ]
}
```

### 2.5 任务目录结构（src/tasks/）

```
src/tasks/
├── DreamTask/              # 异步后台任务（dream 类型）
├── InProcessTeammateTask/  # 进程内队友通信
├── LocalAgentTask/         # 本地 Agent（派生子 Agent）
├── LocalMainSessionTask.ts # 主会话任务
├── LocalShellTask/         # 本地 Bash 任务
├── RemoteAgentTask/        # 远程 Agent
├── stopTask.ts             # 停止任务的通用逻辑
└── types.ts                # Task 相关类型
```

---

## 3. Query 循环状态机（src/query.ts）

### 3.1 整体架构

`query()` 是一个 **AsyncGenerator 函数**，每次 yield 产生一个事件/消息，最终返回 `Terminal` 状态。

```typescript
export async function* query(params: QueryParams): AsyncGenerator<
  | StreamEvent        // API 流式事件
  | RequestStartEvent  // 请求开始
  | Message           // 消息（user/assistant/system）
  | TombstoneMessage  // 墓碑消息（删除标记）
  | ToolUseSummaryMessage, // 工具使用摘要
  Terminal            // 终止状态
>
```

### 3.2 循环状态（State）

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined  // 上一次继续的原因
}
```

### 3.3 主循环流程

```
while (true) {
  1. microcompact（前处理：缓存编辑）
  2. context collapse（上下文折叠）
  3. autocompact（自动压缩）
  4. callModel（流式 API 调用）
     → 边收边执行 streamingToolExecutor（如启用）
     → 收集 tool_use_blocks
  5. if needsFollowUp:
       → runTools（工具执行）
       → 收集 tool_results
       → 递归继续（下一轮循环）
  6. else:
       → 检查 stop hooks
       → 检查 token budget
       → return { reason: 'completed' }
}
```

### 3.4 终止原因（Terminal / Continue Reason）

```typescript
type Terminal =
  | { reason: 'blocking_limit' }     // 上下文超限被阻止
  | { reason: 'image_error' }         // 图片错误
  | { reason: 'prompt_too_long' }    // 提示过长
  | { reason: 'max_turns', turnCount: number }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'hook_stopped' }
  | { reason: 'completed' }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'model_error', error: Error }

// Continue reasons:
type Continue =
  | { reason: 'next_turn' }                    // 正常下一轮
  | { reason: 'collapse_drain_retry' }         // 折叠耗尽后重试
  | { reason: 'reactive_compact_retry' }      // 响应式压缩重试
  | { reason: 'max_output_tokens_escalate' }  // 输出 token 上限升级
  | { reason: 'max_output_tokens_recovery' }  // 输出 token 恢复
  | { reason: 'stop_hook_blocking' }           // stop hook 阻塞
  | { reason: 'token_budget_continuation' }    // token 预算继续
```

### 3.5 工具执行集成

```typescript
// 工具结果归一化
toolResults.push(...normalizeMessagesForAPI([result.message], tools))

// 流式 vs 普通工具执行
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

### 3.6 Query Chain 追踪

```typescript
// 每个查询链有唯一的 chainId，支持嵌套子 Agent 追踪
const queryTracking = toolUseContext.queryTracking
  ? { chainId: toolUseContext.queryTracking.chainId, depth: toolUseContext.queryTracking.depth + 1 }
  : { chainId: deps.uuid(), depth: 0 }
```

---

## 4. 任务调度

### 4.1 LocalShellTask — Bash 任务

- spawn: 创建子进程执行命令
- kill: 发送信号终止进程
- outputFile: 持久化命令输出到磁盘

### 4.2 LocalAgentTask — 本地 Agent

- 使用 AgentTool 派生子 Agent
- 子 Agent 在同一进程内执行（通过 query() 递归）
- 支持 `agentId` 追踪

### 4.3 RemoteAgentTask — 远程 Agent

- 通过远程协议与外部 Agent 通信
- 适用于云端/分布式场景

### 4.4 DreamTask — 异步任务

- 用于不需要等待结果的后台任务
- 结果通过 task-notification 异步通知

### 4.5 InProcessTeammateTask — 进程内队友

- 支持多 Agent 在同一进程内通信
- 使用队列传递消息

---

## 5. 状态机关键设计

### 5.1 终端状态判断

```typescript
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

用于：
- 防止向已死亡队友注入消息
- 从 AppState 中驱逐已完成任务
- 孤立任务清理路径

### 5.2 工具权限模式

```typescript
type PermissionMode = 'bypass' | 'plan' | 'review' | 'auto' | ' refused'
```

决定模型在工具执行前是否需要用户确认。

### 5.3 模型回退机制

```typescript
catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    currentModel = fallbackModel
    attemptWithFallback = true
    // 清除之前的 assistant messages，重新请求
    continue
  }
}
```

### 5.4 Prompt Too Long 恢复路径

1. **Context Collapse 排出**（优先，廉价，保持细粒度上下文）
2. **Reactive Compact**（次选，全量摘要）
3. **Surface Error**（恢复失败，暴露错误）

---

## 6. 关键设计洞察

1. **AsyncGenerator 作为状态机**：query() 用 AsyncGenerator 实现状态机，每次 yield 都是一个中间状态检查点，支持中断恢复。

2. **Task 是通用抽象**：所有执行单元（Bash、Agent、Workflow）都实现同一 Task 接口，通过 `type` 区分行为。

3. **输出持久化**：`outputFile + outputOffset` 模式支持任务输出的实时消费（tail -f 风格）。

4. **分层恢复策略**：Prompt Too Long 有多层恢复机制，按代价排序（折叠 < 摘要 < 错误暴露）。

5. **Query Chain 追踪**：chainId + depth 支持嵌套 Agent 的完整调用链追踪。

6. **Feature Flag 驱动的任务类型**：Task 类型通过 `feature()` gate 动态注册，支持灰度发布。
