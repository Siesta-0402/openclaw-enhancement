# Milestone 10: Claude Code 其他遗漏目录研究

## 目录清单

| 目录 | 内容 | 复杂度 |
|-----|------|-------|
| `src/context/` | React Context providers (9个文件) | 低 |
| `src/assistant/` | Session history API 客户端 | 低 |
| `src/plugins/` | 插件系统 (builtin + bundled) | 中 |
| `src/server/` | Direct Connect 服务端 | 中 |

---

## 1. src/context/ — React Context  providers

共9个 `.tsx` 文件，均使用 React Compiler (preact? "c as _c"):

### 文件清单

```
fpsMetrics.tsx        — FPS指标上下文
mailbox.tsx           — 邮箱（IPC消息队列）上下文
modalContext.tsx       — 模态框上下文
notifications.tsx     — 通知上下文
overlayContext.tsx    — Overlay覆盖层协调（Escape键处理）
promptOverlayContext.tsx — Prompt覆盖层
QueuedMessageContext.tsx — 队列消息上下文
stats.tsx             — 统计上下文
voice.tsx             — 语音上下文
```

### overlayContext.tsx 亮点

```typescript
/**
 * Overlay tracking for Escape key coordination.
 *
 * Solves: CancelRequestHandler needs to know when an overlay is active
 * so it doesn't cancel requests when the user just wants to dismiss the overlay.
 *
 * Usage:
 * 1. Call useRegisterOverlay() in any overlay component to automatically register
 * 2. Call useIsOverlayActive() to check if any overlay is active
 *
 * Auto-unregisters on unmount — no manual cleanup needed.
 */

// Non-modal overlays that shouldn't disable TextInput focus
const NON_MODAL_OVERLAYS = new Set(['autocomplete'])
```

这是一个**无 GC 泄漏的自动注册/注销模式**，通过 React 的 useEffect/useLayoutEffect 生命周期自动管理。

### mailbox.tsx 亮点

```typescript
const MailboxContext = createContext<Mailbox | undefined>(undefined)

// useMailbox throws if used outside provider
export function useMailbox(): Mailbox {
  const mailbox = useContext(MailboxContext)
  if (!mailbox) {
    throw new Error("useMailbox must be used within a MailboxProvider")
  }
  return mailbox
}
```

Mailbox 看起来是一个 IPC 消息队列实现，用于组件间通信。

---

## 2. src/assistant/ — Session History API

唯一文件 `sessionHistory.ts` (87行):

### 功能

通过 axios 调用远程 API 获取对话历史分页：

```typescript
const HISTORY_PAGE_SIZE = 100

export async function createHistoryAuthCtx(sessionId: string): Promise<HistoryAuthCtx> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    baseUrl: `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`,
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    },
  }
}
```

### API 端点

```
GET /v1/sessions/{sessionId}/events?before_id=xxx&limit=100
Response: { data: SDKMessage[], has_more: boolean, first_id: string|null, last_id: string|null }
```

返回类型是 `SDKMessage[]` — 与 headless SDK 共享的消息类型。

---

## 3. src/plugins/ — 插件系统

```
builtinPlugins.ts     — 内置插件注册表
bundled/
  index.ts            — 打包的插件
```

### 内置插件架构

```typescript
// 插件ID格式
const BUILTIN_MARKETPLACE_NAME = 'builtin'
// 用户插件ID: {name}@{marketplace}
// 内置插件ID: {name}@builtin

// 注册
export function registerBuiltinPlugin(definition: BuiltinPluginDefinition): void
// 查询
export function getBuiltinPluginDefinition(name: string): BuiltinPluginDefinition | undefined

// BuiltinPluginDefinition 包含:
// - name, description
// - skills: BundledSkillDefinition[]
// - hooks: HookDefinition[]
// - mcpServers: MCPServerDefinition[]
```

### 内置 vs 打包 插件的区别

| 特性 | Builtin Plugins | Bundled Plugins |
|-----|----------------|-----------------|
| 显示位置 | `/plugin` UI 的 "Built-in" 分节 | 不可见，静态打包 |
| 用户控制 | 可启用/禁用（持久化到设置） | 不可配置 |
| 提供内容 | skills + hooks + MCP servers | skills |

---

## 4. src/server/ — Direct Connect 服务端

### 文件清单

```
createDirectConnectSession.ts — 创建会话客户端
directConnectManager.ts       — 连接管理器
types.ts                     — 类型定义
```

### types.ts 关键类型

```typescript
export type ServerConfig = {
  port: number
  host: string
  authToken: string
  unix?: string
  idleTimeoutMs?: number      // 0 = 永不过期
  maxSessions?: number        // 最大并发会话数
  workspace?: string           // 默认工作目录
}

export type SessionState = 'starting' | 'running' | 'detached' | 'stopping' | 'stopped'

export type SessionInfo = {
  id: string
  status: SessionState
  createdAt: number
  workDir: string
  process: ChildProcess | null
  sessionKey?: string
}

// 持久化索引: sessionKey → 元数据
export type SessionIndexEntry = {
  sessionId: string           // 服务端分配的ID
  transcriptSessionId: string // 转录本会话ID (--resume用)
}
```

### createDirectConnectSession.ts

```typescript
export class DirectConnectError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectConnectError' }
}

export async function createDirectConnectSession({
  serverUrl, authToken, cwd, dangerouslySkipPermissions,
}): Promise<{ config: DirectConnectConfig; workDir?: string }> {
  // POST ${serverUrl}/sessions
  // Response: { session_id, ws_url, work_dir? }
}
```

---

## 与 Python 版本的映射

| TypeScript 目录 | Python 路径 | 状态 |
|----------------|-----------|------|
| `src/context/*.tsx` | `context.py` | ✅ 已移植 |
| `src/assistant/sessionHistory.ts` | (无对应) | ❌ 未移植 |
| `src/plugins/` | `plugins/` | ✅ 已移植 |
| `src/server/` | `server/` (目录) | ❌ 未移植 |

Python 版本的 `src/` 目录里有 `server/` 目录（与其他子系统并列），但 `context.py` 是单一文件，包含了 TypeScript 多个 context 文件的逻辑。

---

## 重要发现

### 1. React Compiler 使用
所有 context 文件都使用 `"c as _c"` 导入模式，表明 Claude Code 使用了 React Compiler (react-compiler-runtime) 进行自动优化。这是 React 19 的产物。

### 2. Overlay 协调模式
`overlayContext.tsx` 的设计非常优雅——用 React 的生命周期自动注册/注销，无需手动 cleanup，避免了常见的状态泄漏bug。

### 3. Direct Connect 是完整的服务端架构
不只是简单的 subprocess 管理，而是有：
- 会话生命周期状态机
- 持久化索引（`~/.claude/server-sessions.json`）
- Unix socket 支持
- 空闲超时和最大会话数限制

### 4. Session History 是 CCR 特有
这个 API 端点 (`ccr-byoc-2025-07-29` beta header) 明确是为 Claude Code Runtime (CCR/Co-work) 设计的服务端历史功能。
