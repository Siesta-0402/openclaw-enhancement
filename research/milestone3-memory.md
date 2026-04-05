# Claude Code Memory 系统详解

## 概述

Claude Code 的 memory 系统采用文件持久化设计，核心是 `memdir.ts` 模块。系统支持：
- **auto memory**: 自动会话记忆
- **team memory**: 团队共享记忆
- **agent memory**: Agent 专属记忆

---

## 核心设计

### MEMORY.md 入口点

**文件**: `src/memdir/memdir.ts`

```
memory/
  MEMORY.md        # 索引文件
  user_role.md     # 用户角色记忆
  preferences.md   # 偏好记忆
  project/         # 项目子目录
    architecture.md
```

### 索引文件格式

```typescript
// MEMORY.md 示例
# auto memory

## Memory types

...

## How to save memories

1. Write each memory to its own file with frontmatter
2. Add pointer to MEMORY.md index

## MEMORY.md

- [User Role](user_role.md) — Senior engineer, prefers TypeScript
- [Project Architecture](project/architecture.md) — Microservices with API gateway
```

### Frontmatter 格式

```typescript
const MEMORY_FRONTMATTER_EXAMPLE = `
---
name: Memory Title
description: Brief description of this memory
type: user | feedback | project | reference
---
`.trim().split('\n')
```

### Memory 类型分类

```typescript
// 四大类型
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

// user: 用户身份、偏好、习惯
// feedback: 用户反馈、修正
// project: 项目上下文
// reference: 参考信息
```

---

## 目录结构规范

```typescript
const MEMORY_FRONTMATTER_EXAMPLE = [
  '---',
  'name: Memory Title',
  'description: Brief description of this memory',
  'type: user | feedback | project | reference',
  '---',
]
```

---

## 行为指令构建

### buildMemoryLines

```typescript
function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        'Write each memory to its own file with frontmatter format:',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '- Keep index entries concise (one line, ~150 chars)',
        '- Organize semantically, not chronologically',
      ]
    : [
        '## How to save memories',
        'Two-step process:',
        '1. Write memory to own file with frontmatter',
        '2. Add pointer to MEMORY.md index',
      ]

  return [
    `# ${displayName}`,
    '',
    `You have a persistent memory system at \`${memoryDir}\`. This directory already exists.`,
    '',
    ...TYPES_SECTION,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    // 区分 memory、plan、tasks 的使用场景
  ]
}
```

### 关键原则

```typescript
const WHAT_NOT_TO_SAVE_SECTION = `## What not to save

Content derivable from the current project state (code patterns, architecture, git history) should NOT be saved to memory. Focus on:
- User preferences and habits
- Feedback and corrections
- Context not in code (deadlines, incidents, decisions)
- External system pointers (dashboards, projects, channels)`
```

---

## Session Memory (会话记忆)

### KAIROS 模式：每日日志

```typescript
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  return [
    '# auto memory',
    `Persistent memory at: \`${memoryDir}\``,
    '',
    'Record memories by **appending** to today\'s daily log:',
    `\`${logPathPattern}\``,
    '',
    'Write each entry as a short timestamped bullet.',
    'Create file on first write. Do NOT rewrite or reorganize — append-only.',
    '',
    '## What to log',
    '- User corrections ("use bun, not npm")',
    '- Facts about user, role, goals',
    '- Project context not derivable from code',
    '- Pointers to external systems',
  ]
}
```

### Session Memory 提取

**文件**: `src/services/SessionMemory/sessionMemoryUtils.ts`

```typescript
// 获取 session memory 内容
async function getSessionMemoryContent(): Promise<string | null>

// 获取最后摘要的消息 ID
function getLastSummarizedMessageId(): string | null

// 等待 session memory 提取完成
async function waitForSessionMemoryExtraction(): Promise<void>
```

### Session Memory 压缩

**文件**: `src/services/compact/sessionMemoryCompact.ts`

```typescript
// 配置
const DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}

// 计算需要保留的消息索引
function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
): number {
  // 从 lastSummarizedIndex 开始
  // 向后扩展直到满足 minTokens 和 minTextBlockMessages
  // 不得超过 maxTokens
  // 保证 tool_use/tool_result 配对不拆分
}
```

---

## Team Memory (团队记忆)

### 条件

```typescript
// 需要同时启用 auto memory 和 team memory
const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE('tengu_session_memory', false)
const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE('tengu_sm_compact', false)
const shouldUse = sessionMemoryFlag && smCompactFlag
```

### 路径结构

```
autoMemPath/
  team/           # 团队共享目录
    MEMORY.md
    project-context.md
    coding-standards.md
```

---

## Memory 与其他持久化机制的区别

```typescript
// 区分原则

// Memory: 跨会话回忆，适用于：
// - 用户偏好 ("use bun, not npm")
// - 身份信息 (角色、目标)
// - 项目上下文 (决策、deadline)

// Plan: 当前会话内的计划
// - 开始非平凡实现前对齐
// - 改变方法后更新

// Tasks: 当前会话内的工作跟踪
// - 需要拆分的离散步骤
// - 进度跟踪
```

---

## Bootstrap 状态管理

**文件**: `src/bootstrap/state.ts`

### Memory 相关状态

```typescript
type State = {
  // ...
  
  // 调用的 skills 追踪 (用于压缩时保留)
  invokedSkills: Map<string, InvokedSkillInfo>
  
  // System prompt section 缓存
  systemPromptSectionCache: Map<string, string | null>
  
  // CLAUDE.md 缓存 (用于 auto-mode classifier)
  cachedClaudeMdContent: string | null
}
```

### Invoked Skills 追踪

```typescript
type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

// 添加调用的 skill
function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void

// 获取 agent 的 skills
function getInvokedSkillsForAgent(agentId: string | undefined | null): Map<string, InvokedSkillInfo>

// 清理 (可选保留某些 agent)
function clearInvokedSkills(preservedAgentIds?: ReadonlySet<string>): void
```

---

## 加载流程

```typescript
async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()
  
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    // KAIROS 模式：每日日志
    return buildAssistantDailyLogPrompt()
  }
  
  if (feature('TEAMMEM')) {
    if (teamMemPaths.isTeamMemoryEnabled()) {
      const autoDir = getAutoMemPath()
      const teamDir = teamMemPaths.getTeamMemPath()
      await ensureMemoryDirExists(teamDir)
      return teamMemPrompts.buildCombinedMemoryPrompt()
    }
  }
  
  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    await ensureMemoryDirExists(autoDir)
    return buildMemoryLines('auto memory', autoDir).join('\n')
  }
  
  return null
}
```

---

## 目录存在性保障

```typescript
async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)  // 递归创建
  } catch (e) {
    // EEXIST 已由 fs.mkdir 内部处理
    // 其他错误 (EACCES/EPERM/EROFS) 记录日志但不阻塞
    logForDebugging(`ensureMemoryDirExists failed: ${e}`)
  }
}
```

---

## Token 预算管理

```typescript
const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25_000

function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  return {
    content: truncated + '\n\n> WARNING: MEMORY.md truncated...',
    // ...
  }
}
```

---

## OpenClaw 改进建议

### 1. 文件化 Memory 系统

```
memory/
  MEMORY.md          # 索引入口
  user.md            # 用户信息
  project/           # 项目子目录
    context.md
    decisions.md
  daily/             # 每日日志 (可选)
    2024-01-15.md
```

```typescript
interface MemoryEntry {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  path: string
  lastUpdated: Date
}

// 加载所有 memory entries
async function loadMemoryIndex(): Promise<MemoryEntry[]>
```

### 2. 分类记忆类型

```typescript
type MemoryType = 
  | 'user'      // 用户身份、偏好
  | 'feedback'  // 反馈、修正
  | 'project'   // 项目上下文
  | 'reference' // 参考信息

interface MemoryFile {
  frontmatter: {
    name: string
    description: string
    type: MemoryType
  }
  content: string
}
```

### 3. 保留调用 Skills

压缩时保留已调用的 skills 是个好设计：

```typescript
// 追踪已调用的 skills
const invokedSkills = new Map<string, SkillInfo>()

// 压缩时保留
function preserveInvokedSkills(compactResult: CompactionResult) {
  const skills = Array.from(invokedSkills.values())
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .slice(0, MAX_SKILLS)
    .map(skill => ({
      name: skill.name,
      path: skill.path,
      content: truncate(skill.content, MAX_TOKENS_PER_SKILL),
    }))
  
  return { type: 'invoked_skills', skills }
}
```

### 4. 区分不同持久化机制

```typescript
// 明确使用场景

interface Memory {
  // 用于跨会话回忆
  // 用户偏好、项目上下文、团队知识
}

interface Plan {
  // 用于当前会话
  // 需要用户对齐的实现计划
}

interface Tasks {
  // 用于当前会话
  // 需要跟踪的工作进度
}
```

### 5. 索引文件限制

```typescript
const MEMORY_INDEX_CONFIG = {
  maxLines: 200,
  maxBytes: 25_000,
  maxEntryLength: 150,  // 每行最多字符
}

// 超限警告
function checkMemoryIndexSize(indexContent: string): Warning | null
```

### 6. 自动发现与加载

```typescript
async function loadMemoryPrompt(): Promise<string | null> {
  // 1. 读取 MEMORY.md 索引
  // 2. 解析 frontmatter 获取所有 entry
  // 3. 按类型组织
  // 4. 构建系统 prompt
  
  const index = await loadMemoryIndex()
  const userMemories = index.filter(e => e.type === 'user')
  const projectMemories = index.filter(e => e.type === 'project')
  
  return buildMemoryPrompt({ userMemories, projectMemories })
}
```

### 7. Session Memory 轻量化

如果不需要完整的 session memory 系统，可以用更简单的设计：

```typescript
// 轻量方案：只保留最近的 key context
const SESSION_MEMORY_CONFIG = {
  maxTokens: 40_000,
  minMessages: 5,
  
  // 保留最近 N 个 API round 的摘要
  preserveRecentRounds: 3,
}
```
