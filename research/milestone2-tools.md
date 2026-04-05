# Claude Code Tool 系统详解

## Tool 元数据格式

**文件**: `src/Tool.ts`

### Tool 类型定义

```typescript
type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  // 基本信息
  name: string
  aliases?: string[]  // 向后兼容的别名
  description(input, options): Promise<string>
  
  // Schema
  inputSchema: Input
  inputJSONSchema?: ToolInputJSONSchema  // MCP 工具直接用 JSON Schema
  outputSchema?: z.ZodType<unknown>
  
  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  
  // 能力标记
  isEnabled(): boolean
  isReadOnly(input): boolean
  isConcurrencySafe(input): boolean
  isDestructive?(input): boolean  // 默认 false
  isMcp?: boolean
  isLsp?: boolean
  
  // 延迟加载
  shouldDefer?: boolean  // 需要 ToolSearch 才能调用
  alwaysLoad?: boolean   // 始终加载，不过 defer
  
  // 行为控制
  interruptBehavior?(): 'cancel' | 'block'  // 工具运行时用户输入如何处理
  
  // 搜索/读取分类
  isSearchOrReadCommand?(input): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  
  isOpenWorld?(input): boolean
  requiresUserInteraction?(): boolean
  
  // 验证与权限
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>
  preparePermissionMatcher?(input): Promise<(pattern: string) => boolean>
  
  // UI 渲染
  getToolUseSummary?(input): string | null  // 简洁摘要
  getActivityDescription?(input): string | null  // 活动描述 (spinner 显示)
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progress, options): React.ReechNode
  renderGroupedToolUse?(toolUses, options): React.ReactNode | null
  
  // 提示词生成
  prompt(options): Promise<string>
  userFacingName(input): string
  
  // 分类输入 (auto-mode 安全分类器)
  toAutoClassifierInput(input): unknown
  
  // 最大结果大小
  maxResultSizeChars: number  // 超过则持久化到磁盘
  
  // 严格模式
  strict?: boolean
  
  // MCP 工具元数据
  mcpInfo?: { serverName: string; toolName: string }
  
  // 输入回填 (observable input)
  backfillObservableInput?(input): void
}
```

### ToolResult 类型

```typescript
type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

### 工具构建器

```typescript
// 默认值工厂函数
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input) => false,  // 默认不安全
  isReadOnly: (_input) => false,
  isDestructive: (_input) => false,
  checkPermissions: (input, _ctx) => ({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input) => '',
  userFacingName: (_input) => '',
}

function buildTool<D extends ToolDef>(def: D): BuiltTool<D> {
  return { ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def }
}
```

---

## 命令分类机制

### Command 类型

**文件**: `src/commands.ts` (从 `src/commands.js` 推断)

```typescript
type Command = {
  type: 'prompt' | 'local' | 'builtin'
  name: string
  description: string
  
  // Prompt 命令
  contentLength?: number
  isHidden?: boolean
  progressMessage?: string
  userFacingName(): string
  source?: string
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  
  // 权限与执行
  allowedTools?: string[]
  argumentHint?: string
  argNames?: string[]
  whenToUse?: string
  hooks?: HooksSettings
  executionContext?: 'inline' | 'fork'
  agent?: string
  effort?: EffortValue
  paths?: string[]  // 条件激活路径
  
  // 模型控制
  version?: string
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  shell?: FrontmatterShell
  
  // Skill 特有
  skillRoot?: string
  getPromptForCommand?(args, toolUseContext): Promise<ContentBlockParam[]>
}
```

### Skill 加载流程

**文件**: `src/skills/loadSkillsDir.ts`

#### 目录结构

```
skills/
  skill-name/
    SKILL.md
```

#### 加载流程

```typescript
async function loadSkillsFromSkillsDir(basePath, source): Promise<SkillWithPath[]> {
  const entries = await fs.readdir(basePath)
  
  return entries.map(async (entry) => {
    // 只支持目录格式
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      return null
    }
    
    const skillFilePath = join(basePath, entry.name, 'SKILL.md')
    const content = await fs.readFile(skillFilePath)
    const { frontmatter, content: markdownContent } = parseFrontmatter(content)
    
    const skillName = entry.name
    const parsed = parseSkillFrontmatterFields(frontmatter, markdownContent, skillName)
    
    return {
      skill: createSkillCommand({
        ...parsed,
        skillName,
        markdownContent,
        source,
        baseDir: skillDirPath,
        loadedFrom: 'skills',
      }),
      filePath: skillFilePath,
    }
  })
}
```

#### 去重机制

```typescript
// 通过 realpath 解析符号链接
async function getFileIdentity(filePath): Promise<string | null> {
  return await realpath(filePath)  // 解析符号链接获取规范路径
}

// 基于规范路径去重
const fileIds = await Promise.all(
  skills.map(({ skill, filePath }) => 
    skill.type === 'prompt' ? getFileIdentity(filePath) : null
  )
)
```

### 动态 Skill 发现

```typescript
// 文件路径触发
async function discoverSkillDirsForPaths(filePaths, cwd) {
  const newDirs: string[] = []
  
  for (const filePath of filePaths) {
    let currentDir = dirname(filePath)
    
    // 从文件所在目录向上搜索到 cwd
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.claude', 'skills')
      
      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)
        
        if (await fs.stat(skillDir).exists()) {
          // 检查 gitignore
          if (!await isPathGitignored(currentDir)) {
            newDirs.push(skillDir)
          }
        }
      }
      
      currentDir = dirname(currentDir)
    }
  }
  
  return newDirs.sort((a, b) => b.split(pathSep).length - a.split(pathSep).length)
}
```

### 条件激活 Skills

```typescript
// frontmatter 中的 paths 字段触发条件激活
function activateConditionalSkillsForPaths(filePaths, cwd): string[] {
  for (const [name, skill] of conditionalSkills) {
    const skillIgnore = ignore().add(skill.paths)
    
    for (const filePath of filePaths) {
      const relativePath = relative(cwd, filePath)
      
      if (skillIgnore.ignores(relativePath)) {
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        break
      }
    }
  }
}
```

---

## SKILL.md Frontmatter

```typescript
type FrontmatterFields = {
  name?: string                    // 显示名称
  description?: string             // 描述 (支持多行)
  when_to_use?: string             // 使用场景提示
  arguments?: string | string[]    // 参数名列表
  argument_hint?: string           // 参数提示
  'allowed-tools'?: string[]       // 允许的工具
  'user-invocable'?: boolean       // 是否可用户调用
  'disable-model-invocation'?: boolean
  model?: string | 'inherit'       // 指定模型
  effort?: EffortValue             // effort 级别
  context?: 'fork' | 'inline'      // 执行上下文
  agent?: string                   // 指定 agent
  shell?: FrontmatterShell         // Shell 执行配置
  hooks?: HooksSettings            // Hook 配置
  paths?: string[]                 // 条件路径
  version?: string
}
```

---

## ToolUse Summary 生成

**文件**: `src/services/toolUseSummary/toolUseSummaryGenerator.ts`

### Haiku 模型生成摘要

```typescript
const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. 
It appears as a single-line row in a mobile app and truncates around 30 characters, 
so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. 
Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`

async function generateToolUseSummary({ tools, signal, isNonInteractiveSession, lastAssistantText }) {
  const toolSummaries = tools.map(tool => {
    return `Tool: ${tool.name}\nInput: ${truncateJson(tool.input, 300)}\nOutput: ${truncateJson(tool.output, 300)}`
  }).join('\n\n')
  
  const contextPrefix = lastAssistantText ? `User's intent: ${lastAssistantText.slice(0, 200)}\n\n` : ''
  
  const response = await queryHaiku({
    systemPrompt: asSystemPrompt([TOOL_USE_SUMMARY_SYSTEM_PROMPT]),
    userPrompt: `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`,
    signal,
    options: {
      querySource: 'tool_use_summary_generation',
      enablePromptCaching: true,
      // ...
    }
  })
  
  return extractTextFromResponse(response)
}
```

---

## OpenClaw 改进建议

### 1. 统一的 Tool 定义格式

建议 OpenClaw 采用类似的 Tool 类型系统：

```typescript
interface Tool<Input, Output> {
  name: string
  description: (input: Input) => string | Promise<string>
  inputSchema: Schema
  outputSchema?: Schema
  
  // 能力标记
  isReadOnly?: (input: Input) => boolean
  isDestructive?: (input: Input) => boolean
  isConcurrencySafe?: (input: Input) => boolean
  
  // 执行
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>
  
  // UI
  render?(output: Output): string | Component
  getSummary?(input: Input): string
}
```

### 2. 命令分类机制

```typescript
type CommandType = 
  | 'prompt'    // Skill 类型的 prompt 模板
  | 'local'     // 本地命令 (/compact, /help)
  | 'builtin'   // 内置命令

interface Command {
  type: CommandType
  name: string
  description: string
  
  // 条件激活
  paths?: string[]  // 匹配时激活
  
  // 执行
  execute(args: string, context: Context): Promise<Result>
  
  // 元数据
  source: 'user' | 'project' | 'plugin' | 'bundled'
  effort?: EffortValue
  agent?: string
}
```

### 3. Skill 文件规范

```
skills/
  skill-name/
    SKILL.md      # 必须，主文件
    README.md     # 可选，额外文档
    scripts/      # 可选，脚本目录
      run.sh
```

Frontmatter:
```yaml
---
name: Custom Skill
description: What this skill does
when_to_use: |
  Use this when...
arguments:
  - name
  - value
allowed_tools:
  - Read
  - Write
user_invocable: true
paths:
  - "src/**/*.ts"
  - "!**/*.test.ts"
---
```

### 4. 工具结果摘要

使用轻量模型生成工具调用的简洁摘要：

```typescript
async function summarizeToolCalls(tools: ToolCall[]): Promise<string> {
  // 使用 fast/small 模型
  const response = await queryModel({
    model: 'haiku',
    systemPrompt: '生成 30 字符以内的工具调用摘要',
    userPrompt: formatToolCalls(tools)
  })
  return response.text
}
```

### 5. 延迟加载与 ToolSearch

```typescript
interface Tool {
  shouldDefer?: boolean  // 需要搜索才能发现
  alwaysLoad?: boolean   // 始终加载
  searchHint?: string    // 搜索关键词
}

// ToolSearch 机制
async function searchTools(query: string): Promise<Tool[]> {
  return allTools.filter(tool => 
    tool.searchHint?.includes(query) ||
    tool.name.includes(query) ||
    tool.description.includes(query)
  )
}
```

### 6. 工具分类

```typescript
type ToolCategory = 
  | 'file'      // 文件操作
  | 'search'    // 搜索
  | 'shell'     // Shell
  | 'network'   // 网络
  | 'memory'    // 记忆
  | 'agent'     // Agent 操作

interface Tool {
  category: ToolCategory
  
  // 用于分类显示
  isSearch: boolean    // 搜索类 (grep, find)
  isRead: boolean      // 读取类 (cat, head)
  isList: boolean      // 列表类 (ls, tree)
}
```
