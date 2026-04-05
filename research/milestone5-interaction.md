# Claude Code 交互模式详解

## 概述

Claude Code 的交互模式包含：
- **命令队列管理**: 优先级队列处理用户输入和系统消息
- **斜杠命令**: `/compact`, `/help` 等本地命令
- **中断处理**: 工具执行期间的用户中断
- **消息流**: prompt → queue → process → response

---

## 命令队列管理

**文件**: `src/utils/messageQueueManager.ts`

### 队列结构

```typescript
// 模块级队列
const commandQueue: QueuedCommand[] = []
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

// 命令类型
type QueuedCommand = {
  type: string
  value: string | ContentBlockParam[]
  mode: PromptInputMode
  priority?: QueuePriority
  agentId?: string
  origin?: {
    kind: 'channel' | 'task' | 'command'
  }
  isMeta?: boolean
  skipSlashCommands?: boolean
  pastedContents?: Record<string, PastedContent>
}

// 优先级
type QueuePriority = 'now' | 'next' | 'later'
```

### 优先级机制

```typescript
const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,   // 最高：立即处理
  next: 1,  // 普通：下一轮处理
  later: 2, // 最低：最后处理
}

// 入队
function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
}

// 任务通知入队 (低优先级)
function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' })
  notifySubscribers()
}
```

### 出队逻辑

```typescript
function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  // 找最高优先级 (数值最小) 的命令
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined

  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  return dequeued
}
```

### React 集成

```typescript
// useSyncExternalStore 接口
export const subscribeToCommandQueue = queueChanged.subscribe

export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// 触发更新
function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}
```

### 可编辑命令

```typescript
const NON_EDITABLE_MODES = new Set<PromptInputMode>([
  'task-notification',
])

export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta
}

export function isQueuedCommandVisible(cmd: QueuedCommand): boolean {
  // KAIROS channels 显示但不可编辑
  if (feature('KAIROS') && cmd.origin?.kind === 'channel') {
    return true
  }
  return isQueuedCommandEditable(cmd)
}
```

### 批量弹出

```typescript
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number,
): PopAllEditableResult | undefined {
  const { editable = [], nonEditable = [] } = objectGroupBy(
    [...commandQueue],
    cmd => (isQueuedCommandEditable(cmd) ? 'editable' : 'nonEditable'),
  )

  if (editable.length === 0) {
    return undefined
  }

  // 合并文本
  const queuedTexts = editable.map(cmd => extractTextFromValue(cmd.value))
  const newInput = [...queuedTexts, currentInput].filter(Boolean).join('\n')
  
  // 计算光标位置
  const cursorOffset = queuedTexts.join('\n').length + 1 + currentCursorOffset

  // 提取图片
  const images: PastedContent[] = []
  for (const cmd of editable) {
    if (cmd.pastedContents) {
      images.push(...Object.values(cmd.pastedContents).filter(c => c.type === 'image'))
    }
  }

  // 保留非编辑命令
  commandQueue.length = 0
  commandQueue.push(...nonEditable)
  notifySubscribers()

  return { text: newInput, cursorOffset, images }
}
```

---

## 斜杠命令实现

### 命令定义格式

**文件**: `src/commands/compact/index.ts`

```typescript
const compact = {
  type: 'local',
  name: 'compact',
  description: 'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '<optional custom summarization instructions>',
  load: () => import('./compact.js'),
} satisfies Command
```

### 命令类型

```typescript
type Command = {
  type: 'prompt' | 'local' | 'builtin'
  name: string
  description: string
  isEnabled?: () => boolean
  supportsNonInteractive?: boolean
  argumentHint?: string
  argumentNames?: string[]
  load?: () => Promise<any>
  execute?: (args: string, context: ToolUseContext) => Promise<CommandResult>
}
```

### 命令处理

**文件**: `src/utils/processSlashCommand.ts` (推断)

```typescript
function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}

// 命令路由
async function processSlashCommand(
  commandText: string,
  context: ToolUseContext,
): Promise<CommandResult> {
  const [commandName, ...args] = commandText.slice(1).split(/\s+/)
  
  const command = findCommand(commandName)
  if (!command) {
    throw new Error(`Unknown command: /${commandName}`)
  }
  
  if (!command.isEnabled?.()) {
    throw new Error(`Command not available: /${commandName}`)
  }
  
  const argsString = args.join(' ')
  
  // 本地命令动态加载
  if (command.type === 'local' && command.load) {
    const mod = await command.load()
    return mod.default.call(argsString, context)
  }
  
  // 内置命令直接执行
  if (command.execute) {
    return command.execute(argsString, context)
  }
  
  throw new Error(`Command not executable: /${commandName}`)
}
```

---

## /compact 命令详解

**文件**: `src/commands/compact/compact.ts`

### 执行流程

```typescript
export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // 1. 获取压缩边界后的消息
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const customInstructions = args.trim()

  try {
    // 2. 优先尝试 Session Memory 压缩
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(
        messages,
        context.agentId,
      )
      if (sessionMemoryResult) {
        // 成功，清理并返回
        return { type: 'compact', compactionResult: sessionMemoryResult }
      }
    }

    // 3. 尝试 Reactive 压缩 (如果启用)
    if (reactiveCompact?.isReactiveOnlyMode()) {
      return await compactViaReactive(...)
    }

    // 4. 回退到传统压缩
    // 4a. 先运行 microcompact 减少 token
    const microcompactResult = await microcompactMessages(messages, context)
    
    // 4b. 执行压缩
    const result = await compactConversation(
      messagesForCompact,
      context,
      await getCacheSharingParams(context, messagesForCompact),
      false,  // 不静默
      customInstructions,
      false,  // 非自动压缩
    )

    return { type: 'compact', compactionResult: result }
  } catch (error) {
    // 错误处理
  }
}
```

### /compact 返回类型

```typescript
type CompactResult = {
  type: 'compact'
  compactionResult: CompactionResult
  displayText: string
}
```

---

## 中断处理

### 工具级中断

**文件**: `src/Tool.ts`

```typescript
type Tool = {
  // 工具运行期间用户输入的处理方式
  interruptBehavior?(): 'cancel' | 'block'
  // 'cancel': 停止工具，丢弃结果
  // 'block': 继续运行，新消息等待
}
```

### 工具结果配对

```typescript
// 严格模式
export function ensureToolResultPairing(
  assistantMessage: AssistantMessage,
  toolResults: ToolResultBlockParam[],
): void {
  // 验证每个 tool_use_id 都有对应的 tool_result
  // 缺失则抛出错误 (严格模式)
}

// 非严格模式
function repairToolResultPairing(
  assistantMessage: AssistantMessage,
  toolResults: ToolResultBlockParam[],
): ToolResultBlockParam[] {
  // 缺失的 tool_result 用占位符替换
}
```

### AbortController 集成

```typescript
async function executeTool(
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
): Promise<ToolResult> {
  const { abortController } = context
  
  try {
    const result = await tool.call(input, context, canUseTool, parentMessage)
    return result
  } catch (error) {
    if (abortController.signal.aborted) {
      // 用户中断
      throw new Error('Operation cancelled')
    }
    throw error
  }
}
```

---

## 消息流转

### 消息类型

```typescript
type Message = {
  type: 'user' | 'assistant' | 'system' | 'compact_boundary'
  message: {
    id: string
    content: ContentBlock[]
    role?: string
    timestamp: string
  }
  uuid: string
}

type ContentBlock = 
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock
```

### Prompt Input Mode

```typescript
type PromptInputMode = 
  | 'edit'           // 普通编辑模式
  | 'insert'         // 插入模式
  | 'task-notification'  // 任务通知
  | 'resume'         // 恢复会话
  | 'attach'         // 附加文件
  | 'reply'          // 回复
```

---

## 状态追踪

### Bootstrap State

**文件**: `src/bootstrap/state.ts`

```typescript
type State = {
  // ...
  
  // 当前 prompt ID
  promptId: string | null
  
  // 最后 API 请求 ID
  lastMainRequestId: string | undefined
  
  // 压缩后标记
  pendingPostCompaction: boolean
  
  // API 完成时间戳
  lastApiCompletionTimestamp: number | null
}

// 更新机制
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}
```

---

## 交互信号系统

### Signal 实现

```typescript
type SignalListener = () => void

class Signal<T extends any[]> {
  private listeners: Set<SignalListener> = new Set()

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(...args: T): void {
    for (const listener of this.listeners) {
      listener(...args)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
```

### 使用场景

```typescript
// 命令队列变更
const queueChanged = createSignal<[]>()

// Skill 加载完成
const skillsLoaded = createSignal<[]>()
export function onDynamicSkillsLoaded(callback: () => void): () => void {
  return skillsLoaded.subscribe(() => {
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
}

// Session 切换
const sessionSwitched = createSignal<[id: SessionId]>()
```

---

## OpenClaw 改进建议

### 1. 命令队列优先级

```typescript
type QueuePriority = 'immediate' | 'normal' | 'background'

// 优先级队列设计
class CommandQueue {
  private queues: Map<QueuePriority, QueuedCommand[]> = new Map([
    ['immediate', []],
    ['normal', []],
    ['background', []],
  ])

  enqueue(cmd: QueuedCommand): void {
    const priority = cmd.priority ?? 'normal'
    this.queues.get(priority)!.push(cmd)
  }

  dequeue(): QueuedCommand | undefined {
    // 优先处理 immediate
    for (const priority of ['immediate', 'normal', 'background']) {
      const queue = this.queues.get(priority)!
      if (queue.length > 0) {
        return queue.shift()
      }
    }
    return undefined
  }
}
```

### 2. 斜杠命令注册表

```typescript
interface CommandRegistry {
  local: Map<string, LocalCommand>
  builtin: Map<string, BuiltinCommand>
}

interface LocalCommand {
  name: string
  description: string
  argumentHint?: string
  execute(args: string, context: Context): Promise<Result>
}

interface BuiltinCommand {
  name: string
  description: string
  // 直接内置实现
}

// 动态加载
async function loadCommand(name: string): Promise<Command> {
  const path = findCommandFile(name)
  return import(path)
}
```

### 3. 中断处理策略

```typescript
type InterruptStrategy = 'cancel' | 'block' | 'queue'

interface Tool {
  interruptBehavior?: InterruptStrategy
  
  // 取消令牌
  cancelToken?: CancelToken
}

interface CancelToken {
  isCancelled: boolean
  cancel(): void
}

// 执行时检查
async function executeWithInterrupt(
  tool: Tool,
  input: unknown,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) {
    throw new Error('Cancelled before start')
  }
  
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      if (tool.interruptBehavior === 'cancel') {
        reject(new Error('Cancelled'))
      }
    })
    
    tool.execute(input).then(resolve).catch(reject)
  })
}
```

### 4. 消息队列 React 集成

```typescript
// useSyncExternalStore 模式
function useCommandQueue() {
  const queue = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )
  
  return queue
}

// 可编辑命令弹出
function useEditableCommands() {
  const [state, setState] = useState({
    text: '',
    cursorOffset: 0,
    images: [] as Image[],
  })
  
  // UP/ESC 键处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'Escape') {
        const result = popAllEditable(currentInput, cursorOffset)
        if (result) {
          setState(result)
        }
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
  
  return state
}
```

### 5. 命令行参数解析

```typescript
interface CommandArgument {
  name: string
  required: boolean
  default?: string
  description?: string
}

interface CommandSchema {
  name: string
  arguments: CommandArgument[]
}

function parseCommandArgs(
  input: string,
  schema: CommandSchema,
): Record<string, string> {
  const parts = input.trim().split(/\s+/)
  const args: Record<string, string> = {}
  
  for (let i = 0; i < schema.arguments.length; i++) {
    const arg = schema.arguments[i]
    const value = parts[i]
    
    if (!value && !arg.required) {
      args[arg.name] = arg.default ?? ''
    } else if (!value && arg.required) {
      throw new Error(`Missing required argument: ${arg.name}`)
    } else {
      args[arg.name] = value
    }
  }
  
  return args
}

// 示例
const compactCommand: CommandSchema = {
  name: 'compact',
  arguments: [
    {
      name: 'instructions',
      required: false,
      default: '',
      description: 'Custom summarization instructions',
    },
  ],
}
```

### 6. 命令执行结果处理

```typescript
type CommandResult = 
  | { type: 'success'; displayText: string; messages?: Message[] }
  | { type: 'error'; message: string }
  | { type: 'compact'; compactionResult: CompactionResult }
  | { type: 'redirect'; url: string }

// 格式化输出
function formatCommandResult(result: CommandResult): string {
  switch (result.type) {
    case 'success':
      return chalk.green(result.displayText)
    case 'error':
      return chalk.red(result.message)
    case 'compact':
      return chalk.dim('Compacted')
    case 'redirect':
      return result.url
  }
}
```

### 7. 状态信号系统

```typescript
class StateSignal<T> {
  private value: T
  private listeners: Set<(value: T) => void> = new Set()

  constructor(initialValue: T) {
    this.value = initialValue
  }

  get(): T {
    return this.value
  }

  set(newValue: T): void {
    this.value = newValue
    this.notify()
  }

  update(fn: (value: T) => T): void {
    this.value = fn(this.value)
    this.notify()
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.value)
    }
  }
}

// 使用
const promptIdSignal = new StateSignal<string | null>(null)
```
