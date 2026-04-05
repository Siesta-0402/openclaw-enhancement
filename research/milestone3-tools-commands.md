# Milestone 3: 工具和命令系统对比

## 概述

Python 版本中，`tools.py` 和 `commands.py` 都是**快照镜像层**——从 `reference_data/` 下的 JSON 文件加载元数据，不做真正的运行时执行。

---

## 工具系统（tools.py）

### 快照加载机制

```python
SNAPSHOT_PATH = Path(__file__).resolve().parent / 'reference_data' / 'tools_snapshot.json'

@lru_cache(maxsize=1)
def load_tool_snapshot() -> tuple[PortingModule, ...]:
    raw_entries = json.loads(SNAPSHOT_PATH.read_text())
    return tuple(
        PortingModule(name=entry['name'], responsibility=entry['responsibility'],
                      source_hint=entry['source_hint'], status='mirrored')
        for entry in raw_entries
    )
```

`lru_cache(maxsize=1)` 确保只读一次，后续调用直接返回缓存的 tuple。

### 核心 API

| 函数 | 作用 |
|------|------|
| `PORTED_TOOLS` | 全局工具元组（快照） |
| `get_tool(name)` | 按名称精确查找 |
| `tool_names()` | 所有工具名列表 |
| `find_tools(query, limit)` | 模糊搜索 |
| `get_tools(simple_mode, include_mcp, permission_context)` | 条件过滤 |
| `execute_tool(name, payload)` | 模拟执行（返回执行信息） |
| `render_tool_index(limit, query)` | 渲染索引文本 |

### 过滤条件

```python
def get_tools(simple_mode=False, include_mcp=True, permission_context=None):
    tools = list(PORTED_TOOLS)
    if simple_mode:
        # 只保留核心工具
        tools = [m for m in tools if m.name in {'BashTool', 'FileReadTool', 'FileEditTool'}]
    if not include_mcp:
        # 过滤掉 MCP 相关
        tools = [m for m in tools if 'mcp' not in m.name.lower()]
    return filter_tools_by_permission_context(tuple(tools), permission_context)
```

### 权限上下文过滤

```python
def filter_tools_by_permission_context(tools, permission_context):
    if permission_context is None:
        return tools
    return tuple(m for m in tools if not permission_context.blocks(m.name))
```

---

## 命令系统（commands.py）

### 与 tools.py 的镜像结构

```python
SNAPSHOT_PATH = Path(__file__).resolve().parent / 'reference_data' / 'commands_snapshot.json'

@lru_cache(maxsize=1)
def load_command_snapshot() -> tuple[PortingModule, ...]:
    raw_entries = json.loads(SNAPSHOT_PATH.read_text())
    ...

PORTED_COMMANDS = load_command_snapshot()

@lru_cache(maxsize=1)
def built_in_command_names() -> frozenset[str]:
    return frozenset(module.name for module in PORTED_COMMANDS)
```

### 核心 API

| 函数 | 作用 |
|------|------|
| `PORTED_COMMANDS` | 全局命令元组（快照） |
| `get_command(name)` | 按名称精确查找 |
| `command_names()` | 所有命令名列表 |
| `find_commands(query, limit)` | 模糊搜索 |
| `get_commands(cwd, include_plugin_commands, include_skill_commands)` | 条件过滤 |
| `execute_command(name, prompt)` | 模拟执行 |
| `render_command_index(limit, query)` | 渲染索引文本 |

### 过滤条件

```python
def get_commands(cwd=None, include_plugin_commands=True, include_skill_commands=True):
    commands = list(PORTED_COMMANDS)
    if not include_plugin_commands:
        commands = [m for m in commands if 'plugin' not in m.source_hint.lower()]
    if not include_skill_commands:
        commands = [m for m in commands if 'skills' not in m.source_hint.lower()]
    return tuple(commands)
```

---

## 快照数据结构

每个快照条目：
```json
{
  "name": "BashTool",
  "responsibility": "Executes shell commands in the workspace",
  "source_hint": "src/tools/bash.ts"
}
```

### 工具快照 vs 命令快照

- **工具**（tools.py）：来自 `src/tools/*.ts`，如 `BashTool`, `FileReadTool`, `GrepTool`, `WebFetchTool` 等
- **命令**（commands.py）：来自 `src/commands/*.ts`，如 `/bug`, `/test`, `/plan` 等 slash commands

---

## 执行模拟（Shim Layer）

```python
def execute_tool(name: str, payload: str = '') -> ToolExecution:
    module = get_tool(name)
    if module is None:
        return ToolExecution(..., handled=False, message=f'Unknown mirrored tool: {name}')
    action = f"Mirrored tool '{module.name}' from {module.source_hint} would handle payload {payload!r}."
    return ToolExecution(..., handled=True, message=action)
```

这是一个**桩实现**——返回描述性消息，但不真正执行工具。真正的执行逻辑在 Rust 工作区。

---

## Rust 工具 surface（真实可执行）

根据 PARITY.md，Rust `mvp_tool_specs()` 暴露 **40 个工具**：

**核心执行**：
- `bash` — shell 执行
- `read_file` — 文件读取
- `write_file` — 文件写入
- `edit_file` — 文件编辑
- `glob_search` — glob 搜索
- `grep_search` — grep 搜索

**产品工具**：
- `WebFetch`, `WebSearch` — 网页
- `TodoWrite` — 任务列表
- `Agent` — 子 agent
- `Skill` — 技能调用
- `ToolSearch` — 工具搜索
- `NotebookEdit` — notebook 编辑
- `Sleep`, `SendUserMessage` — 控制
- `Config` — 配置
- `EnterPlanMode`, `ExitPlanMode` — 计划模式
- `StructuredOutput` — 结构化输出
- `REPL`, `PowerShell` — 交互

**高级工具（已从 stub 升级为 registry-backed）**：
- `TaskCreate`, `TaskGet`, `TaskList`, `TaskStop`, `TaskUpdate`, `TaskOutput` — TaskRegistry
- `TeamCreate`, `TeamDelete` — TeamRegistry
- `CronCreate`, `CronDelete`, `CronList` — CronRegistry
- `LSP` — LSP client
- MCP tools: `ListMcpResources`, `ReadMcpResource`, `McpAuth`, `MCP`

**受限/桩**：
- `AskUserQuestion` — 桩返回 pending
- `RemoteTrigger` — 桩
- `TestingPermission` — 仅测试用

---

## 权限系统

Rust 端实现了完整的 `PermissionEnforcer`：

```rust
// rust/crates/runtime/src/permission_enforcer.rs
pub struct PermissionEnforcer { ... }
impl PermissionEnforcer {
    pub fn check_file_write(&self, path: &Path) -> CheckResult;
    pub fn check_bash(&self, cmd: &str) -> CheckResult;
    pub fn enforce_permission_check(&self, tool_name: &str) -> bool;
}
```

Python 端对应 `ToolPermissionContext`：

```python
# permissions.py
class ToolPermissionContext:
    denied_tools: frozenset[str]
    denied_prefixes: frozenset[str]
    def blocks(self, tool_name: str) -> bool: ...
    @classmethod
    def from_iterables(cls, deny_tool, deny_prefix): ...
```

---

## 总结：Python 工具层 vs Rust 工具层

| 维度 | Python (tools.py) | Rust (mvp_tool_specs) |
|------|-------------------|----------------------|
| 数据来源 | JSON 快照 | 代码中硬编码 Spec |
| 执行方式 | 模拟 shim（返回描述） | 真实 `execute_tool()` |
| 权限 | ToolPermissionContext | PermissionEnforcer |
| 数量 | 快照数量（~40） | 40 个 real tool specs |
| 状态管理 | 无状态 | TaskRegistry, TeamRegistry 等 |
| MCP | 快照过滤 | MCP lifecycle bridge |
