# Phase 1-5 升级文档

**时间：** 2026-04-06  
**执行者：** Saskia (AI Assistant)  
**基于：** claw-code + Claude Code 研究成果

---

## Phase 1: Doctor Diagnostic System

### 新增文件
```
src/diagnostics/
├── doctor.ts           (95行) - 主入口
├── renderer.ts         (45行) - ASCII box 渲染
└── checks/
    ├── gateway.ts      (55行) - Gateway 状态检查
    ├── nodes.ts        (118行) - Companion node 连接状态
    ├── memory.ts       (43行) - RAM 使用检查
    └── disk.ts         (59行) - 磁盘空间检查
```

### 功能
- `/doctor` 命令统一检查运行环境
- ASCII box 格式输出
- 检查项：Gateway / Nodes / Memory / Disk
- 无权限项输出 ⚠️ 而非 ❌

---

## Phase 2: Autonomous Error Catcher

### 新增文件
```
src/autonomous/
├── error-catcher.ts  (106行) - 全局异常拦截
├── classifier.ts     (147行) - 错误分类器
├── lessons.ts        (121行) - LESSONS.md 写入
└── fixer/
    └── registry.ts   (86行)  - 修复方法注册表
```

### 功能
- 拦截 `uncaughtException` 和 `unhandledRejection`
- 错误分类：network / permission / syntax / memory / unknown
- 写入 `.learnings/ERRORS.md` 和 `LESSONS.md`

---

## Phase 3: Mock Service + CLI Harness

### 新增文件
```
src/testing/
├── mock/
│   ├── service.ts      (436行) - Mock HTTP server (模拟 /v1/messages)
│   ├── scenarios.ts   (230行) - 测试场景定义
│   └── assertions.ts  (264行) - 断言库
├── harness/
│   ├── runner.ts      (432行) - CLI 测试 runner
│   └── parity-map.ts   (276行) - 行为映射
└── integration/
    └── ci-runner.ts   (407行) - CI 集成 / JUnit XML 输出
```

### 场景
- `streaming_text` - 普通流式文本
- `tool_call` - 工具调用
- `tool_result` - 工具结果返回
- `error_rate_limit` - Rate limit 错误
- `error_auth` - 认证错误

---

## Phase 4: Fixer Executor + Rollback

### 新增文件
```
src/autonomous/fixer/
├── executor.ts        (97行) - 修复执行器 + 指数退避重试
├── rollback.ts        (119行) - FIFO 回滚点管理 (默认10个)
└── index.ts           (3行)  - 模块导出
```

### 功能
- `executeFix()` - 根据错误类型执行修复
- `executeFixWithRetry()` - 指数退避，最多重试3次
- `executeBatchFix()` - 批量修复
- `RollbackManager` - 创建/回滚快照点

---

## Phase 5: Self-Check Scheduler

### 新增文件
```
src/autonomous/scheduler.ts  (165行)
```

### 功能
- 定期自检（默认每小时）
- 检查项：Gateway / 内存 / 磁盘 / 错误率
- 阈值：memoryPercent=85, diskPercent=90, errorRate=5
- `toCronConfig()` 生成 cron job 配置
- `onAlert` 回调支持自定义告警

---

## 代码统计

| Phase | 文件数 | 行数 |
|-------|--------|------|
| Phase 1 | 5 | ~300 |
| Phase 2 | 4 | ~460 |
| Phase 3 | 8 | ~2100 |
| Phase 4 | 3 | ~220 |
| Phase 5 | 1 | ~165 |
| **合计** | **21** | **~3245** |
