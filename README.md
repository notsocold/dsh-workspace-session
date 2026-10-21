# dsh-workspace-session

把**工作区会话**保存到项目目录，随 git 跨机器同步；原生会话照常可用。

> 当前为方案 B：**镜像 + 自动导入**。DSH 原生存储 `$DSH_HOME/sessions` 仍然是运行时存储，插件把属于工作区的会话镜像成纯文本快照 `<workspace>/.dsh/sessions/`，并在本机导入回原生存储。

---

## 功能

| 能力 | 说明 |
|---|---|
| 会话随项目提交 | 属于工作区的会话导出为 `<workspace>/.dsh/sessions/<session-id>/session.v4.jsonl`，纯文本、可 diff |
| 跨机器同步 | 另一台机器 `git pull` 后，插件把快照导入本机原生存储并挂到工作区 |
| 兼容原生 | `~/.dsh/sessions` 完全不动；不属于工作区的会话保持原样 |
| 自动导入导出 | 每轮结束防抖导出、会话关闭导出、启动/添加工作区导入、定时轮询 |
| 冲突保护 | fast-forward 自动；分叉时备份两份，默认把远端分支另存为新会话 |
| 设置页 | 设置 → 工作区会话：状态、工作区列表、开关、手动同步、冲突记录 |

## 不做什么

- 不替换 DSH 的 `session-persistence-jsonl` 行，不改任何 Harness 源码；
- 不自动 `git commit` / `git push`（只写文件，提交由你完成）；
- 不合并两份分叉的会话（DSH 事件日志不允许这样合并）；
- v1 不镜像附件、记忆、技能（见“资源边界”）。

---

## 目录布局

```text
<workspace>/
├── AGENTS.md                          # 原生项目指令（本插件不碰）
└── .dsh/
    ├── sessions/                      # ★ 工作区会话快照（随 git）
    │   └── session-1a2b.../
    │       └── session.v4.jsonl       # 第一行 header + 每行一个事件
    ├── workspace-session.json         # 快照索引：originCwd / 事件数 / 指纹 / 最后写入机器
    └── skills/                        # 原生项目技能（本插件不碰）

~/.dsh/sessions/                       # 原生存储（运行时，zstd）
~/.dsh/dsh-workspace-session/          # 本机插件状态（不随 git）
├── config.json
├── state.json
└── machine-id
```

快照的第一行是会话 header，其中 `cwd` 是会话**原始项目路径**（`originCwd`）；导入到另一台机器时会被改写为该机的工作区路径。会话事件本身保持原样。

---

## 安装

在 DSH 中通过 Plugin Manager 安装（推荐）：

```text
plugin_manager install_bundle
  target: /home/<user>/work/NodeJsProjects/dsh-workspace-session
```

或 CLI（如可用）：

```bash
pnpm dsh plugin --profile web add /home/<user>/work/NodeJsProjects/dsh-workspace-session
```

安装后重启 DSH 或等待 profile 热加载，然后到 **设置 → 工作区会话** 查看状态。

---

## 配置

配置文件：`$DSH_HOME/dsh-workspace-session/config.json`（也可在设置页修改）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoExport` | `true` | 每轮结束（`session/flush`）防抖导出 |
| `exportDebounceMs` | `2000` | 防抖窗口 |
| `exportMinIntervalMs` | `5000` | 同一会话最小导出间隔（保留字段） |
| `exportOnDispose` | `true` | 会话关闭时最终导出 |
| `exportExistingOnWorkspaceAdd` | `true` | 添加工作区时把已有原生会话导出 |
| `autoImportOnStart` | `true` | 启动时扫描导入 |
| `autoImportOnWorkspaceAdd` | `true` | 添加工作区时导入 |
| `importPollMs` | `60000` | 定时轮询间隔；`0` 关闭 |
| `conflictPolicy` | `keep-both` | `keep-both` / `local-wins` / `remote-wins` |
| `snapshotMaxBytes` | `67108864` | 单快照最大字节数 |

---

## 同步触发

### 导出（原生 → 工作区）

| 时机 | 说明 |
|---|---|
| 每轮对话结束（`session/flush`） | 防抖 2 秒后写快照 |
| 会话关闭（`session/disposed`） | 立即写 |
| 插件启动 / 添加工作区 | 补齐导出该工作区已有的原生会话 |
| 定时扫描 | 补导出 |
| 设置页“导出到工作区” | 手动 |

### 导入（工作区 → 原生）

| 时机 | 说明 |
|---|---|
| 插件启动 | 扫描所有已注册工作区 |
| 添加工作区（`domain/changed`） | 立即扫描 |
| 定时轮询（默认 60 秒） | 发现快照 mtime 变化 |
| 设置页“从工作区导入” | 手动 |

导入后调用 `workspace.attachSession()`，会话出现在对应工作区下。

---

## 冲突策略

导入时比较本机原生会话与工作区快照的事件序列：

- **一边是另一边的前缀** → fast-forward，采用更长的一份（原生更短时通过写句柄追加缺失事件）；
- **完全一致** → 跳过；
- **分叉（两边都有对方没有的事件）** → 备份两份到 `.dsh/sessions/.backup/<时间>-<机器>/`，然后：
  - `keep-both`（默认）：把远端分支重建为**新会话 id**，原会话保留，两边都能打开；
  - `local-wins`：只备份，不导入；
  - `remote-wins`：v1 与 `keep-both` 行为一致（DSH 没有删除/替换会话的 API，不做破坏性覆盖）。

**不会自动合并两份分叉日志**：事件 `seq` 连续性、turn/step 结构和工具调用副作用都无法安全合并。

---

## 跨机器流程

```text
机器 A：聊完 → .dsh/sessions 自动更新 → git commit/push
机器 B：git pull → 打开 DSH（或添加工作区）→ 自动导入 → 会话出现 → 点开继续
```

建议：同一会话同一时间只在一台机器继续。跨机器切换前先同步。

---

## 资源边界

| 资源 | v1 行为 |
|---|---|
| 代码/文件产物 | 本来就在项目目录（会话工作目录），随 git；本插件不改变 |
| 会话日志 | 本插件负责：镜像/导入 |
| 技能 | 原生 `<workspace>/.dsh/skills`，本插件不碰 |
| 指令 | 原生项目根 `AGENTS.md` / `CLAUDE.md`，本插件不碰 |
| 记忆 | 不随项目（仍在 `$DSH_HOME/dsh-memory`） |
| 附件 | 不镜像（跨机器可能缺图） |
| 投影缓存 / 搜索索引 | 不提交，按需重建 |
| `session.lock` | 不导出；请把 `.dsh/sessions/**/session.lock` 加入 `.gitignore` |

建议 `.gitignore`：

```gitignore
.dsh/sessions/**/session.lock
.dsh/sessions/.backup/
```

---

## 安全提示

会话快照包含完整对话（工具调用参数/结果、终端输出、文件内容），可能含密钥或隐私。提交前请确认仓库可见性，并避免把敏感会话推送出去。

---

## 测试

```bash
node --test test/*.test.js
node --check index.js client.js lib/*.js
```

---

## 卸载

通过 Plugin Manager 移除 bundle 即可。工作区 `.dsh/sessions` 数据保留，可手动删除。
