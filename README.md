# 多邮箱验证码中心

这是一个可直接部署到 Linux 服务器的私人邮件与验证码查询系统。公开前台允许多人访问，但每个人必须使用管理员分配的独立查询密钥。单个查询可读取该密钥绑定子邮箱最近 7 天内的邮件，也可以筛选仍在有效期内的验证码邮件。管理后台、邮箱凭据、子邮箱配置、未匹配邮件和审计记录仅管理员可访问。

本项目仅用于你本人拥有或已得到明确授权的邮箱，不用于公共接码、账号交易或绕过第三方平台风控。它读取发送到邮箱的普通验证邮件，不能读取 Apple 受信任设备或手机号收到的 Apple ID 登录验证码。

## 已包含功能

- 公网多人查询页面：`/`
- 独立管理员入口：`/admin/login`
- 管理端服务端会话校验、CSRF、登录限流和可选 IP 白名单
- 管理员 TOTP 双重认证
- 独立的第三方平台 TOTP 密钥库，不与母邮箱、子邮箱或查询密钥绑定
- 前台可直接转换并保存多个 2FA 密钥，同时显示各自的 6 位动态码和刷新倒计时
- iCloud、Gmail、Outlook 标准 IMAP 凭据连接测试与加密保存
- 管理员重新验证登录密码后，可按需查看和复制邮箱授权密码
- 多母邮箱、多子邮箱管理
- 母邮箱、子邮箱地址与备注、查询密钥有效期、2FA 平台与账号备注均可编辑
- 子邮箱搜索、批量导入、`邮箱--密钥` 格式导出和最多 50 个邮箱的批量验证码查询
- 单个查询可查看最近 7 天文本邮件或筛选有效验证码；批量验证码查询返回每个邮箱的最新有效验证码
- 每个子邮箱独立高强度查询密钥，数据库保存用于验证的 HMAC 摘要和管理员查看所需的 AES-256-GCM 加密副本
- 管理员重新输入当前登录密码后，可按需查看查询密钥、2FA 手动密钥和当前动态码
- 管理端运行指标、Worker 心跳、登录会话查看与其他设备退出
- 常驻 IMAP Worker、断线恢复、按邮件夹独立 UID 游标与 Message-ID 去重
- 自动读取每个母邮箱下所有可选择的 IMAP 邮件夹，跳过仅用于组织层级的不可选择容器；同一封邮件出现在多个邮件夹时合并显示并列出全部来源
- 按原始邮件头识别 `To`、`Delivered-To`、`X-Original-To` 等位置中的子邮箱
- 子邮箱邮件信息加密保存 7 天，并显示完整邮箱地址、发件人、主题、接收时间和邮件信息
- 中文和英文验证码提取、短期有效及自动清理
- 查询 IP 限流、管理员审计、未匹配邮件检查
- PostgreSQL 持久化、自动备份与保留策略、Caddy 自动 HTTPS、Docker Compose 一键运行
- Docker 日志轮转、更新前备份、健康检查和失败回滚

## 服务器要求

- Ubuntu 22.04/24.04 或其他支持 Docker 的 Linux
- 推荐至少 1 核 CPU、2 GB 内存、20 GB 磁盘
- 一个解析到服务器公网 IP 的域名
- 防火墙开放 TCP `80`、TCP/UDP `443`
- 服务器可连接 `imap.mail.me.com:993`、`imap.gmail.com:993`、`outlook.office365.com:993`

数据库和 Web 容器没有发布到公网，公网只经过 Caddy 的 `80/443` 端口。

## 部署

先在域名服务商处添加 A 记录，将例如 `code.example.com` 指向服务器公网 IP。然后使用 root 用户或具有 `sudo` 权限的用户登录服务器，运行：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/youxiang-GL/main/deploy.sh \
  -o /tmp/icloud-hq-deploy.sh &&
sudo sh /tmp/icloud-hq-deploy.sh
```

脚本会自动安装 Docker、下载生产配置并拉取 GitHub Container Registry 中的最新镜像。首次运行时会询问域名、证书邮箱、管理员邮箱和初始管理员密码，并自动生成数据库密码、主加密密钥和查询密钥 Pepper。为避免 `.env` 解析歧义，初始密码只允许字母、数字、点、下划线、波浪号和连字符；部署后可在管理后台修改。配置保存在 `/opt/icloud-hq/.env`，权限为 `600`。

以后再次运行同一条命令即可更新到最新 `latest` 镜像。脚本会保留 `.env`、PostgreSQL 数据和 Caddy 证书，不会重新初始化管理员。升级前会创建数据库备份；新版本健康检查失败时，会尝试恢复更新前的应用镜像。旧 `.env` 不需要手工补齐新增变量，Compose 和应用会使用文档中的默认值。

首次启动时，Web 容器会自动建立数据库表并创建一个管理员。然后访问：

```text
公开查询：https://code.example.com/
管理登录：https://code.example.com/admin/login
```

管理员创建后，修改 `.env` 中的 `ADMIN_PASSWORD` 不会更改数据库密码。请在管理后台的“安全设置”里修改管理员密码，并启用 TOTP。

## 接入邮箱

登录管理后台，进入“母邮箱”并点击“接入母邮箱”，选择 iCloud、Gmail 或 Outlook。IMAP 服务器、端口和 TLS 参数由后端固定配置，不能从浏览器自定义；系统会先实际测试登录，成功后才使用 AES-256-GCM 加密保存授权密码。

### iCloud

1. 确认 Apple 账户已经开启双重认证。
2. 在 Apple 账户页面创建一个 App 专用密码。
3. 选择 iCloud，填写完整邮箱和 App 专用密码。

不要填写 Apple ID 日常登录密码，也不要填写 Apple 设备收到的六位登录验证码。服务地址固定为 `imap.mail.me.com:993`。

### Gmail

1. 为 Google 账户开启两步验证。
2. 在 Google 账户安全设置中创建一个应用专用密码。
3. 确保该账户允许使用 IMAP，然后选择 Gmail，填写完整邮箱和应用专用密码。

普通 Google 账户密码通常不能用于这里。服务地址固定为 `imap.gmail.com:993`。

### Outlook

选择 Outlook，填写完整 Microsoft 邮箱和该账户允许用于 IMAP 的密码或应用专用密码。服务地址固定为 `outlook.office365.com:993`。

本版本只支持标准 IMAP 凭据登录，不包含 Microsoft OAuth。强制现代认证、禁用基础身份验证或受企业租户策略限制的账户可能无法连接；这类账户需要后续接入 Microsoft OAuth 后才能使用。

邮箱列表默认不返回明文授权密码。管理员可以点击“查看凭据”，重新输入当前后台登录密码后临时查看和复制；该操作受频率限制、写入审计日志，并使用禁止缓存的响应。

## 添加子邮箱与分发权限

1. 进入“子邮箱”，选择所属母邮箱。
2. 填写完整子邮箱地址和备注。
3. 系统生成一个 `cv_` 开头的查询密钥，只显示一次。
4. 将该密钥单独交给对应查询者。
5. 查询者访问公开首页，只输入密钥即可查看对应子邮箱最近 7 天内的全部已归属邮件，也可以切换到验证码筛选；批量验证码查询用于查看每个子邮箱的最新有效验证码。

管理员后台之后只能看到密钥末六位。密钥丢失时应点击“重置密钥”，旧密钥会立即失效。

子邮箱列表支持搜索、批量导入和查询密钥导出。批量导入格式为每行 `子邮箱,备注`，新生成的查询密钥会在导入结果中显示并可下载；导入结果和列表导出均为纯文本 `.txt` 文件，每行格式固定为 `邮箱--密钥`。无法恢复明文密钥的旧记录会被跳过，重置一次查询密钥后即可导出。编辑子邮箱时可以修改所属母邮箱、地址、备注和密钥有效期，现有查询密钥不会被重置。

## 独立第三方平台 2FA

这里的 2FA 是第三方平台在注册或开启双重认证时提供的 TOTP 配置，不是 Apple 受信任设备或手机号收到的验证码，也不是管理员登录后台使用的 TOTP。它与 iCloud、Gmail、Outlook 母邮箱、子邮箱和 `cv_` 查询密钥完全独立。

1. 在第三方平台开启身份验证器 2FA，找到 Base32“手动设置密钥”，或复制完整的 `otpauth://totp/...` 地址。
2. 打开公开首页的“2FA 验证码”页签，直接粘贴手动密钥或 `otpauth://` 地址；平台名称和账号备注可以选填。支持的浏览器也可以选择二维码图片在本机识别，图片不会上传服务器。
3. 点击“转换并保存 2FA”后，当前 6 位动态码会立即显示，并同步保存到后台独立的“2FA 管理”列表。
4. 可以继续输入其他密钥。每个不同密钥都是独立记录，可在同一浏览器页面同时查看，互不覆盖。
5. 再次输入同一个密钥会复用原记录并更新平台或账号信息，不会创建重复项。动态码每 30 秒自动更新。

邮件验证码查询接口不会返回 2FA，2FA 转换接口也不会查询邮件或子邮箱。管理后台可以查看、删除以及修改独立 2FA 的平台名称和账号备注，但不会通过编辑功能修改原始密钥，也不能通过子邮箱配置 2FA。升级前已经绑定在子邮箱上的旧 2FA 会在服务启动时自动迁移到独立列表，并标记原子邮箱地址作为迁移来源。

首版只支持最常见的标准 TOTP：`SHA1`、`6` 位、`30` 秒周期，不支持 HOTP。二维码图片识别依赖浏览器的 `BarcodeDetector`，不支持时请在平台界面中寻找“无法扫描”“手动输入”或“设置密钥”；本系统不会从邮件中自动提取 2FA 二维码。

TOTP 原始密钥和查询密钥的可恢复副本使用 `MASTER_KEY_HEX` 进行 AES-256-GCM 加密。敏感信息不会进入后台常规状态接口；管理员必须重新输入当前登录密码，才能按需查看查询密钥、TOTP 手动密钥和当前动态码。公开页不会把 2FA 原始密钥写入 `localStorage` 或 `sessionStorage`，关闭或刷新页面后需要重新输入；后台保存的记录仍会保留，直到管理员删除。

升级前已经创建的查询密钥只有不可逆 HMAC 摘要，无法恢复明文。后台会将其标记为“旧密钥不可恢复”，重置一次查询密钥后即可使用管理员查看功能。

## 管理后台仅限指定 IP

公开查询需要多人访问时，可以保持 `/` 公网开放，同时限制管理后台来源。在 `.env` 中填写管理员公网 IP，多个地址用英文逗号分隔：

```dotenv
ADMIN_ALLOWED_IPS=203.0.113.10,198.51.100.24
```

修改后运行：

```bash
cd /opt/icloud-hq
docker compose -f compose.production.yaml up -d --force-recreate web
```

该配置会同时限制 `/admin`、`/admin/login` 和 `/api/admin/*`。如果管理员网络 IP 经常变化，请留空并依靠强密码和 TOTP，或者在服务器前增加 Tailscale/WireGuard。

## 邮件匹配验证

不同邮箱服务商和转发方式可能保留不同邮件头。添加子邮箱后，先向该地址发送一封测试验证码邮件：

- 成功归类时，“收信记录”会出现对应子邮箱。
- 无法归类时，邮件会出现在“未匹配子邮箱”中。
- 未匹配区只保存发件人、主题和原始邮件头，不保存正文。

匹配成功的邮件会保存发件人、主题、接收时间、来源邮件夹和邮件信息，正文使用 `MASTER_KEY_HEX` 进行 AES-256-GCM 加密并在 7 天后自动删除。系统会读取每个母邮箱下所有可选择的 IMAP 邮件夹，不只读取 `INBOX`；系统不保存附件，不向浏览器返回邮件 HTML，也不会加载邮件中的远程图片。每个邮件夹独立维护 UID 游标，首次同步会按 `MAIL_RETENTION_DAYS` 回补该邮件夹内的近期邮件。同一封邮件如果同时出现在多个 Gmail 标签或 IMAP 文件夹中，会合并为一封邮件并显示多个来源。已经从服务器删除的历史邮件无法恢复。

如果原始邮件头完全不保留子邮箱地址，系统无法可靠区分该转发来源，需要调整转发规则或为该来源增加专用邮件头规则。

## 日常运维

查看状态和日志：

```bash
cd /opt/icloud-hq
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=100 web
docker compose -f compose.production.yaml logs --tail=100 worker
docker compose -f compose.production.yaml logs --tail=100 caddy
```

后台“运行概览”会显示邮件 Worker 心跳和当日查询指标；“安全设置”可以管理管理员登录 TOTP、查看当前管理端登录会话，并退出其他浏览器或设备。

更新应用可重新运行一键部署命令，或在安装目录中手动执行：

```bash
cd /opt/icloud-hq
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml up -d --remove-orphans
```

停止服务但保留数据：

```bash
cd /opt/icloud-hq
docker compose -f compose.production.yaml down
```

生产配置默认每 24 小时自动备份 PostgreSQL 到 `/opt/icloud-hq/backups`，并保留 14 天。立即创建一次备份：

```bash
cd /opt/icloud-hq
docker compose -f compose.production.yaml run --rm backup sh /usr/local/bin/backup.sh once
```

不要删除 Docker 的 `postgres_data` 卷，除非确定要永久删除所有配置和记录。

## 安全说明

- 邮箱授权密码、邮件正文、邮件验证码和独立 TOTP 密钥使用 AES-256-GCM 加密。
- 管理员密码使用参数化 scrypt 哈希。
- 查询密钥验证使用带服务器 Pepper 的 HMAC-SHA-256 摘要；管理员查看使用单独的 AES-256-GCM 加密副本，不在列表和常规状态接口中返回。
- 邮件默认保存 7 天；验证码默认有效 10 分钟，到期后只清除验证码，不提前删除邮件。
- 单个查询可读取 7 天文本邮件，并可筛选仍在有效期内的验证码邮件；批量验证码查询返回最新有效验证码。
- 查询响应使用 `Cache-Control: no-store`，密钥通过 POST 请求传输，不进入 URL。
- 邮件只保存邮件信息，不保存附件，不加载远程图片。
- PostgreSQL 不开放公网端口。
- `.env`、数据库备份和 Docker 数据卷都应视为敏感数据。

主加密密钥 `MASTER_KEY_HEX` 丢失后，已保存的邮箱授权密码、验证码和 TOTP 密钥无法解密。`TOKEN_PEPPER_HEX` 改变后，所有现有查询密钥都会失效。请加密备份 `.env`，不要提交到 Git。

## 配置项

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `CODE_TTL_MINUTES` | `10` | 验证码有效分钟数；到期后邮件仍保留到 7 天期限 |
| `MAIL_RETENTION_DAYS` | `7` | 已归属子邮箱邮件和加密正文保留天数 |
| `MAIL_PAGE_SIZE` | `20` | 单个密钥查询每页返回的邮件数量，最大 50 |
| `IMAP_POLL_SECONDS` | `15` | Worker 收信轮询间隔 |
| `PUBLIC_MAIL_REFRESH_SECONDS` | `60` | 查询页面检查新邮件和邮箱状态的间隔秒数，范围 30-300 |
| `MAX_MESSAGE_BYTES` | `1048576` | 单封邮件最多读取字节数，防止大附件占用内存 |
| `MAX_BODY_CHARS` | `200000` | 单封邮件最多保存的邮件信息字符数 |
| `SESSION_HOURS` | `12` | 管理员登录会话时长 |
| `QUERY_LIMIT_PER_10_MINUTES` | `30` | 单 IP 每十分钟查询上限 |
| `BATCH_QUERY_LIMIT_PER_10_MINUTES` | `50` | 单 IP 每十分钟批量查询请求上限 |
| `LOGIN_LIMIT_PER_15_MINUTES` | `10` | 单 IP 每十五分钟登录尝试上限 |
| `QUERY_FAILURE_LIMIT_PER_15_MINUTES` | `8` | 单 IP 连续错误查询的持久限制 |
| `LOGIN_FAILURE_LIMIT_PER_15_MINUTES` | `5` | 单 IP 连续密码错误的持久限制 |
| `UNMATCHED_RETENTION_DAYS` | `14` | 未匹配邮件元数据保留天数 |
| `AUDIT_RETENTION_DAYS` | `90` | 审计日志保留天数 |
| `BACKUP_INTERVAL_HOURS` | `24` | 自动数据库备份间隔小时数 |
| `BACKUP_RETENTION_DAYS` | `14` | 自动数据库备份保留天数 |
| `ADMIN_ALLOWED_IPS` | 空 | 可访问管理端的精确 IP 列表 |

## 自动构建与镜像

GitHub Actions 工作流位于 `.github/workflows/container.yml`。推送到 `main` 后会自动执行语法检查和测试，并构建 `linux/amd64`、`linux/arm64` 两种架构的镜像：

```text
ghcr.io/wstimin/youxiang-gl:latest
```

推送 `v*` 格式的 Git 标签时还会生成对应版本标签；每次构建也会生成 `sha-*` 标签。Pull Request 只测试和构建，不发布镜像。

## 本地工程验证

项目不要求在本地运行，但修改代码后可执行：

```bash
npm install
npm run check
npm test
docker compose config
docker compose build
```
