# dsh-auth-cookie-guard

DSH（DeepSeek Harness）桌面版插件。它解决的是这个具体故障：

```text
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (.../lib/main.js:...)
```

不是登录失效，也不是插件损坏，而是**认证 Cookie 在 Chromium 的 Cookie 库里越积越多，最终把请求头撑破**。

---

## 问题背景

1. 桌面版每次启动，宿主进程都会绑定一个新的随机回环端口（本机实测落在 `1024–15000` 的系统动态端口段，例如 `127.0.0.1:13708`）。
2. 宿主签发的浏览器会话 Cookie 名字是 `dsh-auth-<base64url(sha256("host:port"))>`，**名字里带端口**。
3. Chromium 的 Cookie 只按**主机**隔离，不区分端口；`127.0.0.1` 上所有 `dsh-auth-*` 在每次请求里都会被一起发出去。
4. 每启动一次就多一枚，且 30 天后才过期。按每枚约 175 字节估算，**70～90 次启动**后 `Cookie` 请求头接近 Node 默认的 16 KiB 上限，HTTP 解析器直接回 431，任何应用代码都来不及执行；壳层把非 2xx 一律报成 "Web authentication failed"。

所以「删掉 Cookies 文件」只是止血：机制还在，几十次启动后必然复发，而且删整份数据库会连其他站点/状态一起清掉。

## 这个插件做了什么

它把「清理」变成每次启动自动发生、且只动 DSH 自己签发的那几枚 Cookie：

| 能力 | 说明 |
|---|---|
| 启动自动清理 | 页面每次加载后向插件路由发一次同源请求；Host 从该请求的 `Cookie` 头里读出所有 `dsh-auth-*`，**只保留当前端口那一枚**，其余用 `Set-Cookie: <name>=; Max-Age=0; Path=/` 让 Chromium 自己删除 |
| 设置页状态 | 设置 →「认证 Cookie 守卫」：当前宿主地址、当前 Cookie 短名、上次请求携带数量与估算字节、风险分级、上次清理结果 |
| 一键清理 | 页面上「立即清理」，立即执行一次并回显删除数量 |
| 页面内配置 | 自动清理、试运行、告警阈值可直接切换并保存（写入 profile 的 `cordis.patch.yml`） |
| 救援脚本 | 已经 431 打不开桌面版时，退出应用后运行 `scripts/purge-auth-cookies.mjs`，备份后只删 `dsh-auth-*` 行 |

**它不做什么**：不读会话内容、不写用户目录、不联网、不碰 `$DSH_HOME` 下的凭据与会话；不删除任何非 `dsh-auth-*` 的 Cookie；当前端口的 Cookie 永远保留。

---

## 使用方式

安装并重启 DSH 桌面版后：

1. **自动**：每次启动自动清理旧的认证 Cookie，通常你什么都不用做。
2. **手动**：设置 →「认证 Cookie 守卫」→「立即清理」。
3. **看状态**：「上次请求携带 N 枚认证 Cookie（其中过期 M 枚）」——这个 N 就是决定会不会出事的指标，健康值应当长期是 1～2。

> 安装（二选一，本仓库不代你执行）：
> - GitHub：`dsh plugin --profile desktop add github:vi0let-dev/dsh-auth-cookie-guard`
> - 本地目录：`dsh plugin --profile desktop add <本目录绝对路径>`
>
> 也可以在插件管理页添加。安装后需重启 DSH 才会加载新的 JS 模块。

### 已经打不开桌面版了

页面加载是清理的前提，所以「请求头已经超限、启动直接失败」这种情况插件帮不上忙，需要手动跑一次救援：

```powershell
# 1. 完全退出桌面版（托盘退出，并确认任务管理器里没有残留进程）
# 2. 在插件目录下运行：
node scripts/purge-auth-cookies.mjs
# 只想先看看有多少枚、不改数据：
node scripts/purge-auth-cookies.mjs --dry-run
```

脚本会先备份 `Cookies` 数据库（同目录 `Cookies.dsh-cookie-guard-<时间戳>.bak`），再只删除 `127.0.0.1` / `localhost` 上名为 `dsh-auth-*` 的行。其余 Cookie、其余表、其余文件都不动。

数据库路径：`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`（macOS/Linux 由脚本按平台推导）。

---

## 配置

三个开关都可以直接在「设置 → 认证 Cookie 守卫」里改，点「保存」即生效；保存走 DSH 的 `configEditor`，写进当前 profile 的 `cordis.patch.yml`（**不是**插件包内那份），因此重启后仍然保留，也不会因为升级插件被覆盖。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启动时自动清理；关掉后只保留手动「立即清理」 |
| `dryRun` | boolean | `false` | 只报告不删除，用于观察将要清掉哪些 Cookie |
| `warnAt` | integer 1–500 | `40` | 设置页开始变黄告警的 Cookie 条数 |

页面内控件的边界：

- `warnAt` 必须是 1–500 的整数，非法值会被服务端拒绝并提示，不会静默写入；
- 保存只接受这三个键，其它字段一律 400（页面拿不到写任意配置的能力）；
- 保存会触发该插件行重新加载，路由随之重新注册，页面随后会自动刷新状态；
- 若某个 profile 没有提供 `configEditor`（非 Web/精简组合），页面显示"无法保存"的提示，此时仍可手改 profile 的 `cordis.patch.yml`。

`cordis.patch.yml` 里的 `config` 依然有效，作为**默认值**；一旦在页面保存过，profile 层会覆盖它。页面上的「立即清理」不受 `enabled` / `dryRun` 限制（这是显式操作）。

---

## 项目结构

```text
dsh-auth-cookie-guard/
├── package.json                    # 包名 = patch 行 name = ModuleLoader id
├── cordis.patch.yml                # 插入一行，带默认 config
├── index.js                        # Host 半边：/api/dsh-auth-cookie-guard 路由
├── core.mjs                        # 纯函数：Cookie 名、解析、清理计划、风险分级
├── client.js                       # Web 半边：启动清理 + 设置页
├── locale/{zh,en}.json             # 插件管理器显示名与描述
├── icon.svg                        # 原创图标
├── scripts/purge-auth-cookies.mjs  # 打不开时的一次性救援
├── test/                           # 5 组测试，共 53 项
├── README.md / AUDIT.md / LICENSE
```

## 依赖

- **运行时：零第三方依赖。** 只用 `node:crypto`、Web 标准 `Request`/`Response`/`Headers`，以及 DSH 提供的 `webServer` 服务。
- **救援脚本：`node:sqlite`（Node 内置）。** Node ≥ 22.5 提供；本插件 `engines.node` 要求 `^22.19.0 || >=24.0.0`。
- 没有安装脚本、没有 postinstall、没有构建步骤。

## 隐私

- Host 路由只读三个请求头：`Host`、`Cookie`、`x-dsh-auth-cookie-guard`，不做任何持久化、日志里只有数量与状态码。
- Cookie **值**不解析、不记录、不回传；页面上只显示 Cookie 名的短哈希。
- 不发起任何外部网络请求；不读会话日志、不读凭据文件。
- 响应里的 `Set-Cookie` 只针对本机 `127.0.0.1` 上、名字严格匹配 `dsh-auth-<43 位 base64url>` 的条目。

## 安全注意事项

- 路由带两道栅栏：`Host` 必须是 loopback 字面量（防 DNS rebinding），且必须带同源自定义头 `x-dsh-auth-cookie-guard`（跨站表单无法设置）。
- 配置写入只接受 `enabled` / `dryRun` / `warnAt` 三个键并做类型校验，通过 DSH 的 `configEditor` 落到 profile 配置层，插件不直接写文件；没有 `configEditor` 的组合会拒绝保存且不改动任何状态。
- 当前端口的 Cookie 缺失时**整批放弃删除**，避免把正在使用的会话踢下线；设置页会显示「已跳过」提示。
- 单次响应最多删除 180 枚（Chromium 每主机上限），剩余的在下一轮继续。
- `dryRun` 可在不删任何东西的前提下确认解析结果。

## 开发说明

```powershell
# 全部测试（53 项：纯函数 / 路由 / 设置保存 / SQLite 救援 / Client 注册）
node test/run-all.mjs

# 语法检查
node --check index.js; node --check client.js; node --check core.mjs

# 结构自检与安全扫描（plugin-builder 自带脚本）
node %USERPROFILE%\.dsh\skills\plugin-builder\scripts\check-project.mjs .
node %USERPROFILE%\.dsh\skills\plugin-builder\scripts\audit-scan.mjs .
```

关键 API（本机 DSH 0.2.2-rc.1 已核实）：

- `ctx.inject(['webServer'], scoped => scoped.effect(() => server.register({ kind: 'prefix', path, handler })))` —— 最长前缀匹配，`/api` 归 connection 的 RPC 守卫。
- `server.getOrigin()` → `http://127.0.0.1:<port>`；Cookie 的 authority 就是 `new URL(origin).host`。
- 路由 handler 返回标准 `Response`；`set-cookie` 会被 web 服务按**多行**原样写出（`headers.getSetCookie()`），这是删除 HttpOnly Cookie 的唯一可行通道。
- Client 半边：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, locale }, Component))`。

## 已知限制

1. **清理只对「下一次启动」生效**。页面必须先加载成功；已经 431 的状态要用救援脚本。
2. 插件**读不到也改不了** Chromium 的 `Cookies` 数据库（运行中被独占），所以一切修复都走浏览器应答，不做磁盘操作。
3. 若宿主改用 `https`（`Secure` Cookie）或换用非 `127.0.0.1` 的主机名，名称规则不变，但设置页显示与删除都以 `getOrigin()` 为准；跨主机名的情况未覆盖。
4. **真机未验证**（本仓库只做代码与本地测试交付）：Electron 会话是否接受这些 `Set-Cookie` 删除、设置页在明暗主题下的观感、安装后启动行为。验证方法见 `AUDIT.md`。

## 卸载

在插件管理页停用并移除 `dsh-auth-cookie-guard`，重启 DSH。插件不写任何自有数据；唯一可能的残留是救援脚本生成的 `Cookies.dsh-cookie-guard-*.bak` 备份，可自行删除。

## 许可

MIT，见 [LICENSE](./LICENSE)。
