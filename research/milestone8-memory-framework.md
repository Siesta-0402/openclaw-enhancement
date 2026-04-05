# Milestone 8: Memory Framework（记忆框架）

> 研究日期：2026-04-05
> 源码路径：~/Desktop/claude-code-main/

---

## 1. 概览

Claude Code 的记忆框架是一个**文件化的、类型化的、持久化记忆系统**。核心设计原则：

1. **文件即记忆**：记忆存储在文件系统中，每个记忆一个文件
2. **类型化记忆**：严格的四类型分类体系（user/feedback/project/reference）
3. **索引入口**：MEMORY.md 作为总索引，每个条目一行
4. **多维度记忆**：支持个人记忆（auto memory）和团队记忆（team memory）

---

## 2. 记忆类型体系（src/memdir/memoryTypes.ts）

### 2.1 四种记忆类型

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
```

| 类型 | 范围 | 用途 |
|------|------|------|
| **user** | 私有 | 用户角色、目标、责任、知识 |
| **feedback** | 私有或团队 | 用户给的指导（纠正和确认都要记录） |
| **project** | 私有或团队（强烈倾向团队） | 项目上下文、目标、bug、事件 |
| **reference** | 通常团队 | 外部系统指针（Linear、Grafana、Slack 等） |

### 2.2 记忆 frontmatter 格式

```yaml
---
name: <title>
description: <one-line description>
type: <user|feedback|project|reference>
---
<content>
```

### 2.3 关键约束

**不保存的内容（可从代码/项目状态推导的信息）：**
- 代码模式
- 架构设计
- Git 历史
- 文件结构

**保存的结构规范：**
- feedback 类型：**规则** → **Why:** → **How to apply:**
- project 类型：**事实/决策** → **Why:** → **How to apply:**

---

## 3. 记忆目录结构

### 3.1 目录布局

```
~/.claude/projects/<slug>/memory/
├── MEMORY.md              # 总索引（每条目一行，<200 行）
├── user_role.md           # 用户信息
├── feedback_preferences.md # 用户反馈
├── project_context.md      # 项目上下文
├── reference_linear.md     # 外部系统引用
└── team/                  # 团队记忆（可选）
    ├── MEMORY.md
    ├── ...
```

### 3.2 MEMORY.md 入口约束

```typescript
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000  // ~125 chars/line * 200 lines
```

**截断警告**：当索引超限时，会附加警告提示用户简化条目。

---

## 4. 记忆提示构建（src/memdir/memdir.ts）

### 4.1 buildMemoryPrompt()

返回完整记忆提示（含 MEMORY.md 内容）：
1. 构建 `buildMemoryLines()`（记忆使用规范 + 索引内容）
2. 读取现有的 MEMORY.md 内容
3. 截断（行数 + 字节数双重限制）
4. 附加使用量和截断状态的遥测

### 4.2 loadMemoryPrompt()

返回要在系统提示中注入的记忆内容：
```typescript
export async function loadMemoryPrompt(): Promise<string | null>
```

**多模式分发：**
```typescript
// 优先：KAIROS 每日日志模式（append-only）
if (feature('KAIROS') && autoEnabled && getKairosActive()) {
  return buildAssistantDailyLogPrompt()

// 其次：TEAMMEM 团队记忆模式
if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
  return teamMemPrompts!.buildCombinedMemoryPrompt()

// 默认：个人自动记忆
if (autoEnabled) {
  return buildMemoryLines('auto memory', autoDir).join('\n')
}
```

### 4.3 记忆持久化流程

```
用户说"记住 X"
  → 确定记忆类型
  → 写入独立文件（file.md）
  → 更新 MEMORY.md（添加索引行）
```

---

## 5. 每日日志模式（KAIROS feature）

### 5.1 设计理念

Assistant 模式的会话是**永久性的**，因此：
- 新记忆追加到当天的日志文件：`YYYY/MM/YYYY-MM-DD.md`
- 夜间 Dream 技能将日志蒸馏到 MEMORY.md 和主题文件
- 日志本身是**只追加**的，不重写不重组

### 5.2 日志路径模式

```
{autoMemDir}/logs/YYYY/MM/YYYY-MM-DD.md
```

日志内容格式：
- 时间戳 bullets
- 用户纠正和偏好（"use bun, not npm"）
- 用户角色/目标事实
- 不可从代码推导的项目上下文

---

## 6. 团队记忆（TEAMMEM feature）

### 6.1 架构

```
autoMemDir/           # 个人记忆
└── team/             # 团队共享记忆
    ├── MEMORY.md
    └── ...
```

### 6.2 同步机制

团队记忆通过 `teamMemSync` 服务同步：
- 自动将团队范围的反馈/项目/引用记忆推送到共享位置
- 冲突解决：团队记忆优先于个人记忆

### 6.3 范围标签

团队记忆中的条目带有 `<scope>` 标签：
```xml
<type>
  <name>feedback</name>
  <scope>default to private. Save as team only when...</scope>
</type>
```

---

## 7. 命令历史（src/history.ts）

### 7.1 history.jsonl 全局历史

```typescript
// 路径：~/.claude/history.jsonl（跨项目共享）
type LogEntry = {
  display: string           // 展示文本
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string          // 项目根目录
  sessionId: string
}
```

### 7.2 粘贴内容处理

**小内容（≤1024 字节）：** 内联存储
```typescript
storedPastedContents[id] = { id, type: 'text', content: '...' }
```

**大内容：** 哈希引用，异步存储
```typescript
storedPastedContents[id] = { id, type: 'text', contentHash: hash }
void storePastedText(hash, content)  // fire-and-forget
```

### 7.3 历史读取

```typescript
// 当前项目历史（去重，新到旧）
export async function* getHistory(): AsyncGenerator<HistoryEntry>

// 带时间戳的历史（ctrl+r 搜索）
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry>

// 逆向读取（最近优先）
async function* makeLogEntryReader()  // 反向逐行读取 history.jsonl
```

### 7.4 undoLastFromHistory

```typescript
export function removeLastFromHistory(): void
```

快速路径：从 pending buffer 弹出
竞态路径：加入 `skippedTimestamps` 集合（async flush 已赢过 pop）

---

## 8. 应用状态管理（src/state/）

### 8.1 AppState 结构

```typescript
type AppState = {
  // 成本追踪
  totalCostUSD: number
  totalAPIDuration: number
  totalToolDuration: number

  // 使用量
  modelUsage: { [modelName: string]: ModelUsage }

  // 会话
  sessionId: SessionId
  startTime: number
  lastInteractionTime: number

  // 计数
  totalLinesAdded: number
  totalLinesRemoved: number

  // 配置
  mainLoopModelOverride: ModelSetting | undefined
  toolPermissionContext: ToolPermissionContext
  mcp: { clients: McpClient[]; tools: McpTool[] }

  // 标志
  fastMode: boolean
  effortValue: number
}
```

### 8.2 AppStateStore

基于响应式信号的全局状态存储：
- `createSignal` 创建可追踪状态
- `onChangeAppState` 订阅状态变化
- 支持 selector 模式（只订阅关心的字段）

### 8.3 关键状态模块

| 文件 | 职责 |
|------|------|
| `AppStateStore.ts` | 全局状态存储 |
| `AppState.tsx` | 状态类型定义 |
| `selectors.ts` | 状态选择器 |
| `store.ts` | 状态持久化 |
| `teammateViewHelpers.ts` | 队友视图辅助 |

---

## 9. 引导状态（src/bootstrap/state.ts）

### 9.1 全局单例状态

```typescript
type State = {
  originalCwd: string
  projectRoot: string           // Stable project root（只设置一次）
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean         // KAIROS 模式激活
  strictToolResultPairing: boolean  // HFI 模式标志
  sessionId: SessionId
  // ... 更多字段
}
```

### 9.2 Session ID 生成

```typescript
sessionId: randomUUID()  // 每次启动新的 UUID
```

### 9.3 Telemetry 集成

```typescript
meter: Meter | null           // OpenTelemetry Meter
sessionCounter: AttributedCounter | null
tokenCounter: AttributedCounter | null
costCounter: AttributedCounter | null
commitCounter: AttributedCounter | null
```

---

## 10. 关键设计洞察

1. **文件化记忆 > 键值存储**：每个记忆独立文件，通过 MEMORY.md 索引，既能被 Claude 读取理解，也对用户完全透明可编辑。

2. **类型化强制约束**：四类型体系 + 不保存内容的明确列表，防止记忆系统变得杂乱无章。

3. **双重截断保护**：MEMORY.md 同时限制行数（200）和字节数（25KB），防止索引膨胀失控。

4. **append-only 日志模式**：KAIROS 模式承认永久会话的现实，用只追加日志替代原地编辑，避免重写丢失。

5. **团队/个人记忆隔离**：team/ 子目录 + 范围标签允许灵活控制共享粒度。

6. **paste store 分离**：大粘贴内容哈希引用到独立存储，避免历史文件膨胀。

7. **Bootstrap 状态最小化**：bootstrap/state.ts 刻意控制全局状态量，避免状态蔓延。
