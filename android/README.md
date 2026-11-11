# Agent Bot 安卓客户端

控制云端 agent-bot 的原生安卓应用。界面以近黑暗色为主，聊天采用居中窄栏、左右分侧气泡与底部整合输入区；抽屉按「对话 / 自动化 / 智能体与工具 / 服务器」分组，顶部显示连接状态与默认引擎。
Telegram 与飞书控制方式不受影响——App 通过 bot 进程内置的 HTTP API(`/api/v1`)工作，
三种控制端可以同时使用，共享提醒、定时任务、用量统计与运维能力。

## 功能

> 附件容量：App、Telegram、飞书与 API 默认都不设项目级单文件/总量字节上限（`MAX_INPUT_MB=0`），单条消息最多 4 个附件。实际仍受平台与部署环境影响：Telegram Bot API 的 `getFile` 约 20MB；OpenCode 单个直连附件约 20MB（更大的文件仍完整落盘并以绝对路径交给模型）；飞书出站单文件约 30MB；反向代理、手机缓存空间、服务器磁盘和内存也可能限制超大文件。


- **聊天**：发送提示词，实时显示排队/思考状态与回复；长任务一键停止；只有贴着底部时新消息才自动跟随，向上翻阅历史不会被拉回，滚动后右下角出现「回到最新」；回复支持 Markdown（代码块、列表、引用、链接），代码块与整条回复都可一键复制；收到的图片点开即全屏查看，支持双指缩放与拖动；语音与视频在 App 内直接播放，不再依赖手机是否装有外部播放器；图片加载失败会显示具体原因并可重试
- **发送保护**：发送失败（断网、服务重启）时提示词自动回到输入框，已选附件保留，可直接重发，不会丢内容
- **会话内搜索**：顶栏放大镜按关键词（不区分大小写）过滤当前聊天记录，命中结果按时间列出并显示上下文摘录；点任意结果回到对话并滚动到对应消息，返回键或「取消」退出搜索
- **快捷命令**：命令面板与 Telegram 同源——`GET /help` 除文案外还下发 `commands`（Bot 回答的全部命令词与说明）与 `aliases`（`tz`/`reset`/`svc`/`maintenance` 等等价写法），App 打开 `/` 面板时静默取回，Bot 侧新增命令无需发版即出现在列表里（App 只能跳页的命令会跳到对应页面并提示参数在页内操作，绝不会被当成提示词发给 Agent）。带参数的命令也直接执行：`/agent claude`、`/model sonnet`、`/model default`、`/dir ~/code`、`/dir reset`、`/timezone Europe/Berlin`、`/queue clear`、`/remind 30m 喝水`、`/cancel 12`、`/schedule add 每天 09:00 检查服务器`、`/history 50`（服务器的历史窗口最多 50 条，写 `/history 120` 会被压到 50 并当场提示）、`/env set KEY 值`、`/env unset KEY`、`/access add 123`、`/alias add code 审查当前代码`、`/export json`、`/logs opencode 200`、`/proxy add http://127.0.0.1:7890 本地代理`、`/proxy use 2`、`/proxy test 2`、`/proxy del 2`、`/proxy off`、`/service opencode status|start`、`/cc provider current`、`/cc auth list`、`/cc sessions show <会话 ID>`、`/cc prompts use review`、`/cc skills repo add owner/name`、`/cc failover move p1 up`、`/cc proxy config port 8787`——与 Telegram 用同一套参数写法；`/cc` 的词组与英文别名（`provider rm`、`skills del` 等）来自服务器 `GET /cc/views`、`GET /cc/exec` 下发的 `tokens`，App 不硬编码任何 cc-switch 命令词，表内解析不了的词组改走 Telegram 的 `/cc run` 同一条通道（`POST /cc/run`，逐段发给 cc-switch；需要不需要确认由服务器判定，需要时弹出与 Telegram 同样的确认框，确认后原样重发）。破坏性操作绝不被一条文字命令执行：`/restart`、`/update`、`/service opencode stop|restart` 会跳到运维中心、`/cc provider rm <ID>`、`/cc sessions del <ID>` 会跳到 cc-switch 控制台，各自弹出与 Telegram 相同的确认框，必须再点一次确认；需要目标 ID 却没写的（如 `/cc provider rm`）会先弹输入框。App 另有两个只影响**下一条消息**的写法：`/engine <id>` 临时换引擎、`/model! <id>` 为下一条消息选模型（不带参数即打开选择面板）。只有非命令的 `/开头` 文本（如 `/usr/bin/node 是什么`）与服务器上的 `/名称` 快捷指令才会作为提示词发出。
- **实时进度**：任务执行中显示服务端进度与已运行时长（每秒刷新），失败或已停止的气泡可直接重试/重新执行，不会重复插入提问；`/retry` 与 Telegram 一样重发**上一条任务**，不分成败（回答满意想再要一版也能重跑），仍在排队/执行时提示先停止；重试走 `POST /task/:id/retry`，由服务器用它自己保存的原始文本、引擎、临时模型和附件重放（与 Telegram `/retry` 同一份记录），只有任务已被服务器清理时才退回按本地文本补发；短暂断网（切换 Wi-Fi、服务重启）不会把仍在运行的任务误判为失败，恢复后自动继续同步并补发完成通知；经反向代理/隧道连接时，Bot 重启期间代理回的 502/503/504 与网关超时同样按「服务暂不可用，正在重试…」处理；服务器令牌失效（重装 Bot 或清掉 `data/` 会重新生成令牌）时也不再把还在跑的任务一刀判失败，而是提示去「设置」重新配对，配对成功后这条任务会自动续上并补回结果；令牌被拒的文案在构造异常处一次性改写，发送、队列、Agent/cc-switch、运维等几十个界面的报错都统一显示「访问令牌已失效，请在「设置」重新填写或扫码配对」，不会再刷出服务端那句「请在请求头携带 Authorization」；中途退出 App 也不会把当时还在跑的任务写成失败并存进本地记录，重开后自动续上同一条任务并补回结果；「重试」连点两下也只会起一条云端任务（一次性的 `retrying` 集合挡掉并发），顶部错误横幅上的重试只对失败/已停止的那条气泡生效，不会把早就回答好的任务重放一遍；发送途中挑好的附件不会被上一条发送抹掉；`/stop` 在没有可停任务时如实回「当前没有正在执行或排队中的任务可停止」；所有跨端时长（已运行、最近活动、排队）都用服务器时钟算：App 从每个 JSON 响应的 `Date` 头学一个偏差，手机自己的钟慢一小时不会再让刚起跑的任务永远显示「已运行 0 秒」，偏差超过一天则当作代理时钟故障忽略
- **后台通知**：App 在后台时，任务完成、失败或停止会发系统通知（含回复摘要，点击直接回到聊天页并滚动定位到该任务、短暂高亮；多条通知各自对应自己的任务）；Android 13+ 在任务开始后首次请求通知权限。若 App 进程已被系统回收，则仍由 Telegram 推送兜底
- **任务队列**：查看排队/执行中的任务，显示已排队/已运行时长（每秒刷新），停留期间每 5 秒自动同步状态（静默失败，不会弹错误），逐条停止，长任务运行期间仍可继续发送——排队上限与 Telegram 相同（4 条待处理），第 5 条会被服务器退回 409 并把文本还给输入框；同样地，任务进行中改引擎可以立刻生效，但新建会话、改模型、切/恢复工作目录、跟随对端会话都要先停止任务（与 Telegram 按钮的「任务执行中，请先停止」同一句话）。实时列表下面是「最近任务」：已结束的任务（完成/失败/已取消）按提交时间倒序列出，带耗时、完成时刻、引擎、模型、附件数与失败原因，每条一个「重试」——走的还是服务器保存的原始提示与附件，等价于 Telegram 的 `/retry`，历史页那些清洗过的记录做不到这件事
- **会话设置**：查看/切换 CLI 工作目录、在线切换时区、清除本会话的模型选择、新建会话，与 Telegram 的 `/dir`、`/timezone`、`/model default` 对应；清除后由对应引擎自身的配置决定模型。工作目录除了手打路径还能「浏览服务器目录…」——`GET /dir/browse` 逐级列出子目录（只列目录，隐藏项与文件不列，软链接指向真实目录才算数，一次最多 200 条），对话框里有「默认 / 主目录 / 运行目录 / 上一级」快捷跳转，「选择此目录」走的仍是 `POST /dir`，浏览本身不改会话；OpenCode 会话的模型行连同 `provider/modelID` 一起显示（与 Telegram `/model` 面板标注当前模型的写法一致）；还能看到另一端会话（Telegram 聊天）的引擎/模型/目录与最近活动、今日/累计任务数，并一键跟随到 App 这边（`GET /peers`、`POST /peers/follow`，单向对齐、需确认）
- **附件**：点「📎」可拍照、从相册选图、选择视频或任意文件（最多 4 个，默认不限制单文件字节数）；视频、图片、音频、PDF 与普通文件走同一套选择与落盘逻辑，不再按 10MB/15MB 预算拒绝。选择后先流式复制到应用缓存，发送时由 OkHttp multipart 直接读文件上传，不会把整段视频读入内存或转 Base64。部分文件提供方把 MIME 报成空或 `application/octet-stream`，App 会按扩展名纠正为 `video/*`、`audio/*` 或 `image/*`。待发送附件按图片/视频/音频/PDF/文件显示对应图标，发送后气泡内显示附件名与大小；不写文字只发附件也可以（服务端会补上对应图片/视频/音频/文件的默认指令）；选择阶段只检查能否打开和是否为空，不设按类型的字节上限；0 字节空文件会被拒绝；「拍照」会先申请相机权限。
- **流式进度**：优先走 `GET /task/:id/events` 的 SSE 事件流，实时显示 agent 的思考/工具活动，断流自动回退轮询；顶栏状态点实时反映连接健康，点按直达设置页
- **语音消息**：输入框为空时右侧按钮变为麦克风，点一下开始录音（最长 2 分钟，界面显示计时），点「■」或到时后立即发送，行为与 Telegram 语音一致；录好后的读取与编码放在后台线程（在界面线程上编码会冻住录制）；录音需要麦克风权限（首次点击时申请），离开聊天页会自动停止录音并释放麦克风
- **系统分享**：从任意 App 的分享菜单选择 AgentBot，文本会填入输入框（可继续编辑），图片/文件自动加入待发送附件——只准备草稿，不会自动发送
- **回复媒体**：Agent 通过 `[[image|voice|video|file:...]]` 产出的图片在气泡内直接显示（点击全屏打开），语音/视频点击后在 App 内播放（也可用其他应用打开），其他文件显示为可点击卡片；本地文件与远程链接走服务端同一套 SSRF/代理防护，媒体会缓存到本机，重开 App 不再重复下载；下载与图片解码都直接读写磁盘、不整份进内存，服务端把 `MAX_MEDIA_MB` 调到 100MB 也能打开
- **Markdown 渲染**：回复中的代码块（等宽、横向滚动、语言标签）、行内代码、加粗、斜体、删除线与链接（自动识别裸链接，点击用系统浏览器打开）正常排版，无序/有序列表与 `>` 引用块按块级排版（嵌套缩进、引用左侧竖线）；消息文本可长按选择复制，与 Telegram 的复制体验一致
- **本地持久化**：聊天记录与未发送的输入草稿保存在本机——切页、进程被杀后自动恢复，发送成功才清空
- **返回键**：先收起侧边抽屉；在其它页面按返回会回到聊天页，不会直接退出 App
- **前台刷新**：从后台切回 App 时静默刷新当前页与会话信息——聊天以外的每个页面（队列、状态、历史、提醒、定时、会话、引擎/模型、代理、cc-switch、配置、运维、快捷指令、白名单、帮助）都会重新拉取，静默失败不弹错误；正在执行的长操作（cc-switch 切换、运维动作）不会被刷新打断。唯一例外是「Hermes 记忆」页：它是一份正在被编辑的长文本，回到前台只保留草稿，要更新请点页内「刷新」
- **抽屉总从顶部打开**：左抽屉是一张导航图而不是可续读的文档。每次重新打开都会回到起始位置，不会因为你上次滑到中段而把上方入口藏起来；抽屉保持打开时，界面重组也不会突然把列表拽回顶部
- **引擎与模型切换**：顶栏芯片点开即切 OpenCode / Claude Code / Codex / Gemini 等引擎与模型；模型列表与 Telegram 同源，模型没有中文说明时副行直接显示可输入的值（OpenCode 的 `provider/modelID`、CLI 的别名），引擎只给提示不给列表时（如 `deepseek / qwen`）面板直接写明「模型由 CLI 自身配置，可用提示：…」，`/model <词>` 也认这些别名与提示里的 ID；复位词整套通用（`default`/`reset`/`clear`/`auto`/`默认`/`恢复默认`），App 把词原样交给服务器按 Telegram 的规则判定——引擎真的声明了同名模型就切模型，否则清除本会话的模型选择，由引擎自身配置决定；换模型与清除选择都会丢弃上一个模型的会话上下文，重复选中当前模型则保持不动，「清除本会话模型选择」按钮则始终清除（`POST /model {model, reset:true}`）
- **单条消息换引擎/模型**：输入框右侧的「本条指定引擎」（🎚）可把下一条消息临时交给别的已安装引擎，并可为该引擎再点选一个模型（留空＝不传模型，由该引擎自身配置决定，列表来自 `GET /models?engine=`；Claude/Qoder/Codex 等未列出模型时也按此规则执行）；发送后两项指定自动恢复，会话设置与 Telegram 端都不受影响，输入框上方显示「引擎 / 模型」并可一键取消；发送失败时指定会保留，重试仍发同一条请求
- **引擎管理**：与 Telegram 的 `/agents` 一致——查看安装状态、按内置 npm/pip 命令安装、更新或卸载 Bot 托管 CLI，破坏性操作会先展示完整命令并要求确认；页面顶部标出当前引擎，每个引擎卡片都有「使用此引擎」，一处即可完成 Telegram 里 `/agent <id>` 的切换（未安装的引擎标为 ⚠️，切过去后任务会失败，切换成功的轻提示直接复用服务器 `POST /agent` 的 `message`——`已切换至 X`／`当前已经是 X，无需切换`／`但未检测到命令 <bin>`，与 Telegram 按钮的回答一字不差），列表第一项始终是内置的 OpenCode，切到别的 CLI 后也能一键切回来；每张卡片还写明该引擎是否保留上下文（无状态引擎标「每次全新会话」）、模型能否由 Bot 切换，以及可输入别名（`/engine q`、`/engine claude-code` 与 Telegram 一样命中同一个引擎，别名与 `bin` 来自服务器 `GET /agents`）
- **模型管理**：与 `/cc model` 一致——查看/添加/删除自定义 OpenCode 模型（`简称 provider/modelID [显示名]`，还能接 Telegram 的同一串参数 `--attachment`（含 `--vision`/`-a`）、`--context 200000`、`--output 64000`，写没写进 `opencode.json` 由服务器的回执说明），删除被引用模型时提示并可强制删除；Agent 绑定列表支持直接「设为模型」（同 `/cc model assign`，绑定 self 会切换当前会话）。格式错误时添加框保持打开、原输入不丢，并在框内直接说明原因；服务器拒绝添加、绑定或删除时，错误条留在模型页，不再写进只有聊天页可见的横幅。
- **cc-switch 控制台**：与 Telegram 的 `/cc` 一致——查看安装状态/版本/当前 Provider，每个 Provider 可切换（需确认）、测速、📡 流检、🧾 拉取模型、📊 配额，列表头部「＋ 新建」按 `/cc provider add` 创建 Provider（模板与 API 格式取自服务器，密钥只上传、不回显；OpenCode 等非 Claude/Codex/Gemini 应用会自动改为只填 settings JSON），MCP 列表/同步/导入（粘贴 `mcpServers` JSON）、提示词查看/启用/停用/新建（名称 + 内容）、环境检查/工具、代理状态，「只读视图」卡片整表来自服务器 `GET /cc/views`（配置、配置路径、会话列表/详情/消息、当前 Provider、认证状态/账号列表、技能列表/详情/仓库可用/更新检查/已添加仓库、MCP 命令校验、故障转移状态/队列/可选项、提示词当前/生效/内容、守护进程与其日志、设置；需要参数的先弹输入框；`provider export` 不在表内，因为它会往工作目录写 settings 文件），会话关键词搜索与 `ccswitch://` Deep Link 导入（覆盖配置前先展示链接并二次确认），「全部命令」直接跳到帮助页的 cc-switch 指令段（与 Telegram 的「📋 全部命令」同一份文案）；「高级操作」列出服务器白名单下发的命令（删除 Provider/MCP/提示词/技能/会话、安装技能、MCP 启用/停用/设置生效应用、Provider 复制/设为默认/live 导入与移除、代理开关与监听地址/端口、配置校验、会话用量同步、技能同步与更新、故障转移入队/出队/上下移/开关与清空、ChatGPT 账号移除/登出/设为默认、提示词启用/停用/重命名、配置重置与备份、守护进程启停、cc-switch 语言切换、技能仓库添加、检查/执行 cc-switch 自更新），需要参数的先弹输入框——App 一次输入即够，`failover move p1 up`、`mcp set-apps fs open-code,codex`、`prompts rename review 新名称` 这类「ID + 第二个值」由服务器拆开并分别校验，标记 ⚠️ 的还要二次确认，等价于 Telegram 的确认按钮；未安装时可一键安装或升级二进制；白名单没覆盖到的写法（如 `/cc mcp enable fs --apps opencode`）照原样发给 cc-switch，输出进「最近结果」卡片，交互式/常驻命令由服务器与 Telegram 共用的同一套判定挡下并给出可改用的写法，`-a/--app` 的任何形式都被拒绝
- **magpie 网关**：与 Telegram 的 `/magpie` 一致——顶部显示 CLI 版本、二进制路径与本地网关健康状态；「只读视图」和「可执行命令」两张表都由服务器 `GET /magpie` 下发，不在 App 里硬编码命令名，所以服务端新增 `src/apiMagpieSpecs.ts` 条目后无需发版。只读视图（Provider、模板、Agents、模型、路由组、配额、用量、设置、守护进程、会话、账号）走 `GET /magpie/view`；可执行命令（同步模型目录、检查/升级 magpie、守护进程启停、测试/拉取 Provider 模型、删除 Provider/路由组、刷新订阅登录）走 `POST /magpie/exec`，需要目标的先弹输入、标记「需确认」的再弹确认框。右上角「▶」保留与 `/magpie run` 相同的自由参数入口，交给服务端白名单、参数校验和确认门禁；`sync`、升级、守护进程启停等成功后会静默重读概览，失败不会把已成功的命令误报为失败。需要桌面、终端或交互登录的命令（`tui`、`web`、`serve`、`plugin`、`accounts add` 等）会由服务端明确拒绝，并提示改用 `daemon`、终端或 App 内的对应入口
- **Hermes 记忆**：抽屉与 cc-switch 页的「Hermes 记忆 …」进入，对应 Telegram 的 `/cc hermes memory …`。一页管两份记忆（`MEMORY.md` 工作记忆 / `USER.md` 用户画像）：多行文本框直接编辑整份内容（不用在聊天里拼一行参数），卡片显示字数、「有未保存的改动」、启用/停用开关与「保存」「清空」，保存/清空前弹确认；顶部「预算」卡片是服务器 `hermes memory limits` 的原文，写入超过 Hermes 的加载预算时提示会被截断。停用只让 Hermes 加载时跳过该文件，不删内容。页面数据每次写操作后都取服务器回的新状态，本地草稿不会被后台刷新覆盖
- **配置项**：与 Telegram 的 `/env` 一致——查看可安全读取的 `.env` 键（密钥值不下发），修改/删除规则内的键、新增缺失键；`TELEGRAM_ALLOW_USERS` 仍引导到访问白名单，时区修改立即生效
- **访问白名单**：与 Telegram 的 `/access` 一致——查看/添加/移除授权用户，服务端阻止移除自己或清空名单，改动立即生效
- **快捷指令**：与 Telegram 的 `/alias` 一致——创建/删除 `/名称` 快捷指令，在 App 或 Telegram 发送即展开
- **网络代理**：与 Telegram 的 `/proxy` 一致——添加（自动测连通性）、启用/停用、单条测试与删除；列表地址始终脱敏
- **运维中心**：与 Telegram 的 `/ops` 一致——诊断信息（Node/平台/PID/运行时长/Git/OpenCode 可达性/cc-switch/磁盘/内存/日志大小）、Bot/OpenCode 日志尾部（80/200/400 行，可选中复制），以及运行检查、检查更新（干跑，列出落后提交不改工作区）、更新项目、重启 Bot 与 OpenCode 服务启停（破坏性操作均需确认，长任务有进度提示）；「📦 备份数据」下载服务端 `data/*.json` 的 tar.gz 归档（不含配对令牌）并弹出系统分享面板保存
- **任务历史**：按日期分组（今天 / 昨天 / 日期）查看任务记录（提示词、引擎/模型、格式化耗时、结果，定时触发会标注 🗓），可清空；顶部 20/30/50 条窗口切换与 Telegram 的 `/history <条数>` 对应，记录多于窗口时显示「已显示 N / 共 M 条」；「分享」按钮可选 Markdown（默认）或 JSON，与 Telegram 的 `/export [json]` 是同一条 `GET /export?format=`；点任一条目可查看完整提示词，并一键「填入输入框」或「复制」，方便改写后重发
- **提醒**：创建/删除提醒，时间写法与 Telegram 的 `/remind` 完全一致（`30m`、`18:30`、`每天 08:30`…）；列表显示绝对时间与倒计时（如「2 小时后」），一次性提醒带「延后」按钮（10 分钟 / 1 小时 / 明天，`POST /reminders/:id/snooze`），确认后列表时间立即同步刷新；重复提醒保持周期不提供延后，触发时通过 Telegram 或飞书推送。页面区分加载中、读取失败、暂不可用与空列表：仅安卓端部署时，服务器 `GET /info` 的 `automation.reason` 会直接说明缺少 Telegram/飞书推送目标，App 提前显示原因并隐藏创建按钮，而不是等提交后才用 409 拒绝。「重新检查」会先重新读取 `/info`，所以刚配好渠道也能立即恢复，不必重启 App
- **定时 AI 任务**：创建、暂停/恢复、删除、立即执行一次（同 `/schedule run`，不影响原定时间）；新建对话框可像 Telegram 一样指定执行目标（引擎下拉 + 模型输入框，内部按 `--engine/--model` 前缀提交，留空则沿用当前会话），列表每项显示「执行 引擎 / 模型」、下次触发的绝对时间与倒计时，到点由 bot 执行并推送到 Telegram 或飞书。页面和提醒共用同一套加载中、读取失败、暂不可用、空列表与有数据五种状态；没有推送目标时同样在页面内解释原因并隐藏创建入口，「重新检查」与提醒走同一条重新探测路径
- **任务队列**：查看排队/执行中的任务、单条停止，或一键「清空排队」（同 Telegram 队列面板，只取消排队中的任务）；「最近任务」区列出已结束的记录，逐条「重试」等价于 Telegram 的 `/retry`，成功后明确提示新任务已提交。刷新失败、停止失败、清空失败与重试失败都显示在本页可关闭的错误条中，不再依赖只有聊天页才渲染的横幅；已有列表刷新失败时保留旧记录并显示原因，而不是误装成空队列
- **运行状态**：页头以状态胶囊显示在线/离线，OpenCode 可达性、运行时长、进行中任务数（另计服务器保留的可重试条目）、当前执行/排队中的任务与其最新进展、今日任务、成功率、平均耗时、最近活动（上次执行时间/引擎/模型）、引擎分布、近 7 天趋势；末尾的「每日报告」卡片跨全部聊天聚合当日用量（含 Telegram 端）与来源分布，与 `USAGE_DAILY_REPORT` 定时推送同源（`GET /usage/report`）；附「连接信息」（服务器地址、API 监听、引擎/模型、工作目录、时区、推送聊天 ID、会话 ID），对应 Telegram 的 `/api` 与 `/id`
- **帮助**：与 Telegram 的 `/help`、`/help full`、`/help cc` 共用同一份服务端文案——三档切换、可滚动可选中复制，不再与聊天端脱节
- **设置**：页头显示连接状态，服务器地址 + 访问令牌；地址字段允许换行，Instabox 这类长主机名在 720px 宽的手机上也能完整看到。地址下方实时预览实际请求的 `/api/v1`，并对手机回环地址（`127.0.0.1` / `localhost`）与公网明文 HTTP 给出警告。保存时先做健康检查与会话探测，成功后才替换旧配置并进入聊天；失败留在设置页显示中文原因，已保存的旧连接不受影响。扫码只**导入**地址、令牌与加密密钥，需要用户核对后再点保存；在 Telegram / 飞书发 `/api` 可获取二维码（服务器开启 `API_ENCRYPTION=1` 时还含加密密钥，自动启用消息级加密——请求/响应体 AES-256-GCM，SSE 与媒体流除外；服务器随后关掉加密时，App 会自动改回明文重试一次并继续工作，无需你动「设置」；密钥也可在设置页手动填写——粘贴时夹进的换行与空格会被自动忽略，长度不对会直接告诉你重新扫码）。二维码只在服务端设置了 `API_PUBLIC_URL`（或 `API_BIND` 为具体地址）时出现；手动填写时 `http://IP:3080`、`IP:3080`、`http://IP:3080/api/v1` 都能识别；Bot 挂在反向代理子路径上时（`API_PUBLIC_URL=https://域名/agent-bot`），`/api` 打印的 `https://域名/agent-bot/api/v1` 也只摘掉结尾前缀、留下 `/agent-bot`

## 构建与安装

要求：Android Studio（Ladybug 或更新）或命令行 Gradle 8.9+、JDK 17，以及一个稳定的 release keystore。正式发布禁止使用 debug 密钥。

```bash
cd android
export ANDROID_KEYSTORE_PATH=/absolute/path/to/release.jks
export ANDROID_KEYSTORE_PASSWORD='...'
export ANDROID_KEY_ALIAS='...'
export ANDROID_KEY_PASSWORD='...'
./gradlew assembleRelease        # 产物: app/build/outputs/apk/release/app-release.apk
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

> 仓库未提交 `gradlew` 二进制包装器；用 Android Studio 打开会自动生成，或先执行
> `gradle wrapper --gradle-version 8.9` 生成后再构建。

也可以把签名信息写到 `android/keystore.properties`（不得提交）：

```properties
storeFile=/absolute/path/to/release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

`storeFile` 使用绝对路径最稳妥；相对路径以 `android/` 为基准。只有四项都配置时 Gradle 才会启用 release 签名；缺少任一项会得到未签名 APK，`npm run release:android` 仍可复制它，但 Android 不会安装。发布前必须让 `apksigner verify` 通过，并确认输出证书与团队约定的 release 证书一致。

> **debug → release 迁移**：debug 构建使用本机自动生成的 debug 密钥，与正式 release 密钥不是同一签名身份，Android 会拒绝覆盖安装。必须先在手机上卸载早期 debug APK，再安装正式签名 APK；卸载会清除 App 本地聊天记录、草稿、设置与配对信息，需要重新扫码配对。之后只要一直使用同一个 release keystore，就可以直接覆盖升级并保留本地数据。若更换 release keystore，同样必须先卸载。

> 本仓库的 CI 环境没有 Android SDK，编译不了 Kotlin。仓库根目录的 `npm run check` 因此先跑
> `npm run check:android`（`scripts/check-android-sources.mjs`：必需源文件是否缺失、是否被
> `.gitignore` 规则吞掉、每个 `.kt` 的括号与字符串/注释是否闭合），再跑
> `tests/appParity.test.ts`：校验命令表与 Bot 的命令清单一致、每个命令都有实际分支，
> 核对所有页面里 `vm.xxx` 引用的确是 `AppViewModel` 声明的成员，并比对 `ApiClient.kt`
> 请求的路径与 `src/api.ts` 路由的接口——App 调不到的端点会被拒绝，服务器有而 App 没用的
> 必须显式登记原因；`api responses fill every field the App's models decode` 会把真实响应与 `ApiModels.kt`
> 逐字段对照，并按 Kotlin 声明的字段类型自己走下去（`List<…>` 的每一行、`Map<_, …>` 的每一项都算），
> 不再靠一份手写的嵌套清单——运维面板的 `git`/`disk`/`log`/`memory`、日程的 `repeat` 就是被那份清单漏掉
> 的模型，它们要么在沙箱里根本不出现，要么只在嵌套层里出现。改不了响应的这几个改用服务器自己的声明对照
> （`src/ops.ts`、`src/reminders.ts`），因为字段改名在解码时只会安静地显示 0 或一根横线，编译器看不见。
> `Usage`/`UsageDay`/`UsageTrendDay`/`HistoryEntry`/`Task`/`TaskMedia` 仍旧与 `src/usage.ts`、
> `src/history.ts`、`src/apiTaskTypes.ts` 的接口逐个对照。
> 这些一起构成代替编译器的一层静态门。
> `scripts/check-android-sources.mjs` 还有七条运行时卫生规则：写进聊天历史的 `catch (Exception)`
> 必须先原样抛出 `CancellationException`，否则「离开页面导致的取消」会被存成任务失败；对
> `InputStream` 直接 `readBytes()`（读取长度未知的整条流）也被拒绝，附件必须先流式落盘、发送时直接读文件；
> 服务端的非 2xx 状态必须经 `serverFailure()` 转成文案，这样令牌被拒时几十个界面都说
> 「访问令牌已失效，请在「设置」重新填写或扫码配对」，而不是服务端那句关于请求头的说明；
> 配对密钥必须先去掉空白再校验 32 字节长度，否则从 Telegram 复制时夹进的换行会让每个请求
> 都死在本地，报的还是半句「Illegal base64 character」；
> 聊天记录与输入草稿各自只有一个 `Channel.CONFLATED` 消费者，且必须跑在 `Dispatchers.IO` 上：
> 界面线程只 `trySend`，写盘由那条唯一协程负责（每个入口的调用次数也被钉住）。任务每推进度都会
> 重写整份历史、每敲一个字都会保存草稿，而偏好设置一次提交会把整个文件重排一遍——在主线程做这些
> 会卡气泡，让输入变粘；`LocalStore` 还必须保留 `MAX_HISTORY_BYTES` 上限，否则攒到几 MB 的记录会让
> 冷启动先去读一整个大值。第六条盯的是任务控制：`retryTask`/`retryRecord` 必须先进 `retrying`
> 集合、并在 `finally` 里摘掉（重试会真的再起一次云端任务，连点两下就是两份开销）；横幅上的
> 「重试」只能走 `retryFromBanner()`，它只对失败/已停止的那条气泡生效，否则会把早就回答好的
> 任务重放一遍；`send()` 不许把 `pendingAttachments` 直接抹成空表（发送途中挑好的附件会凭空消失）；
> 轮询遇到读不到的回复必须按网络故障退避重试，不许把还在跑的任务判死；`/stop` 停在 0 条时要说
> 「当前没有…可停止」；`ChatScreen` 不许自己在界面线程读录音（走 `vm.stageVoiceNote`），
> 拍照前必须先申请 App 已声明的 `CAMERA` 运行时权限。第七条盯的是时钟：`ApiClient` 必须从响应的
> `Date` 头学一个偏差（`clockOffsetMs`/`serverNow()`），且偏差绝对值超过一天就当没看见（那多半是
> 代理自己的时钟坏了）；`ChatScreen` 之外显示时长的三个界面（`ListScreens`/`SessionScreen`/
> `StatusScreen`）不许出现 `System.currentTimeMillis()`——「已运行 X 秒」「最近活动 X 前」减的是
> 服务器写下的时间戳，拿手机自己的时钟去减，手机慢一小时就永远显示「已运行 0 秒」，看着像卡死。
> 它不能替代 `./gradlew assembleRelease`，改动 App 代码后仍需在本地或 CI 用真实 Android 工具链编译、签名并验证一次。

### 打标签发布（GitHub Actions）

推送匹配 `android-v*` 的标签即触发 `.github/workflows/android-release.yml`：

```bash
git tag -a android-v1.1.6 -m "Android v1.1.6"
git push origin android-v1.1.6
```

发布前先把 `android/app/build.gradle.kts` 的 `versionName` / `versionCode` 改成同一个版本；工作流会先跑完整项目检查，再按标签把 `versionName` 写成标签版本（如 `1.1.6`），并按 `major*1000000+minor*1000+patch` 计算 `versionCode`，最后执行 `gradle assembleRelease`。标签与仓库内版本不一致会直接失败，不会签出一个版本错乱的包。它要求仓库配置以下 Secrets，缺任一项都会直接失败，绝不回退到 debug 或未签名 APK：

- `ANDROID_KEYSTORE_BASE64`：release keystore 的 base64 内容
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

构建后用 `apksigner verify --print-certs` 校验签名，并把 APK 签名证书的 SHA-256 与 keystore 中指定 alias 的证书指纹逐字比对；证书有效但 alias 不对也会失败。发布资产包含 `agent-bot-vX.Y.Z.apk`、同名 `.sha256` 与 `android-release.json`（版本、versionCode、大小、SHA-256、说明）。标签名必须是三段数字（`android-vX.Y.Z`），否则该步骤会直接失败并提示。

### 直接安装现成的 APK

不想搭构建环境就从 [GitHub Releases](https://github.com/longtimex/agent-bot/releases) 选择最新的 `android-v*` 版本，下载 `agent-bot-vX.Y.Z.apk` 与同名 `.sha256`：

```bash
# 把 <tag> 换成实际版本，例如 android-v1.1.6
tag=android-v1.1.6
base="https://github.com/longtimex/agent-bot/releases/download/$tag"
curl -L -o agent-bot-v1.1.6.apk "$base/agent-bot-v1.1.6.apk"
curl -L -o agent-bot-v1.1.6.apk.sha256 "$base/agent-bot-v1.1.6.apk.sha256"
sha256sum -c agent-bot-v1.1.6.apk.sha256
```

当前 Release 由 CI 正式签名，因此需要在手机上允许「安装未知来源应用」。同一 release keystore
签名的后续版本可以直接覆盖升级，已保存的地址、令牌与配对密钥会保留；早期 debug 包切到正式包
必须先卸载，且会丢失本地 App 数据（见上文迁移说明）。minSdk 26 走 APK Signature Scheme v2。

### 服务器内在线更新

App 的「设置 → 应用更新」会请求 `GET /android/release?versionCode=<当前版本>`，显示服务器上的最新版本、大小、更新说明与 `updateAvailable`。点击「下载并安装」后：

1. 以 Bearer Token 流式下载 `GET /android/release/apk` 到 `cache/updates/*.part`；
2. 先检查 `Content-Length` 与清单大小，再对落盘文件计算 SHA-256；
3. 大小或 SHA-256 不一致时删除下载文件并拒绝安装；
4. 通过 `FileProvider` 交给 Android 系统安装器；Android 8+ 首次安装会引导开启「安装未知来源应用」，并保留已校验的 APK，授权返回 App 后自动继续唤起安装器。

APK 是原始二进制，`API_ENCRYPTION=1` 时也不会套消息级加密头；其余 JSON 清单仍走统一加密与安全响应头。更新清单缺失时只显示「服务器尚未配置更新」，不影响聊天。

在服务器发布已签名 APK：

```bash
npm run release:android -- --apk /path/to/agent-bot-v1.1.0.apk \
  --version 1.1.0 --notes "修复若干问题"
```

脚本复制 APK 到 `data/android/releases/`，对**实际发布副本**计算 SHA-256 与大小，并原子写 `data/android-release.json`；运行中的 Bot 下一次读取即可看到，无需重启。也可以把 GitHub Release 中的 `android-release.json` 下载到 `data/android-release.json`，并按其中 `apk` 相对路径放置 APK。清单拒绝绝对路径、`..` 与越界符号链接；大小或哈希与文件不一致时服务端返回错误而不是发一个损坏包。

## 连接服务器

1. 在服务器安装目录运行 `npm run setup`（或稍后运行 `npm run clients`），选择「安卓 App」。向导会填写 `API_ENABLED` / `API_BIND` / `API_PORT` / `API_PUBLIC_URL`，生成或沿用 `API_TOKEN`，并打印配对地址与令牌。也可手动确保 `.env` 中 `API_ENABLED=1`，并设置手机可达的 `API_PUBLIC_URL`；默认的 `127.0.0.1` 回环监听不能单独作为安卓控制端。
2. 若已配置 Telegram 或飞书，也可在对应聊天里向 Bot 发送 `/api` 获取 API 地址、令牌与可扫码二维码。
3. 手机能访问到服务器后（公网地址、反向代理、SSH 隧道或 VPN 均可），在 App「设置」页扫码或填入地址与令牌。

> 仅安卓 App 也能使用聊天、附件、引擎/模型、目录、历史与运维功能；但提醒、定时任务和每日用量报告需要向 Telegram 或飞书 owner 聊天推送，此类接口会返回 `409`。

### 暴露方式建议

| 方式 | 说明 |
| --- | --- |
| 反向代理（推荐） | Nginx/Caddy 反代 `127.0.0.1:3080`，配置 HTTPS 与域名 |
| SSH 隧道 | `adb reverse tcp:3080 tcp:3080`（USB 调试场景）或 `ssh -L 3080:127.0.0.1:3080 host`，App 地址填 `http://127.0.0.1:3080` |
| VPN | Tailscale/WireGuard 组网后直接访问内网地址 |
| Instabox 端口发布 | `instabox-port publish 3080 --name agent-bot`，把输出的 HTTPS 地址写入 `API_PUBLIC_URL`；公开端口需保留 Token 并建议开启 `API_ENCRYPTION=1` |

> Instabox 云电脑的完整步骤如下：安装依赖并构建 → `instabox-port publish 3080 --name agent-bot` → 把输出的 HTTPS 地址写入 `API_PUBLIC_URL`（`API_BIND=127.0.0.1` 即可）→ 启动 Bot → 在云电脑上运行 `npm run smoke:app` → 手机 App 扫码或填写地址、令牌与 `enc` → 核对 `/api/v1` 预览后保存。机器停止会同时结束 Bot 与端口发布，重启后若地址变化需更新 `.env`、重启 Bot 并重新配对。详见仓库根 [`README.md`](../README.md#instabox-云电脑部署安卓连接示例)。

令牌鉴权始终开启；请勿在没有 TLS 的公网上明文传输（令牌与对话内容均为明文 HTTP）。

## 使用说明

1. **配对连接**：运行 `npm run setup` 选择安卓 App，按终端输出的地址与令牌连接；或在 Telegram / 飞书里向 Bot 发 `/api` 获取（设置了 `API_PUBLIC_URL` 时，回复里的二维码可直接扫码导入）。首次打开进入「设置」页，扫码或填入服务器地址与访问令牌；扫码只导入表单，点「保存并连接」后先测连、成功才保存。探测失败会留在设置页、在表单内显示真实原因，并明确旧配置是否保留；新地址不可用不会把仍在工作的旧连接标成离线。成功会显示「连接成功，即将返回聊天」，停留约 1.5 秒后自动回聊天。顶栏状态点只依据真实健康状态，点按直达设置页。
2. **发消息**：底部输入框直接输入提示词发送；点「📎」拍照、选相册图片、选视频或选任意文件（最多 4 个，默认不限制单文件字节数）；输入框为空时右侧按钮变为麦克风，点击录音（最长 2 分钟）后自动发送。发送失败时内容自动回到输入框、附件保留，可直接重发。待发送与已发送的同一个附件使用同一套大小格式，小文件显示精确字节数（例如 `34B`），不会未发送时显示 `1KB`、发送后才变回 `34B`。
3. **用命令**：输入 `/` 弹出与 Telegram 一致的命令和服务器上的快捷指令，点选即执行或跳转对应页面。
4. **切引擎 / 模型**：顶栏芯片切换本会话的引擎与模型；输入框右侧「🎚」可把**下一条**消息临时交给其他引擎并为其选模型，发送后自动恢复。
5. **看进度**：任务执行中实时显示思考 / 工具活动与已运行时长，可随时停止；App 在后台时任务完成 / 失败会发系统通知，点击直达该消息并高亮。
6. **更多页面**：左侧抽屉进入任务队列、状态统计、历史、提醒、定时任务、引擎管理、模型管理、cc-switch、Hermes 记忆、代理、白名单、快捷指令、配置、运维中心与帮助，功能与 Telegram 同名命令一一对应。每次重新打开抽屉都会从顶部开始，已滑动的旧位置不会把上方入口藏起来。
7. **会话维护**：会话设置页可切换工作目录、时区，清除模型选择或新建会话；有任务在排队/执行时卡片里会写明这几项（含「跟随该会话」）需先停止任务、切换引擎不受影响，并附一个「停止」按钮——服务器对这些操作回 409，句子与 Telegram 按钮的拒绝一致；页内还会列出 Bot 的另一端会话（通常是 Telegram 聊天）当前用的引擎/模型/目录与排队情况，「跟随该会话」可把 App 一次性对齐过去（只改本机 App，不动 Telegram，需确认）；顶栏放大镜可在当前聊天内按关键词搜索。
8. **本地体验**：聊天记录与未发送草稿保存在本机，进程被杀也能恢复；回复图片点开全屏（双指缩放），代码块与整条回复均可一键复制，消息文本可长按选择复制。尚未配对或连接字段被清空时，首屏只说明「先在设置填写地址与令牌」并提供「打开设置」，不再展示一组点了也发不出去的示例提示。

## 项目结构

```
android/
├── app/src/main/java/com/agentbot/app/
│   ├── MainActivity.kt            # 单 Activity + 抽屉导航
│   ├── ui/
│   │   ├── AppViewModel.kt        # 全部状态与 API 编排（轮询任务进度、附件、持久化）
│   │   ├── Markdown.kt            # 轻量 Markdown 渲染（代码块/行内代码/加粗/列表/引用块）
│   │   ├── ChatScreen.kt          # 聊天主界面
│   │   ├── ImageViewer.kt         # 全屏看图（双指缩放/拖动）
│   │   ├── SessionScreen.kt       # 会话设置（工作目录/时区/模型选择/对端会话）与任务队列
│   │   ├── AgentsScreen.kt        # 引擎安装/更新/卸载
│   │   ├── OpsScreen.kt           # 运维诊断与日志
│   │   ├── ProxyScreen.kt         # 网络代理管理
│   │   ├── AliasesScreen.kt       # 快捷指令
│   │   ├── AccessScreen.kt        # 访问白名单
│   │   ├── ModelsScreen.kt        # 自定义模型管理
│   │   ├── CcScreen.kt            # cc-switch 控制台（Provider/MCP/提示词/环境/代理/高级操作）
│   │   ├── HermesScreen.kt        # Hermes 记忆（MEMORY.md / USER.md 编辑、启停、预算）
│   │   ├── ConfigScreen.kt        # .env 配置项查看与编辑
│   │   ├── PickerDialog.kt        # 引擎/模型切换、新建对话框
│   │   ├── ListScreens.kt         # 历史 / 提醒 / 定时任务
│   │   ├── StatusScreen.kt        # 状态与统计
│   │   ├── HelpScreen.kt          # 帮助（与 Telegram /help 共用文案）
│   │   ├── AppVisibility.kt       # 前后台标记（后台才发任务通知）
│   │   ├── SettingsScreen.kt      # 服务器连接设置
│   │   ├── AppDrawer.kt           # 分组侧边抽屉（连接状态/新对话/队列角标）
│   │   ├── UiComponents.kt        # 共享标题、卡片、状态胶囊与空状态
│   │   └── theme/Theme.kt         # 暗色主题、字体层级与圆角 token
│   └── data/
│       ├── ApiClient.kt           # /api/v1 客户端（OkHttp + kotlinx.serialization）
│       ├── LocalStore.kt          # 附件读取（ContentResolver）与聊天记录持久化
│       ├── MediaFiles.kt          # 回复媒体磁盘缓存、图片降采样与 MIME 推断
│       ├── TaskNotifier.kt        # 后台任务完成通知（Android 13+ 权限检查）
│       ├── ApiModels.kt           # 接口模型
│       └── SettingsRepository.kt  # 连接信息持久化
```
