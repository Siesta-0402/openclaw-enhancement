# Claude Code Skill 系统详解

## 概述

Claude Code 的 Skill 系统是命令的扩展，支持：
- **本地 Skills**: 项目目录下的 `.claude/skills/`
- **用户 Skills**: `~/.claude/skills/`
- **策略 Skills**: 托管的 `.claude/skills/`
- **MCP Skills**: MCP 服务器提供的 skills
- **Bundle Skills**: 内置 skills

---

## Skill 加载机制

**文件**: `src/skills/loadSkillsDir.ts`

### 目录格式

```
skills/
  skill-name/
    SKILL.md        # 必需文件
  
commands/           # 旧格式兼容
  skill-name/
    SKILL.md
  some-command.md   # 单文件命令
```

### 加载流程

```typescript
export const getSkillDirCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    // 1. 收集所有目录
    const managedSkillsDir = join(getManagedFilePath(), '.claude', 'skills')
    const userSkillsDir = join(getClaudeConfigHomeDir(), 'skills')
    const projectSkillsDirs = getProjectDirsUpToHome('skills', cwd)
    const additionalDirs = getAdditionalDirectoriesForClaudeMd()

    // 2. 并行加载
    const [
      managedSkills,
      userSkills,
      projectSkillsNested,
      additionalSkillsNested,
      legacyCommands,
    ] = await Promise.all([
      loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
      loadSkillsFromSkillsDir(userSkillsDir, 'userSettings'),
      Promise.all(projectSkillsDirs.map(dir => 
        loadSkillsFromSkillsDir(dir, 'projectSettings')
      )),
      Promise.all(additionalDirs.map(dir =>
        loadSkillsFromSkillsDir(join(dir, '.claude', 'skills'), 'projectSettings')
      )),
      loadSkillsFromCommandsDir(cwd),  // 旧格式
    ])

    // 3. 合并去重
    const allSkills = [
      ...managedSkills,
      ...userSkills,
      ...projectSkillsNested.flat(),
      ...additionalSkillsNested.flat(),
      ...legacyCommands,
    ]

    // 4. 基于 realpath 去重 (处理符号链接)
    const deduplicated = deduplicateByRealPath(allSkills)

    // 5. 分离条件 skills
    const [unconditional, conditional] = separateConditionalSkills(deduplicated)

    return unconditional
  }
)
```

### 单个 Skill 加载

```typescript
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
): Promise<SkillWithPath[]> {
  const entries = await fs.readdir(basePath)

  return entries.map(async (entry) => {
    // 只支持目录格式
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      return null
    }

    const skillFilePath = join(basePath, entry.name, 'SKILL.md')
    const content = await fs.readFile(skillFilePath, 'utf-8')
    const { frontmatter, content: markdownContent } = parseFrontmatter(content)

    const skillName = entry.name
    const parsed = parseSkillFrontmatterFields(frontmatter, markdownContent, skillName)
    const paths = parseSkillPaths(frontmatter)

    return {
      skill: createSkillCommand({
        ...parsed,
        skillName,
        markdownContent,
        source,
        baseDir: skillDirPath,
        loadedFrom: 'skills',
        paths,
      }),
      filePath: skillFilePath,
    }
  })
}
```

---

## 去重机制

### 符号链接处理

```typescript
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    // 使用 realpath 解析符号链接
    return await realpath(filePath)
  } catch {
    return null
  }
}

// 基于规范路径去重
const seenFileIds = new Map<string, SettingSource>()
const deduplicated: Command[] = []

for (const { skill, filePath } of allSkillsWithPaths) {
  const fileId = await getFileIdentity(filePath)
  if (fileId === null) {
    deduplicated.push(skill)
    continue
  }

  const existingSource = seenFileIds.get(fileId)
  if (existingSource !== undefined) {
    // 跳过重复
    logForDebugging(`Skipping duplicate skill '${skill.name}' from ${skill.source}`)
    continue
  }

  seenFileIds.set(fileId, skill.source)
  deduplicated.push(skill)
}
```

---

## Frontmatter 解析

### parseSkillFrontmatterFields

```typescript
function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel = 'Skill',
): {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
}
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | 显示名称 |
| description | string | Skill 描述 |
| when_to_use | string | 使用场景提示 |
| arguments | string \| string[] | 参数名列表 |
| argument_hint | string | 参数提示 |
| allowed_tools | string[] | 允许的工具 |
| user_invocable | boolean | 是否可用户调用 |
| disable_model_invocation | boolean | 禁用模型调用 |
| model | string | 指定模型 |
| effort | string | effort 级别 |
| context | 'fork' | 执行上下文 |
| agent | string | 指定 agent |
| shell | FrontmatterShell | Shell 配置 |
| hooks | HooksSettings | Hook 配置 |
| paths | string[] | 条件激活路径 |
| version | string | 版本号 |

---

## 条件激活 Skills

### Paths Frontmatter

```typescript
function parseSkillPaths(frontmatter: FrontmatterData): string[] | undefined {
  if (!frontmatter.paths) {
    return undefined
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(p => p.endsWith('/**') ? p.slice(0, -3) : p)  // 去掉 /**
    .filter(p => p.length > 0)

  // 如果全是 **，视为无路径
  if (patterns.length === 0 || patterns.every(p => p === '**')) {
    return undefined
  }

  return patterns
}
```

### 动态激活

```typescript
// 条件 skills 存储
const conditionalSkills = new Map<string, Command>()
const activatedConditionalSkillNames = new Set<string>()

// 当操作某个文件时，激活匹配路径的 skills
function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    const skillIgnore = ignore().add(skill.paths)

    for (const filePath of filePaths) {
      const relativePath = relative(cwd, filePath)

      if (skillIgnore.ignores(relativePath)) {
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        break
      }
    }
  }

  return activated
}
```

---

## 动态 Skill 发现

### discoverSkillDirsForPaths

```typescript
async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const fs = getFsImplementation()
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    let currentDir = dirname(filePath)

    // 从文件所在目录向上搜索到 cwd
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.claude', 'skills')

      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)

        try {
          await fs.stat(skillDir)
          // 检查 gitignore
          if (!await isPathGitignored(currentDir, resolvedCwd)) {
            newDirs.push(skillDir)
          }
        } catch {
          // 目录不存在
        }
      }

      currentDir = dirname(currentDir)
    }
  }

  // 按深度排序 (深的优先)
  return newDirs.sort((a, b) => 
    b.split(pathSep).length - a.split(pathSep).length
  )
}
```

---

## Skill 命令创建

### createSkillCommand

```typescript
function createSkillCommand({
  skillName,
  displayName,
  description,
  markdownContent,
  allowedTools,
  argumentHint,
  argumentNames,
  whenToUse,
  version,
  model,
  disableModelInvocation,
  userInvocable,
  source,
  baseDir,
  loadedFrom,
  hooks,
  executionContext,
  agent,
  paths,
  effort,
  shell,
}): Command {
  return {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools,
    argumentHint,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model,
    disableModelInvocation,
    userInvocable,
    context: executionContext,
    agent,
    effort,
    paths,
    contentLength: markdownContent.length,
    isHidden: !userInvocable,
    progressMessage: 'running',
    userFacingName(): string {
      return displayName || skillName
    },
    source,
    loadedFrom,
    hooks,
    skillRoot: baseDir,

    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      // 替换变量
      finalContent = substituteArguments(finalContent, args, true, argumentNames)
      
      // 替换 ${CLAUDE_SKILL_DIR}
      if (baseDir) {
        const skillDir = process.platform === 'win32' 
          ? baseDir.replace(/\\/g, '/') 
          : baseDir
        finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
      }

      // 替换 ${CLAUDE_SESSION_ID}
      finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

      // 执行 shell 命令 (!`...`)
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          { ...toolUseContext },
          `/${skillName}`,
          shell,
        )
      }

      return [{ type: 'text', text: finalContent }]
    },
  }
}
```

---

## Hooks 支持

### Frontmatter Hooks 解析

```typescript
function parseHooksFromFrontmatter(
  frontmatter: FrontmatterData,
  skillName: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(`Invalid hooks in skill '${skillName}': ${result.error.message}`)
    return undefined
  }

  return result.data
}
```

---

## 命名空间

### 命令名称构建

```typescript
function buildNamespace(targetDir: string, baseDir: string): string {
  if (targetDir === normalizedBaseDir) {
    return ''
  }

  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath.split(pathSep).join(':')
}

// 示例
// baseDir = /project/.claude/skills
// targetDir = /project/src/features/auth/.claude/skills
// namespace = "src:features:auth"
```

---

## MCP Skill Builders

```typescript
// 注册到 MCP skill discovery
registerMCPSkillBuilders({
  createSkillCommand,
  parseSkillFrontmatterFields,
})
```

---

## 缓存清理

```typescript
export function clearSkillCaches() {
  getSkillDirCommands.cache?.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}
```

---

## OpenClaw 改进建议

### 1. Skill 加载验证

```typescript
interface SkillValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

function validateSkill(skillPath: string): SkillValidation {
  const errors: string[] = []
  const warnings: string[] = []

  // 检查 SKILL.md 存在
  if (!exists(join(skillPath, 'SKILL.md'))) {
    errors.push('SKILL.md is required')
  }

  // 检查 frontmatter 有效性
  const content = readFile(join(skillPath, 'SKILL.md'))
  const { frontmatter, error } = parseFrontmatter(content)
  if (error) {
    errors.push(`Frontmatter error: ${error}`)
  }

  // 检查 name 字段
  if (!frontmatter.name) {
    warnings.push('name field is recommended')
  }

  return { valid: errors.length === 0, errors, warnings }
}
```

### 2. 条件激活配置

```yaml
# SKILL.md
---
name: Auth Tests
description: Run authentication tests
paths:
  - "src/auth/**"
  - "src/**/*auth*.ts"
  - "!**/*.test.ts"
---
```

### 3. Skill 变量替换

```typescript
// 支持的变量
const SKILL_VARIABLES = {
  '${CLAUDE_SKILL_DIR}': skillBaseDir,
  '${CLAUDE_SESSION_ID}': sessionId,
  '${CLAUDE_PROJECT_DIR}': projectDir,
  '${CLAUDE_CWD}': cwd,
}

// 替换时机：在 getPromptForCommand 中
```

### 4. Skill 加载优先级

```typescript
const SKILL_SOURCE_PRIORITY: Record<SettingSource, number> = {
  bundled: 0,      // 内置最高
  plugin: 1,
  managed: 2,     // 策略
  userSettings: 3,
  projectSettings: 4,  // 项目最低
}

// 相同名称的 skill，优先级高的覆盖低的
```

### 5. Skill 生命周期钩子

```typescript
interface SkillHooks {
  onLoad?: () => void | Promise<void>
  onInvoke?: (args: Record<string, string>) => void | Promise<void>
  onComplete?: (result: unknown) => void | Promise<void>
  onError?: (error: Error) => void | Promise<void>
}
```

### 6. Skill 执行上下文

```typescript
// 旧式 inline 执行
type ExecutionContext = 'inline' | 'fork'

// fork 执行：新的 agent 会话
// inline 执行：在当前上下文执行
```

### 7. 符号链接与路径规范化

```typescript
// 使用 realpath 解析符号链接
async function resolveSkillPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

// 基于规范路径去重
async function deduplicateSkills(skills: Skill[]): Promise<Skill[]> {
  const seen = new Map<string, Skill>()
  
  for (const skill of skills) {
    const canonical = await resolveSkillPath(skill.filePath)
    const existing = seen.get(canonical)
    
    if (existing) {
      // 保留更高优先级的
      if (getPriority(skill.source) < getPriority(existing.source)) {
        seen.set(canonical, skill)
      }
    } else {
      seen.set(canonical, skill)
    }
  }
  
  return Array.from(seen.values())
}
```

### 8. 动态发现优化

```typescript
// 缓存已检查过的目录
const checkedDirs = new Set<string>()

async function discoverSkillsForFiles(filePaths: string[]): Promise<void> {
  const newDirs = await discoverSkillDirsForPaths(filePaths, cwd)
  
  if (newDirs.length > 0) {
    await addSkillDirectories(newDirs)
    // 通知 listeners
    skillsLoaded.emit()
  }
}
```

### 9. Skill 元数据 Token 估算

```typescript
// 只用 frontmatter 估算 token (内容按需加载)
function estimateSkillFrontmatterTokens(skill: Command): number {
  const frontmatterText = [
    skill.name,
    skill.description,
    skill.whenToUse,
  ].filter(Boolean).join(' ')
  
  return roughTokenCountEstimation(frontmatterText)
}
```

### 10. 安全检查

```typescript
// 检查 skill 目录是否在 gitignore 中
async function isSkillPathSafe(skillDir: string, cwd: string): Promise<boolean> {
  // 1. 检查是否在 gitignore
  if (await isPathGitignored(dirname(skillDir), cwd)) {
    return false
  }
  
  // 2. 检查权限
  const stat = await fs.stat(skillDir)
  if (stat.mode & 0o777) !== 0o755) {
    // World-writable 可能有安全问题
  }
  
  return true
}
```
