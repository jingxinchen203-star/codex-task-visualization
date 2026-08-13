# Codex Projectboard

一个面向 Windows 版 Codex Desktop 的本地五栏任务看板。它把当前账户中的活动与归档任务投影到 Codex 右侧工作区，方便集中查看、回到原任务，以及在本机整理栏位。

> 当前版本是 Phase 1 的安全预览：读取 Codex 任务，但不修改 Codex 任务状态，不创建任务或模型回合，也不写入 Git。

## 功能

- 五栏工作区：收集箱、已规划、执行中、待验收、完成。
- 完整分页读取活动与归档任务，并排除内部子代理记录。
- 点击任务标题可回到原 Codex 任务。
- 通过卡片上的“移动到其他栏”在本机整理任务；栏位状态保存到 `%LOCALAPPDATA%\CodexProjectboard\lane-overrides.v1.json`。
- 每 30 秒刷新任务目录；本地栏位移动不依赖目录刷新成功。
- 支持 Codex 右侧展开/收起，并保留原生左侧导航。

目前没有拖放操作。请使用每张卡片上的“移动到其他栏”。

界面的视觉、状态语义、字体、交互与可访问性约定见 [设计语言](design.md)。

## 安全边界

- 只使用 `--remote-debugging-pipe`，不开放调试 TCP 端口。
- 侧栏文档离线、无脚本、无远程资源，CSP 禁止脚本和网络连接。
- App Server 出站方法限定为初始化、`account/read` 和分页 `thread/list`。
- 不启动、恢复、引导、中断、归档、删除或批准 Codex 任务。
- 本地栏位变化只影响 Projectboard 投影，不会改变 Codex 中的真实任务状态。

更完整的边界说明见 [Phase 1 文档](docs/phase-1-readonly-board.md) 和 [Phase 0 runbook](docs/phase-0-runbook.md)。

## 环境要求

- Windows 10/11
- 已安装并登录 Codex Desktop
- Node.js `>= 22.12.0`
- Windows PowerShell 5.1 或 PowerShell 7
- 与当前 Codex 包版本兼容、已封存的本机 Phase 0 报告

Phase 0 报告和运行产物包含环境绑定信息，因此不会提交到公开仓库。首次使用者需要按照 `docs/phase-0-runbook.md` 在自己的环境中生成报告；不要复制他人的报告。

## 启动右侧看板

1. 完全退出 Codex Desktop。
2. 在仓库根目录双击 `Start-Codex-Projectboard.cmd`，或运行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts\start-projectboard-sidebar.ps1
```

3. 保持控制器终端窗口运行。关闭由它启动的 Codex 后，控制器会自动退出。

也可以启动独立的本地只读看板：

```powershell
npm.cmd run board
```

启动日志写入 `artifacts\phase-1\sidebar-startup-latest.log`；`artifacts/` 已被 Git 忽略。

## 测试

```powershell
npm.cmd test
```

聚焦 Phase 1：

```powershell
node --test tests/unit/phase1-*.test.js tests/integration/phase1-readonly-server.test.js
```

## 项目状态

当前版本完成了可用的五栏读取、原任务导航和本地栏位编排。正式写入 Codex 任务、拖放执行、模型回合和其他注入式能力仍然是 No-Go，除非未来获得官方宿主扩展合同或通过新的明确安全门槛。
