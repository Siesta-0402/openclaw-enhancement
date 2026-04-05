# Claude Code 四级压缩机制详解

## 概述

Claude Code 实现了四级压缩机制，用于管理对话上下文长度：

1. **Microcompact** (微压缩) - 工具结果清理
2. **Auto-compact** (自动压缩) - 阈值触发
3. **Session Memory Compaction** (会话记忆压缩)
4. **Full Compaction** (完全压缩) - 传统 summarization

---

## 第一级：Microcompact (微压缩)

### 时间触发的微压缩 (Time-Based MC)

**文件**: `src/services/compact/microCompact.ts`

当距离上一条 assistant 消息的时间超过阈值时，清理旧工具结果：

```typescript
// 配置参数
interface TimeBasedMCConfig {
  enabled: boolean
  gapThresholdMinutes: number  // 默认 50 分钟
  keepRecent: number            // 默认 5 个工具结果
}
```

**机制**：
- 收集所有可压缩工具的 tool_use_id (FileRead, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write)
- 保留最近的 N 个 (keepRecent)，其余替换为 `[Old tool result content cleared]`
- 直接修改消息内容，不走 API

### 缓存微压缩 (Cached MC)

**触发条件**：
- 主线程 (`repl_main_thread`)
- 支持 cache editing 的模型
- 计数阈值达到 (`triggerThreshold`, `keepRecent`)

**关键差异**：
- **不修改本地消息内容**
- 通过 `cache_reference` + `cache_edits` 在 API 层操作
- 保持服务端 prompt cache 不失效

**API 层实现**：
```typescript
// 1. 注册工具结果到状态机
registerToolResult(state, tool_use_id)
registerToolMessage(state, groupIds)

// 2. 获取需要删除的工具
const toolsToDelete = getToolResultsToDelete(state)

// 3. 创建 cache_edits block 发送给 API
const cacheEdits = createCacheEditsBlock(state, toolsToDelete)
```

---

## 第二级：Auto-compact (自动压缩)

**文件**: `src/services/compact/autoCompact.ts`

### 阈值计算

```typescript
function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // 13,000
}

function getEffectiveContextWindowSize(model: string): number {
  const contextWindow = getContextWindowForModel(model)
  return contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY  // 20,000
}
```

### 触发判断

```typescript
async function shouldAutoCompact(messages: Message[], model: string): Promise<boolean> {
  const tokenCount = tokenCountWithEstimation(messages)
  const threshold = getAutoCompactThreshold(model)
  return tokenCount >= threshold
}
```

### 安全机制：熔断器

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// 连续失败 3 次后停止重试，避免无效 API 调用
if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
  return { wasCompacted: false }
}
```

---

## 第三级：Session Memory Compaction

**文件**: `src/services/compact/sessionMemoryCompact.ts`

### 配置

```typescript
const DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,        // 最少保留 token 数
  minTextBlockMessages: 5,  // 最少保留的消息数
  maxTokens: 40_000,         // 硬上限
}
```

### 保留策略

```typescript
function calculateMessagesToKeepIndex(messages, lastSummarizedIndex) {
  // 1. 从 lastSummarizedIndex 开始
  // 2. 向后扩展直到满足 minTokens 和 minTextBlockMessages
  // 3. 不得超过 maxTokens
  // 4. 调整边界保证 tool_use/tool_result 不被拆分
}
```

### 关键保障

- **tool_use/tool_result 对不拆分**：调整索引保证配对完整
- **thinking block 合并**：共享 `message.id` 的 assistant 消息需要一起保留
- 使用 session memory 文件内容作为摘要，而不是调用 API

---

## 第四级：Full Compaction (完全压缩)

**文件**: `src/services/compact/compact.ts`

### 流程

1. **Pre-compact Hooks** 执行
2. **图像剥离**：`[image]` 占位符替换实际图片
3. **摘要生成**：
   - Forked agent 路径 (默认，复用 prompt cache)
   - Streaming 路径 (fallback)
4. **工具结果清理**：`context.readFileState.clear()`
5. **附件重建**：
   - 最近读取的文件 (最多 5 个)
   - Plan 附件
   - Skill 附件
   - Agent 状态附件
   - 重新 announce deferred tools/MCP/agents
6. **Post-compact Hooks** 执行
7. **缓存基准重置**：通知 prompt cache break detection

### 图像处理

```typescript
function stripImagesFromMessages(messages: Message[]): Message[] {
  // 替换为 [image] / [document] 占位符
  // 防止压缩请求本身超限
}
```

### 文件恢复

```typescript
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
const POST_COMPACT_TOKEN_BUDGET = 50_000
const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
```

### Skill 保留

```typescript
const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000  // 每个 skill 最大
const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000  // 总预算
```

### 压缩后边界标记

```typescript
interface CompactBoundaryMarker {
  type: 'system' | 'compact_boundary'
  compactMetadata: {
    preCompactTokenCount: number
    preCompactDiscoveredTools?: string[]
    preservedSegment?: {
      headUuid: string
      anchorUuid: string
      tailUuid: string
    }
  }
}
```

---

## Prompt Too Long 处理

**文件**: `src/services/compact/compact.ts`

```typescript
function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage
): Message[] | null {
  // 解析 token gap
  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  
  // 按 API round 分组，丢弃最旧的组
  const groups = groupMessagesByApiRound(messages)
  let dropCount = Math.ceil(groups.length * 0.2)  // 默认丢弃 20%
  
  // 保证首条消息是 user role
  if (sliced[0]?.type === 'assistant') {
    return [createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }), ...sliced]
  }
}
```

---

## OpenClaw 改进建议

### 1. 引入多级压缩架构

当前 OpenClaw 可能只有简单的 context 清理。建议：

```
Level 1: 工具结果清理 (类似 Microcompact)
  → 时间触发：超过 N 分钟无活动，清理旧工具结果
  → 预算触发：工具结果 token 超过阈值

Level 2: 自动压缩 (类似 Auto-compact)  
  → 阈值：context 达到模型窗口的 X%
  → 熔断器：防止反复失败

Level 3: 轻量压缩 (类似 Session Memory)
  → 使用已有 memory 文件作为摘要来源
  → 保留最近的工具/用户交互

Level 4: 完整压缩 (类似 Full Compaction)
  → API 调用生成摘要
  → 保留文件状态、skill 状态
```

### 2. 图像/媒体处理

Claude Code 在压缩前剥离图像值得借鉴：

```typescript
// 压缩前替换图像为占位符
function stripMediaFromMessages(messages) {
  return messages.map(msg => ({
    ...msg,
    content: msg.content.map(block => 
      block.type === 'image' 
        ? { type: 'text', text: '[image]' }
        : block
    )
  }))
}
```

### 3. 缓存感知的设计

Claude Code 的 prompt cache 友好设计：
- Forked agent 路径复用 cache prefix
- Cache editing API 避免 cache 失效
- 压缩后重置 cache 基准，避免误报

### 4. 状态保留机制

压缩时保留关键状态的模式值得借鉴：

```typescript
// 压缩后重建附件
const attachments = [
  ...createPostCompactFileAttachments(recentFiles),
  ...createPlanAttachment(),
  ...createSkillAttachment(),
  ...createAgentStatusAttachment(),
]
```

### 5. 安全机制

- **熔断器**：连续失败 N 次后停止
- **最小保留**：始终保留最后 N 条消息和工具结果
- **配对完整性**：tool_use/tool_result 不能跨压缩边界拆分
