# Milestone 2: Python vs TypeScript 对照

## Python 重写的架构定位

claw-code 的 Python 工作区并非追求运行时等价，而是作为一个**元数据镜像和可读性建模层**存在。

---

## 目录结构对比

### TypeScript 原版（推测）
```
src/
├── commands/      # 命令实现
├── tools/         # 工具实现
├── models/        # 数据模型
├── runtime/       # 运行时核心
├── session/      # 会话管理
├── ui/            # TUI/界面
└── main.ts        # 入口
```

### Python 移植版
```
src/
├── __init__.py
├── main.py              # CLI 入口
├── models.py            # 所有 dataclass（集中式）
├── port_manifest.py     # 工作区清单
├── query_engine.py      # 会话/查询引擎
├── commands.py          # 命令快照（镜像）
├── tools.py             # 工具快照（镜像）
├── task.py              # 任务结构
├── permissions.py       # 权限上下文
├── session_store.py     # 会话持久化
├── transcript.py        # 转录存储
├── runtime.py           # 运行时抽象
├── bootstrap_graph.py   # 引导图
├── command_graph.py     # 命令图
├── parity_audit.py      # parity 审计
├── direct_modes.py      # 直连模式
├── remote_runtime.py    # 远程运行时
├── setup.py             # 设置/预取
├── tool_pool.py         # 工具池组装
└── reference_data/      # JSON 快照（commands_snapshot.json, tools_snapshot.json）
```

**关键差异**：Python 版本添加了大量**元数据层**（parity_audit, bootstrap_graph, command_graph, tool_pool），这些在 TS 版中可能散落在各处或不存在。

---

## dataclass 设计分析（models.py）

### 核心不可变类型

```python
@dataclass(frozen=True)
class Subsystem:
    name: str
    path: str
    file_count: int
    notes: str

@dataclass(frozen=True)
class PortingModule:
    name: str
    responsibility: str
    source_hint: str
    status: str = 'planned'

@dataclass(frozen=True)
class PermissionDenial:
    tool_name: str
    reason: str

@dataclass(frozen=True)
class UsageSummary:
    input_tokens: int = 0
    output_tokens: int = 0
    # 不可变式累加
    def add_turn(self, prompt: str, output: str) -> 'UsageSummary': ...

@dataclass(frozen=True)
class PortingBacklog:
    title: str
    modules: list[PortingModule] = field(default_factory=list)
    def summary_lines(self) -> list[str]: ...

@dataclass(frozen=True)
class QueryEngineConfig:
    max_turns: int = 8
    max_budget_tokens: int = 2000
    compact_after_turns: int = 12
    structured_output: bool = False
    structured_retry_limit: int = 2

@dataclass(frozen=True)
class TurnResult:
    prompt: str
    output: str
    matched_commands: tuple[str, ...]
    matched_tools: tuple[str, ...]
    permission_denials: tuple[PermissionDenial, ...]
    usage: UsageSummary
    stop_reason: str
```

### 可变状态容器

```python
@dataclass
class QueryEnginePort:
    manifest: PortManifest
    config: QueryEngineConfig = field(default_factory=QueryEngineConfig)
    session_id: str = field(default_factory=lambda: uuid4().hex)
    mutable_messages: list[str] = field(default_factory=list)
    permission_denials: list[PermissionDenial] = field(default_factory=list)
    total_usage: UsageSummary = field(default_factory=UsageSummary)
    transcript_store: TranscriptStore = field(default_factory=TranscriptStore)
```

**设计特点**：
- 所有"值对象"用 `frozen=True` 不可变 dataclass
- 可变状态集中在 `QueryEnginePort` 一个类中
- 使用 tuple 而非 list 表示有序不可变集合
- `UsageSummary.add_turn()` 返回新实例（纯函数式风格）

---

## QueryEngine 分析

### 核心职责

`QueryEnginePort` 是 Python 版本的会话/查询管理层：

```
submit_message(prompt, matched_commands, matched_tools, denied_tools)
  → TurnResult

stream_submit_message(...)  # 生成器版本
  → yield {'type': 'message_start', ...}
  → yield {'type': 'command_match', ...}
  → yield {'type': 'tool_match', ...}
  → yield {'type': 'permission_denial', ...}
  → yield {'type': 'message_delta', ...}
  → yield {'type': 'message_stop', ...}
```

### budget 控制逻辑

```python
projected_usage = self.total_usage.add_turn(prompt, output)
stop_reason = 'completed'
if projected_usage.input_tokens + projected_usage.output_tokens > self.config.max_budget_tokens:
    stop_reason = 'max_budget_reached'
```

### transcript compaction

```python
def compact_messages_if_needed(self) -> None:
    if len(self.mutable_messages) > self.config.compact_after_turns:
        self.mutable_messages[:] = self.mutable_messages[-self.config.compact_after_turns:]
    self.transcript_store.compact(self.config.compact_after_turns)
```

### structured output 支持

```python
def _render_structured_output(self, payload: dict) -> str:
    for _ in range(self.config.structured_retry_limit):
        try:
            return json.dumps(payload, indent=2)
        except (TypeError, ValueError):
            payload = {'summary': ['structured output retry'], 'session_id': self.session_id}
    raise RuntimeError('structured output rendering failed')
```

### 会话持久化

```python
def persist_session(self) -> str:
    self.flush_transcript()
    path = save_session(StoredSession(...))
    return str(path)
```

---

## 架构改进总结

| 维度 | TypeScript 原版 | Python 移植版 |
|------|----------------|---------------|
| 数据建模 | 散落各处 | 集中式 immutable dataclass |
| 会话管理 | 无专门抽象 | QueryEnginePort 统一封装 |
| Token 预算 | 未见 | UsageSummary 纯函数跟踪 |
| Session 持久化 | 无 | session_store + transcript_store |
| 输出格式 | 文本为主 | structured_output 开关支持 |
| 命令/工具 | 运行时实现 | 快照 JSON + lru_cache 惰性加载 |
| 元数据 | 无 | parity_audit, bootstrap_graph, tool_pool |

---

## Python 作为"镜像元数据层"的意义

Python 版本不追求运行时替代，而是：
1. **快照管理**：用 JSON snapshot 镜像原 TS 源码表面
2. **可读性建模**：dataclass 让系统结构一目了然
3. **Parity 追踪**：parity_audit 模块可对照检查进度
4. **原型验证**：query_engine 的会话逻辑可在 Rust 实现前验证

真正可执行的是 Rust 工作区。Python 层是**文档化和理解工具**。
