# 安全审计报告 — dsh-auth-cookie-guard

- 审计日期：2026-11-09
- 版本：0.1.0（未安装、未发布）
- 审计对象：`dsh-auth-cookie-guard/` 全部 20 个受版本控制的文件
- 扫描工具：`plugin-builder/scripts/audit-scan.mjs`、`plugin-builder/scripts/check-project.mjs`、`node --check`

## 1. 结论

**可以安全交付。** 未发现凭据、隐私数据外发、命令注入或越权文件访问。自动扫描的高危项为 0；两处中危（测试里的 Windows 绝对路径示例）已改为占位式构造并复扫通过。

需要明确的是：**本报告只覆盖代码与仓库层面，不构成"插件在真机运行正常"的证明**。真机验证项见第 6 节。

## 1.1 0.1.1 修复记录（真机反馈）

真机安装 0.1.0 后，设置页停在「正在读取状态…」「刷新中…」，`GET /api/dsh-auth-cookie-guard/status` 永不返回。

- **根因**：路由以 `handler` 形态注册（`{ kind, path, handler }`）。web 服务对 handler 路由按 Node 约定调用 `handler(req, res)`，响应必须由 handler 自己写完；而实现返回的是 `Response` 对象。返回值被丢弃、没有人调用 `res.end()`，连接就一直挂着。返回值不是异常，服务的 `catch` 也不会触发，所以表现为"无错误、无响应"。
- **修复**：改为 `resource` 形态注册（`{ kind, path, resource }`），由 web 服务把 `Response` 写回并按行转发 `set-cookie`；同时给资源函数加顶层 `try/catch`，意外异常返回 500，避免再次出现悬空连接。
- **为什么之前没测出来**：旧测试直接调用资源函数并断言返回的 `Response`，没有覆盖"注册形态"这一契约；真机才暴露。现已补两项回归：注册对象必须含 `resource` 且不含 `handler`；用真实 `node:http` 服务端到端验证 200 + 两条 `Set-Cookie`。

## 1.2 0.2.0 变更（配置可编辑）

设置页的 `enabled` / `dryRun` / `warnAt` 从只读改成可切换、可保存。

- **写入路径**：新增精确 handler 路由 `POST /api/dsh-auth-cookie-guard/settings`（resource 路由只接受 GET/HEAD，读不到请求体），服务端用 DSH 的 `configEditor` 把配置写进当前 profile 的 `cordis.patch.yml` 并让 Loader 立即生效；插件本身不直接写文件。
- **输入边界**：只接受三个白名单键，布尔必须是布尔、`warnAt` 必须是 1–500 的整数，未知键、空 body、非法 JSON、超长 body 一律 400；没有 `configEditor` 的组合返回 501 且不改动任何状态。
- **失败语义**：`configEditor` 抛错时返回 500，内存配置保持原值，不产生半保存状态。
- **权限面**：写路由与其它路由同样受 loopback `Host` + 同源标记头两道栅栏约束；跨站请求无法触发配置写入。
- **回归**：新增 15 项测试（纯函数 4、设置保存 11），总数 38 → 53。

## 2. 自动扫描

执行：

```powershell
node <plugin-builder>/scripts/audit-scan.mjs <项目目录>
```

结果（修复后）：

```text
扫描文件：17
高危：0    中危：0    提示：0
```

修复前的两条中危：

| 位置 | 规则 | 处理 |
|---|---|---|
| `test/sqlite.test.mjs` | `absolute-win-user-path` | 原为一条带用户名段的 Windows 绝对路径示例，改为 `path.join('C:\\', 'AppData', 'Roaming')` 构造，不再包含用户名 |

0.1.1 复扫另有一条提示：`test/route.test.mjs` 里的 `http://127.0.0.1:<port>` 属测试专用回环地址（起一个本地 `node:http` 服务，端到端验证 `set-cookie` 能被转发），不是生产出口、不对外通信，已人工确认接受。

## 3. 人工审计清单

| 检查项 | 结果 |
|---|---|
| 硬编码凭据 / Token / 私钥 / Cookie 值 | 无。代码里没有任何密钥；Cookie **值**从不解析、不记录、不回传 |
| 隐私数据（会话内容、文件内容、账号） | 不读取。Host 半边只读三个请求头；Client 半边只渲染自身状态 |
| 网络出口 | 无外部请求。唯一请求是同源 `GET /api/dsh-auth-cookie-guard/*` |
| 明文 HTTP | 只访问本机回环 `http://127.0.0.1:<port>`，与 DSH 自身传输一致；不做跨机通信 |
| 文件读写 | 运行期零文件写入。救援脚本只读/删/备份用户指定的一个 SQLite 文件，且只操作 `cookies` 表中 `host_key ∈ {127.0.0.1, localhost}` 且 `name LIKE 'dsh-auth-%'` 的行 |
| 路径穿越 | 不存在。不拼接用户输入到路径；`--db` 显式路径，`path.resolve` 后使用 |
| 注入 | 无 `eval` / `new Function` / `innerHTML` / 动态 HTML 拼接；SQL 使用参数绑定（`?`），无字符串拼接 |
| 命令执行 | 无 `child_process`、无 shell 调用 |
| 权限面 | 只使用 `webServer.register` / `getOrigin` 与 Client 的 `slots`、`locale`；未申请凭据、审批、沙箱绕过或文件服务 |
| 路由暴露面 | 带 loopback `Host` 栅栏 + 同源自定义头栅栏（防 DNS rebinding / 跨站触发）；GET/HEAD 走 resource，`POST /settings` 走 handler |
| 配置写入 | 只接受 `enabled`/`dryRun`/`warnAt` 三个白名单键并做类型校验；通过 `configEditor` 写入 profile 的 patch 层，插件不自行写文件；无 `configEditor` 时 501 且不落盘 |
| 依赖 | 运行期零第三方依赖；救援脚本仅用 `node:sqlite` 内置模块。无 postinstall、无安装脚本 |
| 发布面 | `.gitignore` 覆盖 `node_modules`、`.env`、日志、测试临时目录；无构建产物、无本地绝对路径、无截图中的敏感信息 |
| 卸载残留 | 无自有数据；仅可能留下救援脚本生成的 `Cookies.dsh-cookie-guard-*.bak`，已在 README 写明 |

## 4. 隐私处理结果

- 不采集、不上报、不持久化任何用户数据。
- 日志只在真正删除过 Cookie 时记一条：删除数量、携带数量、估算字节数；不记 Cookie 名与值（Cookie 名本身是 `host:port` 的 SHA-256，不可逆，也不含凭据）。
- 未发现真实凭据，因此没有需要提醒轮换的项。

## 5. 设计层面的风险与缓解

| 风险 | 缓解 |
|---|---|
| 误删当前会话的 Cookie，导致页面 401 | 只保留 `getOrigin()` 对应 authority 的那一枚；该枚不在请求里时整批放弃删除，并在设置页提示 |
| 误删其他 Cookie | 名字必须严格匹配 `dsh-auth-<43 位 base64url>`；其他前缀、其他域名一律不碰 |
| 恶意本地页面触发删除 | `Host` 必须 loopback、必须带同源自定义头；跨站请求既发不出 Cookie 也带不上该头 |
| 一次响应删除过多 | 上限 180 枚/次（Chromium 每主机上限），其余下一轮继续 |
| 清理逻辑本身出错导致启动更糟 | 路由始终返回 200 JSON；Client 端 `catch(() => {})` 静默失败，绝不阻塞页面 |
| 救援脚本损坏 Cookie 库 | 运行前强制要求应用已退出（独占打开失败即拒绝）；删除前自动备份；只删目标行 |

## 6. 验证状态（必须如实说明）

**已实际运行并通过**

- `node test/run-all.mjs` → 53 项全部通过（纯函数 18、Host 路由 11、设置保存 11、SQLite 救援 9、Client 注册 4）
- `node --check` 对全部 `.js` / `.mjs` 通过
- `check-project.mjs` → 通过 22、失败 0、提示 2（提示为 ESM 语法需自行校验与 README 缺失，均已补齐）
- `audit-scan.mjs` → 高危 0、中危 0、提示 0

**仅完成静态检查**

- 结构与显示元数据（locale 标题/描述、图标格式与大小）由 `check-project.mjs` 校验通过，未在插件管理器中实际渲染。

**尚未验证（需真机）**

1. Electron 的 `net.fetch` / 页面请求是否接受本插件返回的 `Set-Cookie: …; Max-Age=0`，从而真正删除 Chromium 罐里的旧 Cookie。
2. 设置页在明暗主题下的实际观感与交互。
3. 安装到 `desktop` profile 后，`/api/dsh-auth-cookie-guard/*` 是否与 connection 的 `/api` RPC 守卫共存（已按 `dsh-session-export` 的成熟前缀路由模式实现，但未在本机安装验证）。
4. 卸载后是否无残留。

真机验证建议：

```text
1. 安装并重启 DSH 桌面版，打开 设置 → 认证 Cookie 守卫
2. 确认「上次请求携带」为 1～2 枚；点「立即清理」应显示「没有需要清理的过期 Cookie」
3. 完全退出并重启 3 次，观察该数字是否始终为 1～2（而不是逐次 +1）
4. 若想让旧 Cookie 出现：把另一台机器/旧版本的 Cookies 库复制过来，或用 dryRun 观察解析
```

## 7. 是否可安全交付

是。未发现真实凭据、未发现隐私外发、无危险写法；两处路径示例已脱敏。唯一的保留项是第 6 节列出的真机行为尚未验证，已在 README「已知限制」中同步说明。
