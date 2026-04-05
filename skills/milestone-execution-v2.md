---
name: milestone-execution
version: 2.0.0
description: "User controls the conversation, AI executes autonomously in a single session. Each milestone completes and reports with detailed progress before waiting for user input. Supports: rich reporting, progress tracking, time estimates, error recovery, parallel milestones, and automatic cleanup. Use when: (1) user assigns a multi-stage task, (2) user wants to control pace and checkpoints, (3) work needs to happen in background while user directs."
---

# Milestone Execution v2.0

**核心理念：** 你控制行动权，我在单一独立会话里执行所有 milestone，完成后汇报等你指令。

## 交互架构（单一会话模式）

```
你的主会话（控制层）
     ↑ sessions_send (发送指令)
     ↓ sessions_yield (等待回复)
独立工作会话（执行层）
     ↓ sessions_send (汇报 + 暂停)
     ↑ sessions_yield (等待唤醒)
```

**关键改进：**
- ✅ 单一会话完成所有 milestone（不复用会话）
- ✅ sessions_yield 主动暂停（不占用资源）
- ✅ 自动关闭（任务完成后工作会话关闭自己）

---

## 你的操作方式

| 指令 | 行为 |
|------|------|
| `"开始 [任务]"` | 启动独立工作会话开始执行 |
| `"停下"` | 工作会话暂停当前操作 |
| `"汇报"` | 我报告当前进度和状态 |
| `"继续"` | 工作会话恢复执行 |
| `"修改 [内容]"` | 调整当前阶段或任务方向 |
| `"retry"` | 重试当前 milestone |
| `"skip"` | 跳过当前 milestone |
| `"rollback"` | 回滚到上一个 milestone |
| `"停止"` | 关闭工作会话，任务结束 |
| `"恢复"` | 从中断恢复（如果会话崩溃） |

---

## 汇报格式（增强版）

每阶段完成时推送：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Milestone 2/5 完成
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ 已完成：
   • 添加 isInteractiveCommand 函数
   • 添加 BASH_INTERACTIVE_COMMANDS Set

📁 输出文件：
   • src/agents/bash-tools.exec.ts (+38行)

⏱️ 用时：3分12秒
🔧 Token消耗：1.2M

⚠️ 遇到的问题：
   • TypeScript 类型检查失败（已修复）

🎯 整体进度：
   [████████░░░░░░░░░░░] 40%
   Milestone 1: ✅
   Milestone 2: ✅ (当前)
   Milestone 3: 🔄 即将开始
   Milestone 4: ⏳ 等待中
   Milestone 5: ⏳ 等待中

⏱️ 预计剩余时间：12分钟
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

→ "继续" 执行下一阶段
→ "retry" 重试当前
→ "skip" 跳过当前
→ "rollback" 回滚
→ "修改 X" 调整当前方向
→ "停止" 结束任务
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 整体进度追踪

工作会话维护一个进度状态，包含：

```
任务总览：
• 总 milestone 数：5
• 当前 milestone：2
• 完成数：1
• 跳过数：0
• 失败数：0

进度条：[████████░░░░░░░░░░░] 40%

每个 milestone 状态：
  [1] ✅ Context管理 - 2分钟前完成
  [2] ✅ Tool系统 - 刚刚完成
  [3] 🔄 Memory系统 - 进行中
  [4] ⏳ Agent/Task - 等待中
  [5] ⏳ 高级功能 - 等待中
```

---

## 时间预估

系统根据历史数据估算：

```
当前 milestone 预计：3-5分钟
整体预计剩余：12分钟
总任务预计：20-25分钟
```

---

## 错误处理机制

| 指令 | 行为 |
|------|------|
| `retry` | 重试当前 milestone（最多3次） |
| `skip` | 跳过当前 milestone，记录为"跳过" |
| `rollback` | 回滚到上一个完成 milestone 的状态 |
| `force-continue` | 忽略错误强制继续（谨慎使用） |

**自动重试策略：**
- 首次失败：自动重试 1 次
- 第二次失败：暂停等待用户指令
- 记录失败原因到 milestone 状态

---

## 并行 milestone（可选）

对于完全独立的 milestone，可以并行执行：

```
检测到可并行的 milestone：
  • Milestone 2 (Tool元数据) - 独立
  • Milestone 4 (MCP集成) - 独立

是否并行执行？[是/否/仅Milestone X]
```

**并行执行时：**
- 两个 milestone 同时运行
- 都完成后汇报
- 一个失败不影响另一个

---

## 上下文持久化

工作会话保存状态到文件：

```json
// .milestone-state.json
{
  "task": "OpenClaw 优化",
  "milestones": [
    { "id": 1, "status": "completed", "output": "..." },
    { "id": 2, "status": "completed", "output": "..." },
    { "id": 3, "status": "running", "startedAt": "..." }
  ],
  "createdAt": "2026-04-05T...",
  "lastUpdated": "2026-04-05T..."
}
```

**崩溃恢复：**
- 检测到上次会话中断 → 询问是否恢复
- 从 `.milestone-state.json` 读取状态
- 从中断点继续

---

## Milestone 历史记录

所有 milestone 执行记录：

```
📜 Milestone 历史
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[1] 14:30 - Context管理 - ✅ (3分钟)
[2] 14:33 - Tool系统 - ✅ (4分钟)
[3] 14:37 - Memory系统 - ⏭️ 跳过
[4] 14:40 - Agent/Task - ✅ (8分钟)
[5] 14:48 - 高级功能 - ✅ (12分钟)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
总用时：27分钟 | Token消耗：8.5M
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 实现方式

- 用 `sessions_spawn` (runtime: "acp") 启动**单一**工作会话
- 用 `sessions_send` 向工作会话发送指令（continue/retry/skip等）
- 工作会话用 `sessions_yield()` 暂停等待唤醒
- 汇报通过 `sessions_send` 发送到主会话的 `sessionKey`
- 状态文件保存到 `.milestone-state.json`
- 所有 milestone 在**同一会话**中执行完成

---

## 适用场景

- 多步骤重构
- 大型代码审查
- 需要逐步确认的构建任务
- 任何可拆解的复杂任务
- 需要后台运行同时你可以做其他事
- 长时间运行的自动化任务

## 不适用

- 单步简单任务（直接做完不汇报）
- 需要实时反馈才能继续的操作
- 极度危险的操作（建议分开执行）

## 工作会话终止条件

工作会话在以下情况结束：
1. 用户说"停止"
2. 所有 milestone 完成（包括跳过的）
3. 出现无法恢复的错误（最多 retry 3 次）
4. 用户主动关闭会话
5. 任务超时（可配置，默认无限制）

## 会话清理

任务完成后：
1. 工作会话发送最终汇报
2. 清理 `.milestone-state.json` 或保留（可配置）
3. 工作会话调用 `sessions_yield()` 永久挂起或关闭
4. 主会话收到"任务完成"通知

## 注意事项

- 工作会话是独立的，有自己的上下文
- 状态文件用于崩溃恢复
- 汇报推送到主会话（当前 chat）
- Token 消耗会显示在汇报中
