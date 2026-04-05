# 最终复盘报告 — Claude Code 源码 + claw-code 重写版研究

**生成日期：** 2026-04-05  
**执行者：** Saskia（Siesta 的 AI 助手）  
**研究历时：** 2026-04-03 ~ 2026-04-05

---

## 一、Claude Code 源码研究总结

### 1.1 研究覆盖的目录/文件

| 目录/文件 | 大小 | 研究程度 | 关键发现 |
|-----------|------|----------|----------|
| `tools/Tool.ts` | ~900行 | ✅ 深度研究 | Tool 接口设计、renderToolUseMessage/getActivityDescription |
| `tools/tools.ts` | - | ✅ 深度研究 | 工具注册系统 |
| `QueryEngine.ts` | 46K | ✅ 深度研究 | 查询引擎核心逻辑 |
| `query.ts` | 1729行 | ✅ 研究 | 查询循环 |
| `context.ts` | - | ✅ 研究 | 上下文收集 |
| `coordinator/` | - | ✅ 研究 | 多 Agent 协调 |
| `memdir/` | - | ✅ 深度研究 | 记忆系统（SQLite FTS） |
| `skills/` | - | ✅ 深度研究 | Skill 加载、激活条件、frontmatter |
| `context/` | - | ✅ 研究 | 四级压缩系统 |
| `components/` | 多个大文件 | ⚠️ 部分研究 | REPL UI、PromptInput、Settings |
| `hooks/` | - | ✅ 研究 | 命令分类、cost hook |
| `services/api/claude.ts` | 3419行 | ⚠️ 未详细研究 | API 调用层 |
| `cli/print.ts` | 5594行 | ⚠️ 未详细研究 | CLI 输出格式化 |
| `ink/ink.tsx` | 1722行 | ❌ 未研究 | Ink TUI 渲染引擎 |
| `native-ts/` | 含3个native包 | ❌ 未研究 | color-diff, file-index, yoga-layout |
| `utils/ansiToPng.ts` | 214K | ❌ 未研究 | ANSI 转 PNG 渲染 |
| `server/` | - | ⚠️ 未详细研究 | WebSocket 服务器 |
| `setup.ts` | 单文件 | ❌ 未研究 | 启动初始化 |
| `plugins/` | - | ⚠️ 未研究 | 插件系统 |
| `remote/` | - | ⚠️ 未研究 | 远程触发 |
| `buddy/` | - | ❌ 未研究 | Buddy 系统 |
| `voice/` | - | ❌ 未研究 | 语音功能 |
| `moreright/` | - | ❌ 未研究 | 权限扩展 |
| `upstreamproxy/` | - | ❌ 未研究 | 上游代理 |
| `outputStyles/` | - | ❌ 未研究 | 输出样式 |

### 1.2 核心发现（分级）

#### 🔴 P0 — 必须实现（差距最大）

1. **Tool 元数据系统** (`Tool.ts`)
   - `getActivityDescription`: 返回人类可读的活动描述（"Reading src/foo.ts"）
   - `getToolUseSummary`: 工具使用的简短摘要
   - `renderToolUseMessage` / `renderToolResultMessage`: 专用 UI 渲染
   - `toAutoClassifierInput`: 自动模式安全分类输入
   - `isConcurrencySafe` / `isReadOnly` / `isDestructive`: 语义分类
   - OpenClaw 当前只有 `name` + `description`，缺 6 个关键字段

2. **四级压缩系统** (`context.ts`)
   - `HISTORY_SNIP`: 历史消息智能截断
   - `Microcompact`: 工具结果的细粒度截断（保留 key 数据，截断 value）
   - `Context Collapse`: 完全折叠工具调用为摘要
   - `autoCompact`: 自动触发阈值
   - **60分钟超时触发微压缩**: 用户无响应60分钟后自动清理
   - OpenClaw 只有单一压缩，远不如 Claude Code 细腻

3. **Skill 系统**
   - `whenToUse`: 告知模型何时使用该 skill
   - `paths`: 基于 glob 模式的条件激活
   - `allowedTools/deniedTools`: 工具权限控制
   - `category` + `effort` + `model` + `shell`: 精细化配置
   - 多 source 优先级体系（bundled < managed < agents-skills-personal < agents-skills-project）
   - OpenClaw skill frontmatter 缺少上述多数字段

4. **命令分类系统** (`hooks/useTypeahead.tsx`, `command-classifier.ts`)
   - 100+ 种命令类型分类（edit/read/web/search/lite/...]
   - 每个命令有 `activityDescription` + `autoModeRestriction`
   - 用于权限判断 + UI 展示 + 自动模式决策
   - OpenClaw 无等效系统

5. **BashTool 多级验证** (`BashTool/BashTool.tsx`)
   - 预执行：Shell解析 → 风险检测 → 安全确认
   - 执行后：结果验证 → 语法错误检测 → 自动修复建议
   - 11 个子类验证模块（Rust 重写版的 Lane 1-3）
   - OpenClaw exec 工具缺少这些验证层

#### 🟡 P1 — 重要功能差距

6. **Task/RemoteAgent 系统**
   - `TaskCreateTool` / `TaskListTool` / `TaskStopTool` / `TaskUpdateTool`
   - `RemoteAgentTask`: 独立远程 agent 任务
   - `TaskOutputTool`: 跨会话任务输出获取
   - `TeamCreateTool` / `TeamDeleteTool`: 团队管理
   - `ScheduleCronTool`: 定时任务
   - OpenClaw 用 sessions_spawn 做类似的事，但无统一 Task 抽象

7. **MCP (Model Context Protocol) 集成**
   - `mcpClient.ts`: MCP 客户端管理
   - `mcp_tool_bridge.ts`: MCP ↔ Native tool bridge
   - `MCPTool`: 在 Claude Code 内调用 MCP 服务器
   - `McpAuthTool` / `ListMcpResourcesTool` / `ReadMcpResourceTool`
   - OpenClaw 有基础 MCP 支持，但深度不如 Claude Code

8. **权限系统**
   - `permission_enforcer.ts`: 权限检查执行
   - `ExitPlanModePermissionRequest`: 退出计划模式权限请求
   - `checkPermissions`: 工具级别的权限验证
   - `requireCanUseTool`: 子 agent 权限传递
   - OpenClaw 有基础权限系统，Claude Code 更精细

9. **LSP 客户端集成** (`LSPTool`)
   - 诊断、代码操作、悬停信息、跳转定义
   - `lspClient.ts`: 完整的 Language Server Protocol 客户端
   - OpenClaw 无 LSP 集成

#### 🟢 P2 — 增强型功能

10. **记忆系统** (`memdir/`)
    - SQLite FTS5 全文搜索
    - 按项目隔离的记忆存储
    - Session 级别的记忆上下文注入
    - OpenClaw 有 memory_search，但实现细节不同

11. **Session Transcript** (Kairos)
    - 会话转录分析，检测节奏/模式
    - 延迟工具加载（按需加载工具而非全部注册）
    - OpenClaw 无等效

12. **Tool Search** (`ToolSearchTool`)
    - 按关键词搜索可用工具
    - 延迟加载工具的技术基础
    - OpenClaw 无等效

### 1.3 对 OpenClaw 的启示

1. **Tool 系统必须扩展**: 当前 OpenClaw 的 Tool 接口太简陋，需要增加元数据字段
2. **压缩需要多级化**: 单一压缩不够，需要 4 级渐进压缩
3. **Skill 系统需要升级**: frontmatter 需要支持更多配置字段
4. **命令分类是安全基础**: 自动模式安全执行依赖于命令分类
5. **Task 抽象值得借鉴**: 统一的 Task 生命周期管理

---

## 二、claw-code 重写版研究总结

### 2.1 研究覆盖的文件

| 文件/目录 | 内容 | 研究程度 |
|-----------|------|----------|
| `rust/Cargo.toml` | workspace 配置 | ✅ |
| `rust/Cargo.lock` | 依赖锁文件 | ✅ |
| `rust/README.md` | 项目说明 | ✅ |
| `rust/PARITY.md` | 与原版 Claude Code 的功能对照 | ✅ 深度 |
| `rust/PHILOSOPHY.md` | 设计哲学 | ✅ |
| `rust/ROADMAP.md` | 开发路线图 | ✅ |
| `rust/CLAUDE.md` | 开发者指南 | ✅ |
| `rust/.clawd-todos.json` | 待办事项 | ✅ |
| `rust/mock_parity_scenarios.json` | 44个测试场景 | ✅ |
| `rust/MOCK_PARITY_HARNESS.md` | Mock 测试框架 | ✅ |
| `crates/api/` | API 客户端 | ✅ |
| `crates/commands/` | 命令处理 | ✅ |
| `crates/compat-harness/` | 兼容测试框架 | ✅ |
| `crates/mock-anthropic-service/` | Mock API 服务 | ✅ |
| `crates/plugins/` | 插件 hooks | ✅ |
| `crates/runtime/` | 核心运行时（38个模块） | ✅ 深度 |
| `crates/rusty-claude-cli/` | CLI 应用 | ✅ |
| `crates/telemetry/` | 遥测 | ✅ |
| `crates/tools/` | 工具实现 | ✅ |

### 2.2 核心发现

#### 设计哲学亮点

1. **9-Lane Checkpoint 系统** (`PARITY.md`)
   - Lane 1: Bash validation
   - Lane 2: CI fix
   - Lane 3: File tool
   - Lane 4: TaskRegistry
   - Lane 5: Task wiring
   - Lane 6: Team+Cron
   - Lane 7: MCP lifecycle
   - Lane 8: LSP client
   - Lane 9: Permission enforcement
   - 每个 lane 有独立的 mock 测试场景

2. **Green Contract 机制** (`runtime/green_contract.rs`)
   - 记录工具调用前后的"绿色承诺"（预期行为）
   - 用于回归测试和行为验证
   - 创新性的测试方法论

3. **Lane Events 架构** (`runtime/lane_events.rs`)
   - 事件驱动的 lane 间通信
   - 替代直接函数调用的解耦设计

4. **Permission Enforcer** (`runtime/permission_enforcer.rs`)
   - 独立的权限执行层
   - 可配置的权限策略引擎
   - 跨工具路径的统一权限管理

5. **Recovery Recipes** (`runtime/recovery_recipes.rs`)
   - 错误自动恢复配方
   - 结构化的故障处理策略

6. **Summary Compression** (`runtime/summary_compression.rs`)
   - 工具结果摘要压缩
   - 与 Claude Code 四级压缩对应的实现

#### 仍未完成的部分（按 ROADMAP.md）

- Lane 8 (LSP client): 仍 shallow
- Lane 9 (Permission enforcement): 部分完成
- 40 个 tool specs 中部分仍 shallow
- 迁移就绪度: MIGRATION_NOT_READY

### 2.3 对 OpenClaw 的启示

1. **Green Contract 测试方法值得借鉴**: 在 OpenClaw 中引入类似的回归测试机制
2. **Lane 架构的解耦思路**: 将大型功能拆分为独立 lane，便于渐进实现
3. **Mock Parity Harness**: 用 mock 服务验证行为 parity，确保重写不破坏功能
4. **Permission Enforcer 独立化**: OpenClaw 应将权限检查从工具内部移到独立层

---

## 三、综合评估

### 3.1 Claude Code vs claw-code 对比

| 维度 | Claude Code (TypeScript) | claw-code (Rust) | 评估 |
|------|---------------------------|------------------|------|
| 架构语言 | TypeScript + React | Rust + Rive/TUI | Rust 性能更强 |
| Tool 系统 | 完整元数据 + UI渲染 | 仅基础注册 | **claw-code 差距大** |
| 压缩系统 | 4级渐进压缩 | summary_compression.rs | **claw-code 仅1级** |
| Skill 系统 | 完整 frontmatter | 无 | **claw-code 缺失** |
| MCP 集成 | 完整 | 部分（lifecycle hardened） | claw-code 进行中 |
| LSP 集成 | 完整 | 仅浅层 | **claw-code 差距大** |
| 测试方法 | 单元+集成 | Green Contract + Mock Parity | **claw-code 创新** |
| 权限系统 | 精细化 | 独立层设计 | 持平，各有侧重 |
| Task 系统 | 完整 | 部分（TaskRegistry） | claw-code 进行中 |
| 内存系统 | SQLite FTS | 未专项研究 | 待比较 |

### 3.2 OpenClaw 当前差距

| 差距维度 | Claude Code | claw-code | OpenClaw | 优先级 |
|----------|-------------|-----------|----------|--------|
| Tool 元数据 | ✅ 完整 | ❌ 缺失 | ❌ 仅 name/desc | P0 |
| 多级压缩 | ✅ 4级 | ⚠️ 1级 | ❌ 单一 | P0 |
| Skill frontmatter | ✅ 完整 | ❌ 缺失 | ⚠️ 部分字段 | P0 |
| 命令分类 | ✅ 100+类 | ❌ 无 | ❌ 无 | P0 |
| BashTool 验证 | ✅ 11模块 | ⚠️ 1模块 | ⚠️ 基础 | P1 |
| LSP 集成 | ✅ 完整 | ⚠️ 浅层 | ❌ 无 | P1 |
| Task 抽象 | ✅ 完整 | ⚠️ Registry | ⚠️ sessions_spawn | P1 |
| MCP 深度 | ✅ 完整 | ⚠️ lifecycle | ⚠️ 基础 | P1 |
| Green Contract | ❌ 无 | ✅ 创新 | ❌ 无 | P2 |
| Mock Parity | ❌ 无 | ✅ 44场景 | ❌ 无 | P2 |

### 3.3 优先级排序的改进建议

#### Phase 1 — 立即做（1-2周）

1. **扩展 Tool 接口元数据** (P0)
   - 添加 `getActivityDescription()`, `getToolUseSummary()`
   - 添加 `isConcurrencySafe`, `isReadOnly`, `isDestructive`
   - 添加 `renderToolUseMessage` UI 渲染支持
   - 参考 Claude Code `Tool.ts` 900行类型定义

2. **实现命令分类系统** (P0)
   - 创建 `command-classifier.ts`
   - 定义 100+ 命令类型
   - 集成到 exec 工具的权限判断
   - 集成到 UI 展示

3. **多级压缩系统** (P0)
   - 实现 Microcompact（工具结果 key-value 保留，value 截断）
   - 实现 HISTORY_SNIP（历史消息智能截断）
   - 添加 60 分钟无响应触发器
   - 实现 Context Collapse

4. **Skill frontmatter 扩展** (P0)
   - 添加 `whenToUse`, `paths`, `allowedTools`, `deniedTools`
   - 添加 `category`, `effort`, `model`, `shell`
   - 实现基于 glob 的条件激活

#### Phase 2 — 短期（1个月）

5. **BashTool 验证层** (P1)
   - Shell 解析预检查
   - 风险命令识别（rm -rf, dd, mkfs...）
   - 结果验证 + 语法错误检测

6. **Task 抽象统一化** (P1)
   - 统一 TaskCreate/List/Stop/Update 工具
   - TaskRegistry 状态管理
   - 跨会话 Task 续接

7. **MCP 深度集成** (P1)
   - MCP tool bridge
   - MCP auth flow
   - MCP resource 读写

#### Phase 3 — 中期（1-2个月）

8. **LSP 客户端集成** (P1)
   - 诊断信息获取
   - 代码补全桥接
   - 定义跳转

9. **Green Contract 测试框架** (P2)
   - 记录工具调用前后状态
   - 自动化回归测试
   - Mock parity 场景库

10. **Permission Enforcer 独立化** (P1)
    - 权限策略引擎
    - 跨工具统一权限检查
    - 可配置的权限规则

---

## 四、待进一步研究的文件（未覆盖）

### Claude Code 源码
- `ink/ink.tsx` (1722行) — Ink TUI 渲染引擎
- `cli/print.ts` (5594行) — CLI 输出
- `utils/ansiToPng.ts` (214K) — ANSI PNG 渲染
- `native-ts/` — color-diff, file-index, yoga-layout (3个 native 包)
- `buddy/` — Buddy 系统
- `voice/` — 语音功能

### claw-code rewrite
- `runtime/` 下 38 个模块的具体实现（已覆盖主要模块）
- `rusty-claude-cli/` 细节（仅知入口）

---

*文档生成: Saskia @ 2026-04-05*
