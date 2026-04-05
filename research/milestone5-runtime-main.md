# Milestone 5: claw-code runtime.py / main.py 研究

## 文件概览

| 文件 | 行数 | 职责 |
|-----|------|------|
| `src/runtime.py` | ~192行 | 会话运行时 + 路由引擎 |
| `src/main.py` | ~213行 | CLI 入口 + 子命令解析 |
| `src/parity_audit.py` | ~140行 | 与原始 TS 存档一致性校验 |
| `src/query_engine.py` | ~196行 | (补充参考) 查询引擎移植 |

---

## 1. runtime.py — PortRuntime 类

### 核心设计

```python
class PortRuntime:
    def route_prompt(self, prompt: str, limit: int = 5) -> list[RoutedMatch]:
        """将用户 prompt 路由到 command/tool 匹配"""
        tokens = {token.lower() for token in prompt.replace('/', ' ').replace('-', ' ').split() if token}
        by_kind = {
            'command': self._collect_matches(tokens, PORTED_COMMANDS, 'command'),
            'tool': self._collect_matches(tokens, PORTED_TOOLS, 'tool'),
        }
        # 每个kind取最佳匹配，然后填满limit
        selected: list[RoutedMatch] = []
        for kind in ('command', 'tool'):
            if by_kind[kind]:
                selected.append(by_kind[kind].pop(0))
        # 剩余按分数排序
        leftovers = sorted(
            [match for matches in by_kind.values() for match in matches],
            key=lambda item: (-item.score, item.kind, item.name),
        )
        selected.extend(leftovers[: max(0, limit - len(selected))])
        return selected[:limit]
```

### 路由算法

1. **tokenization**: `prompt → {tokens}` (去除 `/` 和 `-`)
2. **打分**: 对每个 PORTED_MODULE，检查 token 是否出现在 name/source_hint/responsibility 中
3. **选择**: command 和 tool 各取最佳，然后按分数混合填满 limit

```python
@staticmethod
def _score(tokens: set[str], module: PortingModule) -> int:
    haystacks = [module.name.lower(), module.source_hint.lower(), module.responsibility.lower()]
    score = 0
    for token in tokens:
        if any(token in haystack for haystack in haystacks):
            score += 1
    return score
```

### bootstrap_session

```python
def bootstrap_session(self, prompt: str, limit: int = 5) -> RuntimeSession:
    context = build_port_context()           # 构建端口上下文
    setup_report = run_setup(trusted=True)  # 运行设置报告
    history = HistoryLog()                  # 历史日志
    engine = QueryEnginePort.from_workspace() # 创建查询引擎
    matches = self.route_prompt(prompt, limit=limit)
    
    # 构建执行注册表并执行
    registry = build_execution_registry()
    command_execs = tuple(registry.command(match.name).execute(prompt) ...)
    tool_execs = tuple(registry.tool(match.name).execute(prompt) ...)
    
    # 推断权限拒绝 (bash工具被拒绝)
    denials = tuple(self._infer_permission_denials(matches))
    
    # 流式提交 + 正式提交
    stream_events = tuple(engine.stream_submit_message(...))
    turn_result = engine.submit_message(...)
    persisted_session_path = engine.persist_session()
    
    return RuntimeSession(...)
```

### _infer_permission_denials

```python
def _infer_permission_denials(self, matches: list[RoutedMatch]) -> list[PermissionDenial]:
    denials: list[PermissionDenial] = []
    for match in matches:
        if match.kind == 'tool' and 'bash' in match.name.lower():
            denials.append(PermissionDenial(
                tool_name=match.name,
                reason='destructive shell execution remains gated in the Python port'
            ))
    return denials
```

这是一个**保守的权限模型**: bash 工具默认被拒绝。

### run_turn_loop

```python
def run_turn_loop(self, prompt: str, limit: int = 5, max_turns: int = 3, structured_output: bool = False) -> list[TurnResult]:
    engine = QueryEnginePort.from_workspace()
    engine.config = QueryEngineConfig(max_turns=max_turns, structured_output=structured_output)
    matches = self.route_prompt(prompt, limit=limit)
    command_names = tuple(match.name for match in matches if match.kind == 'command')
    tool_names = tuple(match.name for match in matches if match.kind == 'tool')
    results: list[TurnResult] = []
    for turn in range(max_turns):
        turn_prompt = prompt if turn == 0 else f'{prompt} [turn {turn + 1}]'
        result = engine.submit_message(turn_prompt, command_names, tool_names, ())
        results.append(result)
        if result.stop_reason != 'completed':
            break
    return results
```

---

## 2. RuntimeSession 数据类

```python
@dataclass
class RuntimeSession:
    prompt: str
    context: PortContext
    setup: WorkspaceSetup
    setup_report: SetupReport
    system_init_message: str
    history: HistoryLog
    routed_matches: list[RoutedMatch]
    turn_result: TurnResult
    command_execution_messages: tuple[str, ...]
    tool_execution_messages: tuple[str, ...]
    stream_events: tuple[dict[str, object], ...]
    persisted_session_path: str

    def as_markdown(self) -> str:
        """生成 Markdown 格式的会话报告"""
        # ... 生成完整的会话调试报告
```

这是一个**自包含的会话快照**，包含路由、执行、历史和持久化路径。

---

## 3. main.py — CLI 入口

### 子命令列表

```
summary          — 渲染 Python 工作区摘要
manifest         — 打印当前 Python 工作区清单
parity-audit     — 对比 Python 工作区 vs 原始 TS 存档
setup-report     — 渲染启动/预取设置报告
command-graph    — 显示命令图分割
tool-pool        — 显示组装好的工具池
bootstrap-graph  — 显示镜像的 bootstrap/runtime 图阶段
subsystems       — 列出当前 Python 工作区模块
commands         — 列出镜像的命令条目
tools            — 列出镜像的工具条目
route            — 在镜像的命令/工具清单上路由 prompt
bootstrap        — 从镜像清单构建运行时风格会话报告
turn-loop        — 运行小型有状态轮次循环
flush-transcript — 持久化并 flush 临时会话转录本
load-session     — 加载先前持久化的会话
remote-mode      — 模拟远程控制运行时分支
ssh-mode         — 模拟 SSH 运行时分支
teleport-mode    — 模拟 teleport 运行时分支
direct-connect-mode — 模拟 direct-connect 运行时分支
deep-link-mode   — 模拟 deep-link 运行时分支
show-command     — 按名称显示一个镜像命令条目
show-tool        — 按名称显示一个镜像工具条目
exec-command     — 按名称执行镜像命令 shim
exec-tool        — 按名称执行镜像工具 shim
```

### parity-audit 命令

```python
if args.command == 'parity-audit':
    print(run_parity_audit().to_markdown())
    return 0
```

调用 `parity_audit.py` 的 `run_parity_audit()`。

---

## 4. parity_audit.py — 一致性校验

### 存档映射

```python
ARCHIVE_ROOT_FILES = {
    'QueryEngine.ts': 'QueryEngine.py',
    'Task.ts': 'task.py',
    'Tool.ts': 'Tool.py',
    'commands.ts': 'commands.py',
    # ... 共21个根文件
}

ARCHIVE_DIR_MAPPINGS = {
    'assistant': 'assistant',
    'bootstrap': 'bootstrap',
    'bridge': 'bridge',
    # ... 共33个目录
}
```

### 审计指标

```python
@dataclass(frozen=True)
class ParityAuditResult:
    archive_present: bool              # 存档是否存在
    root_file_coverage: tuple[int, int]  # 根文件覆盖率
    directory_coverage: tuple[int, int]  # 目录覆盖率
    total_file_ratio: tuple[int, int]    # Python文件 vs 存档TS文件
    command_entry_ratio: tuple[int, int]  # 命令条目覆盖率
    tool_entry_ratio: tuple[int, int]    # 工具条目覆盖率
    missing_root_targets: tuple[str, ...] # 缺失的根文件
    missing_directory_targets: tuple[str, ...] # 缺失的目录
```

### 引用数据源

```python
REFERENCE_SURFACE_PATH = CURRENT_ROOT / 'reference_data' / 'archive_surface_snapshot.json'
COMMAND_SNAPSHOT_PATH = CURRENT_ROOT / 'reference_data' / 'commands_snapshot.json'
TOOL_SNAPSHOT_PATH = CURRENT_ROOT / 'reference_data' / 'tools_snapshot.json'
```

这些 JSON 文件作为 "ground truth"，记录了原始 TS 代码库的统计信息。

---

## 5. query_engine.py — QueryEnginePort (补充)

### 配置

```python
@dataclass(frozen=True)
class QueryEngineConfig:
    max_turns: int = 8
    max_budget_tokens: int = 2000
    compact_after_turns: int = 12
    structured_output: bool = False
    structured_retry_limit: int = 2
```

### 消息压缩

```python
def compact_messages_if_needed(self) -> None:
    if len(self.mutable_messages) > self.config.compact_after_turns:
        self.mutable_messages[:] = self.mutable_messages[-self.config.compact_after_turns:]
    self.transcript_store.compact(self.config.compact_after_turns)
```

简单切片式压缩，保留最近 N 条消息。

### 流式事件

```python
def stream_submit_message(self, prompt, matched_commands=(), matched_tools=(), denied_tools=()):
    yield {'type': 'message_start', 'session_id': self.session_id, 'prompt': prompt}
    if matched_commands:
        yield {'type': 'command_match', 'commands': matched_commands}
    if matched_tools:
        yield {'type': 'tool_match', 'tools': matched_tools}
    if denied_tools:
        yield {'type': 'permission_denial', 'denials': [denial.tool_name for denial in denied_tools]}
    result = self.submit_message(prompt, matched_commands, matched_tools, denied_tools)
    yield {'type': 'message_delta', 'text': result.output}
    yield {
        'type': 'message_stop',
        'usage': {'input_tokens': result.usage.input_tokens, 'output_tokens': result.usage.output_tokens},
        'stop_reason': result.stop_reason,
        'transcript_size': len(self.transcript_store.entries),
    }
```

---

## 与 TypeScript 原始代码的关键差异

| 方面 | TypeScript (QueryEngine.ts) | Python (claw-code) |
|-----|---------------------------|-------------------|
| 消息流 | AsyncGenerator + normalizeMessage | yield dict 事件 |
| 权限模型 | wrappedCanUseTool 装饰器 | _infer_permission_denials (启发式) |
| 使用量追踪 | accumulateUsage / updateUsage | UsageSummary.add_turn(token估算) |
| 压缩 | splice + compact_boundary | 简单切片 [-N:] |
| 路由 | getSlashCommandToolSkills + loadAllPluginsCacheOnly | _score() token匹配 |
| 执行 | query() 核心引擎 | execution_registry.command().execute() |
| 会话持久化 | recordTranscript + flushSessionStorage | save_session(StoredSession) |

---

## 架构洞察

### Python 版本是"镜像+审计"工具，而非替代品

从 main.py 的子命令来看，这个项目的目的不是运行生产 Claude Code，而是：

1. **镜像** TypeScript 代码结构到 Python
2. **审计** 移植覆盖率 (`parity-audit`)
3. **验证** 移植完整性 (`commands`, `tools`, `route`, `bootstrap`)
4. **提供** 运行时风格报告 (`bootstrap`, `turn-loop`, `summary`)

Python 版本的 `QueryEnginePort.submit_message()` **不做真实 API 调用**，只是模拟流程并生成摘要输出。

### 保守的权限模型

`_infer_permission_denials` 将所有 bash 相关工具标记为拒绝，这是合理的——Python 版本的工具执行没有被信任，所以默认拒绝 shell 执行。

### 分层路由 vs 直接执行

TypeScript 版本在 `submitMessage` 内部通过 `processUserInput` 做路由，而 Python 版本在 `bootstrap_session` 阶段就用 `route_prompt` 预路由，然后传给 `engine.submit_message()`。

这是因为 Python 版本不需要真实执行工具，所以可以提前路由并显示匹配结果。
