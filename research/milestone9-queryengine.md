# Milestone 9: QueryEngine.ts 深度研究

## 文件概览

- **路径**: `~/Desktop/claude-code-main/src/QueryEngine.ts`
- **大小**: ~46KB, 约1296行
- **职责**: 核心查询引擎，管理对话生命周期和会话状态

---

## 架构总览

### 核心类: `QueryEngine`

```typescript
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]      // 会话消息历史
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage     // API使用量累计
  private hasHandledOrphanedPermission: boolean
  private readFileState: FileStateCache
  private discoveredSkillNames: Set<string>   // 技能发现追踪
  private loadedNestedMemoryPaths: Set<string> // 嵌套记忆路径
}
```

**每个对话一个 QueryEngine 实例**，状态（消息、文件缓存、使用量）在多次提交间持久化。

---

## QueryEngineConfig 配置项

```typescript
export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn          // 工具使用权限检查
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string        // 自定义系统提示词
  appendSystemPrompt?: string       // 追加系统提示词
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number                 // 最大轮次
  maxBudgetUsd?: number             // USD预算上限
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>  // 结构化输出schema
  verbose?: boolean
  replayUserMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean  // 部分消息流
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  snipReplay?: (...) => { messages: Message[]; executed: boolean } | undefined
}
```

---

## `submitMessage()` 核心流程 (AsyncGenerator)

### 阶段1: 初始化

```typescript
async *submitMessage(prompt, options?): AsyncGenerator<SDKMessage> {
  // 1. 清理技能发现集合（每轮重置）
  this.discoveredSkillNames.clear()
  setCwd(cwd)
  const persistSession = !isSessionPersistenceDisabled()
  const startTime = Date.now()
}
```

### 阶段2: 包装 canUseTool (追踪权限拒绝)

```typescript
const wrappedCanUseTool: CanUseToolFn = async (tool, input, ...) => {
  const result = await canUseTool(tool, ...)
  if (result.behavior !== 'allow') {
    this.permissionDenials.push({
      tool_name: sdkCompatToolName(tool.name),
      tool_use_id: toolUseID,
      tool_input: input,
    })
  }
  return result
}
```

### 阶段3: 构建系统提示词

```typescript
const {
  defaultSystemPrompt,
  userContext: baseUserContext,
  systemContext,
} = await fetchSystemPromptParts({ tools, mainLoopModel, mcpClients, ... })

// 追加协作者上下文
const userContext = {
  ...baseUserContext,
  ...getCoordinatorUserContext(mcpClients, scratchpadDir),
}

// 追加记忆力学提示词（cowork模式）
const memoryMechanicsPrompt = customPrompt !== undefined && hasAutoMemPathOverride()
  ? await loadMemoryPrompt()
  : null

// 组合最终系统提示词
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

### 阶段4: 构建 ProcessUserInputContext

```typescript
let processUserInputContext: ProcessUserInputContext = {
  messages: this.mutableMessages,
  setMessages: fn => { this.mutableMessages = fn(this.mutableMessages) },
  options: {
    commands, tools, verbose, mainLoopModel, thinkingConfig,
    mcpClients, mcpResources: {}, ideInstallationStatus: null,
    isNonInteractiveSession: true,
    agentDefinitions: { activeAgents: agents, allAgents: [] },
    theme: resolveThemeSetting(getGlobalConfig().theme),
    maxBudgetUsd,
  },
  getAppState, setAppState,
  abortController: this.abortController,
  readFileState: this.readFileState,
  nestedMemoryAttachmentTriggers: new Set<string>(),
  loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
  dynamicSkillDirTriggers: new Set<string>(),
  discoveredSkillNames: this.discoveredSkillNames,
  updateFileHistoryState: ...,
  updateAttributionState: ...,
}
```

### 阶段5: 处理孤立权限 (仅一次)

```typescript
if (orphanedPermission && !this.hasHandledOrphanedPermission) {
  this.hasHandledOrphanedPermission = true
  for await (const message of handleOrphanedPermission(...)) {
    yield message
  }
}
```

### 阶段6: processUserInput (用户输入预处理)

```typescript
const {
  messages: messagesFromUserInput,
  shouldQuery,
  allowedTools,
  model: modelFromUserInput,
  resultText,
} = await processUserInput({ input: prompt, mode: 'prompt', ... })

this.mutableMessages.push(...messagesFromUserInput)
```

### 阶段7: 转录本预写 (关键!)

```typescript
// 在API响应前写用户消息 → 支持 --resume
if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
  if (isBareMode()) {
    void transcriptPromise  // 脚本模式: fire-and-forget
  } else {
    await transcriptPromise
    if (isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) || ...) {
      await flushSessionStorage()
    }
  }
}
```

> **注释原文**: "If the process is killed before [API response], the transcript is left with only queue-operation entries; getLastSessionLog filters those out, returns null, and --resume fails. Writing now makes the transcript resumable from the point the user message was accepted, even if no API response ever arrives."

### 阶段8: 发送 SystemInitMessage

```typescript
yield buildSystemInitMessage({
  tools, mcpClients, model: mainLoopModel,
  permissionMode, commands, agents, skills, plugins, fastMode,
})
```

### 阶段9: 查询循环 (`query()`)

```typescript
for await (const message of query({
  messages, systemPrompt, userContext, systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns, taskBudget,
})) {
  // 消息处理...
}
```

---

## 消息类型处理 (switch)

| 消息类型 | 处理方式 |
|---------|---------|
| `tombstone` | 跳过（控制信号） |
| `assistant` | `normalizeMessage` → yield; 更新 `lastStopReason` |
| `progress` | `normalizeMessage` → yield; 记录到转录本 |
| `user` | `normalizeMessage` → yield; turnCount++ |
| `stream_event` | 累积 usage (`message_start`, `message_delta`, `message_stop`) |
| `attachment` | 提取结构化输出; 处理 `max_turns_reached` |
| `stream_request_start` | 不yield |
| `system` | 处理 `compact_boundary`（内存压缩）; 处理 `api_error` |

---

## 结果类型

```typescript
// 成功结果
yield {
  type: 'result',
  subtype: 'success',
  duration_ms, duration_api_ms, num_turns,
  result: textResult,
  stop_reason: lastStopReason,
  total_cost_usd, usage, modelUsage,
  permission_denials, structured_output,
  fast_mode_state, uuid,
}

// 错误子类型
subtype: 'error_max_turns' | 'error_max_budget_usd' |
         'error_max_structured_output_retries' | 'error_during_execution'
```

---

## 关键设计模式

### 1. AsyncGenerator 架构
- `submitMessage` 是 async generator，逐条 yield SDKMessage
- 消费者（ask()包装函数）逐条处理消息，支持流式UI更新

### 2. 可选压缩 (HISTORY_SNIP feature)
```typescript
const snipModule = feature('HISTORY_SNIP')
  ? require('./services/compact/snipCompact.js')
  : null
// snipReplay 回调在compact boundary时注入，裁剪旧消息
```

### 3. 文件历史快照
```typescript
if (fileHistoryEnabled() && persistSession) {
  messagesFromUserInput
    .filter(messageSelector().selectableUserMessagesFilter)
    .forEach(message => {
      void fileHistoryMakeSnapshot(setAppState, message.uuid)
    })
}
```

### 4. 工具权限追踪
- `wrappedCanUseTool` 包装原始 `canUseTool`，追踪所有拒绝
- 拒绝列表在最终结果中返回给 SDK

### 5. 结构化输出支持
```typescript
if (jsonSchema && hasStructuredOutputTool) {
  registerStructuredOutputEnforcement(setAppState, getSessionId())
}
// 追踪 SYNTHETIC_OUTPUT_TOOL_NAME 调用次数
const initialStructuredOutputCalls = jsonSchema
  ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
  : 0
```

### 6. Coordinator Mode (条件编译)
```typescript
const getCoordinatorUserContext = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
```

---

## `ask()` 便捷函数

```typescript
// QueryEngine的便捷包装，用于一次性查询
export async function* ask({
  commands, prompt, promptUuid, isMeta, cwd, tools, mcpClients,
  verbose, thinkingConfig, maxTurns, maxBudgetUsd, taskBudget,
  canUseTool, mutableMessages = [],
  // ... 更多配置
}): AsyncGenerator<SDKMessage> {
  const engine = new QueryEngine({ ... })
  yield* engine.submitMessage(prompt, { uuid: promptUuid, isMeta })
}
```

---

## 与 Python 版本的对比

| 特性 | TypeScript (QueryEngine.ts) | Python (query_engine.py) |
|-----|---------------------------|-------------------------|
| 架构 | AsyncGenerator class | @dataclass + 普通方法 |
| 消息处理 | `yield* normalizeMessage()` | `_format_output()` 简单文本 |
| 权限追踪 | `wrappedCanUseTool` 装饰器模式 | `permission_denials` 列表 |
| 使用量 | `accumulateUsage` / `updateUsage` | `UsageSummary.add_turn()` |
| 压缩 | `splice(0, boundaryIdx)` | `mutable_messages[-N:]` 切片 |
| 流式事件 | `stream_event` 类型 | `stream_submit_message` yield字典 |
| 结构化输出 | `structuredOutputFromTool` 提取 | `_render_structured_output()` JSON |
| feature gate | `feature('FLAG')` 条件导入 | 无（纯Python） |

---

## 重要注释摘录

### 转录本预写 (最关键的设计决策之一)
```typescript
// "If the process is killed before [API response], the transcript is left with 
// only queue-operation entries...Writing now makes the transcript resumable 
// from the point the user message was accepted, even if no API response ever arrives."
```

### Compact Boundary 内存管理
```typescript
// "Release pre-compaction messages for GC. The boundary was just pushed so it's
// the last element. query.ts already uses getMessagesAfterCompactBoundary()
// internally, so only post-boundary messages are needed going forward."
```

### turnCount vs num_turns
```typescript
// turnCount 在每次 user 消息后 ++，但 num_turns 是 messages.length - 1
// 这两者在compact后可能不一致
```

---

## 结论

`QueryEngine.ts` 是 Claude Code 的**核心引擎**，承担：
1. 对话生命周期管理（多轮对话状态持久化）
2. SDK消息的生成式流式返回（AsyncGenerator）
3. 权限追踪和拒绝收集
4. 使用量累计和预算控制
5. 转录本管理和 --resume 支持
6. 历史压缩（compact boundary）
7. 结构化输出支持

Python 版本 (`query_engine.py`) 是**功能性移植**，保持了数据结构和方法签名，但省略了 AsyncGenerator 架构、消息规范化、流式事件等复杂逻辑，用简单的文本输出替代。
