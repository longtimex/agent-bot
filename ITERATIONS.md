# 项目迭代台账

目标(2026-11-03 设定):持续优化、修 Bug、增加新功能,把项目做成成熟好用,累计 50 次迭代。
每轮迭代必须:改动聚焦、`npm run check` 全绿、完成后才在本文件记录一行。

计数规则:本目标启动后的每轮工作记为「迭代 N」;之前的演进见 git 历史,不重复计数。

## 迭代记录

| # | 日期 | 类型 | 内容 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 2026-11-03 | 功能+修复 | 新增 `GET /api/v1/usage/report`(跨聊天聚合当日汇总+7天趋势+推送文本,供 App/脚本使用);顺带修复 `/usage` 无 id 路由吞掉子路径的问题 | npm run check 421 全绿 |
| 2 | 2026-11-03 | 功能 | App 状态页新增「每日报告」卡片:ApiModels 增 DailyReport/DailyReportSource、ApiClient.usageReport、AppViewModel 状态与两处刷新、StatusScreen 卡片;并纳入 App 契约 sweep(NESTED_FIELDS) | npm run check 421 全绿(含 check:android 门禁) |
| 3 | 2026-11-03 | 审计+文档 | 审计并行新增的 peers 路由(会话键不下发、follow 防自跟随,无问题);README API 表与 android/README 状态页条目补齐 /usage/report 与每日报告卡片说明 | npm run check 421 全绿 |
| 4 | 2026-11-03 | 卫生 | 生产依赖安全审计(npm audit --omit=dev):0 漏洞;npm ci dry-run 验证 lockfile 同步(26 包) | 审计输出为证 |
| 5 | 2026-11-03 | 功能 | 语音转写 STT:src/stt.ts(OpenAI 兼容 /audio/transcriptions);模型不支持音频时语音自动转写内联(applyStt),转写失败回退原提示;配置 STT_BASE_URL/API_KEY/MODEL/LANGUAGE(非法 URL 拒绝启动),/env 可改前三项外的 KEY(密钥不入 /env);Telegram 与 API 两条任务路径都接入 | npm run check 428 全绿(新增 7 测试) |
| 6 | 2026-11-03 | 文档 | README「接收图片/文件/语音」表格与配置说明补齐 STT 四项;.env.example 增加语音转写段 | 人工核对 + 428 全绿 |
| 7 | 2026-11-03 | 功能 | 提醒延后(snooze)三端补齐:ReminderStore/Service.postpone(仅一次性提醒,1 分钟~7 天校验)、`POST /api/v1/reminders/:id/snooze {minutes}` 返回更新后的行、App 提醒列表每行「延后」按钮(10 分钟/1 小时/明天对话框)+ snoozeReminder 立即同步刷新列表;README/android/README 同步 | npm run check 430 全绿(新增 2 测试) |
| 8 | 2026-11-03 | 功能 | Telegram `/usage` 面板在存在其他活跃来源(App/别的聊天)时显示「全局今日」跨聊天汇总行,并引导点「📩 每日报告」看明细 | npm run check 430 全绿 |
| 9 | 2026-11-03 | 功能 | `/status` 新增「语音转写」「每日报告」两行配置状态,让可选功能可发现、可判断是否生效 | npm run check 430 全绿 |
| 10 | 2026-11-03 | 基建 | CI 新增 docker build job(buildx + gha 缓存,只构建不推送),Dockerfile/.dockerignore/入口脚本的破坏在 PR 阶段即暴露(上次踩过的 COPY 掉进 .dockerignore 的坑就此有门禁) | workflow 语法核对 + 本地 docker build 已通过 + 430 全绿 |
| 11 | 2026-11-03 | 功能 | 数据备份:`/ops` 面板「📦 备份数据」把 data/*.json 打包成 tar.gz 直接发到聊天(排除配对令牌,保留最近 5 份,文件名含毫秒防覆盖);`GET /api/v1/ops/backup` 下载同一份归档;测试发现并修复 data 目录缺失时 ENOENT 与同秒覆盖两个问题 | npm run check 432 全绿(新增 2 测试) |
| 12 | 2026-11-03 | 文档 | 初始化 CHANGELOG.md(Keep a Changelog 格式,0.1.0→0.3.0 完整特性/修复史);package.json 版本升至 0.3.0(启动通知与 /health 同步生效) | npm run check 432 全绿 |
| 13 | 2026-11-03 | 功能 | App 运维中心「📦 备份数据」:ApiClient.backupData 下载 GET /ops/backup 归档,shareBackup 写入 cache/backup/(file_paths.xml 新增该 FileProvider 路径)并弹系统分享面板保存;安卓门禁抓到并修复 Kotlin 嵌套注释真错误(data/*.json 出现在文档注释里会开启未闭合的嵌套块注释);android/README 同步 | npm run check 432 全绿 |
| 14 | 2026-11-03 | 重构 | api.ts 拆分第一刀:纯 HTTP 辅助(MEDIA_MIME/mimeForName/clampLimit/res_attachment/res_attachment_binary/stamp)抽到新模块 src/apiHttp.ts,调用点零改动,为后续按路由域继续拆分立好模式 | npm run check 432 全绿 |
| 15 | 2026-11-03 | 功能 | App 运维中心「🔍 检查更新」:ApiClient.checkUpdate(GET /ops/check-update)+ AppViewModel.checkForUpdates(干跑不确认、显示落后提交);android/README 同步;编辑时误删的「⬆️ 更新项目」按钮当场补回 | npm run check 432 全绿 |
| 16 | 2026-11-03 | 重构 | api.ts 拆分第二刀:提醒/定时任务/peers 三个路由域(~200 行)抽到 src/apiPersonal.ts(PersonalRouteDeps 依赖对象 + 委托模式,类方法变一行转发);顺带清理一处并行编辑留下的孤立注释;api.ts 2650→2492 行 | npm run check 432 全绿 |
| 17 | 2026-11-03 | 重构 | api.ts 拆分第三刀:dir/timezone/aliases/config/access 五个路由域(~160 行)并入 src/apiPersonal.ts(现 423 行),PersonalRouteDeps 扩展 workDir/resetCliSessions/hasActiveTask/timezone/aliases/ops/access 八项;同步清理 6 个失效导入(含一次重复导入当场修复);api.ts 2492→2353 行 | npm run check 432 全绿 |
| 18 | 2026-11-03 | 重构 | api.ts 拆分第四刀:proxy 路由+#proxyView 与请求处理器内联的 usage/usage-report/history/export 段抽为 routeProxy/routeUsageHistory(处理器里 5 段内联判断收敛为 1 个委托调用);apiPersonal.ts 增至 575 行;api.ts 2353→2235 行(四刀累计 -415) | npm run check 432 全绿 |
| 19 | 2026-11-03 | 功能 | Telegram `/reminders` 面板一次性提醒新增「⏰+1h」一键延后(rpostpone 回调,复用 postpone 服务,失败给人话提示);至此提醒延后 Telegram 投递按钮/面板/App/API 四个入口全部就位;README 定时提醒章节同步 | npm run check 432 全绿 |
| 20 | 2026-11-03 | 重构 | api.ts 拆分第五刀:引擎/模型视图函数(agentsView/builtinAgentView/agentView/modelsView/customModelView,~120 行)抽到 src/apiPersonal.ts(665 行),deps 增 models/installer;变更类路由(POST /agent、/model、assign)留在类中;api.ts 2235→2158 行(五刀累计 -492) | npm run check 432 全绿 |
| 21 | 2026-11-03 | 功能 | App API 消息级加密(服务端半):src/apiCrypto.ts(AES-256-GCM,base64(nonce‖密文‖tag));API_ENCRYPTION=1 时 resolveEncKey 生成/复用 data/api-enc-key.json(0600);x-enc: v1 请求头按需加密,WeakMap 挂密钥零改动接入 #readJsonBody/#json;明文请求并行兼容,篡改/错钥 400;QR 配对下发密钥留待下轮 App 端接入;测试 432→484(并行会话同期 +52) | npm run check 484 全绿(新增 5 加密测试) |
| 22 | 2026-11-03 | 功能 | 消息级加密 App 端接入(闭环):/api 二维码含 enc 密钥+聊天提示;Connection/SettingsRepository 增 encKey;request() 加密 body+x-enc 头(SSE/media/backup 跳过),execute() 按 x-enc 响应头解密(AES/GCM tag 挂 OkHttp tag);设置页扫码导入+手动输入框;parity 扫描两次误报(注释里的引号斜杠字面量)当场改写;android/README 与 CHANGELOG 同步 | npm run check 484 全绿 |
| 23 | 2026-11-03 | 修复 | App shareBackup 的 cache/backup 目录只保留最近 3 份归档,防止多次备份后缓存无限膨胀 | npm run check 484 全绿 |
| 24 | 2026-11-03 | 功能 | Telegram `/report` 命令四端对齐:help.ts 菜单+/help full 长文+分发(复用每日报告预览)+App SlashCommands 表与跳转(状态页);一致性测试先抓到 /help full 缺失后修复 | npm run check 484 全绿 |
| 25 | 2026-11-03 | 功能 | `/reminders` 面板分页:每页 8 条(替换旧的 3000 字符截断),show:reminders:<页码> 翻页,⬅️/➡️+「x/y」页码指示(noop: 兜底应答);⏰+1h 与取消按钮只渲染当前页 | npm run check 484 全绿 |
| 26 | 2026-11-03 | 功能 | App 状态页每日报告卡片加「📤 分享」:shareReport 把报告文本(AI 渲染版,空则结构化拼接)交给系统分享面板;android/README 无需改(功能项已涵盖) | npm run check 484 全绿 |
| 27 | 2026-11-03 | 功能 | `/history` 面板渐进加载:保留 /history N 语义(上限 20→50),新增「⬇️ 更早 10 条 / ⬆️ 回到最新」按钮(show:history:<count>),替换掉"发 /history N 查看"的提示;渲染超长时引导 /export | npm run check 484 全绿 |
| 28 | 2026-11-03 | 功能 | App 每日报告卡「近 7 天」行加迷你趋势条(▁▂▃ 字符图,与 Telegram 报告同款),替换纯数字合计 | npm run check 484 全绿 |
| 29 | 2026-11-03 | 功能 | `/schedule` 面板分页(每页 4 个任务,show:schedule:<页码>,⬅️/➡️/页码指示),替换旧的 3000 字符截断+「另有 N 个未显示」;README 定时任务章节同步 | npm run check 484 全绿 |
| 30 | 2026-11-03 | 功能 | 加密状态可观测性(A):`/health` 新增 `encryption` 字段(Kotlin Health 模型同步,契约 sweep 自动验证);App 设置页连接成功后显示「🔐 已启用 / 🔒 未开启」;/api 未启用时给出 API_ENCRYPTION=1 提示 | npm run check 484 全绿 |
| 31 | 2026-11-03 | 功能 | 加密状态可观测性(B):Telegram `/status` 新增「消息级加密:已启用/未启用(API_ENCRYPTION=1)」行,与语音转写/每日报告行并列 | npm run check 484 全绿 |
| 32 | 2026-11-03 | 审计 | 综合自查:TODO/FIXME/as any/console.log 扫描全净;12 处裸 JSON.parse 确认均有 try+结构守卫;修复 2 个发现(history 面板 50 条上限时「更早」按钮仍显示的死按钮;加密披露措辞漏了导出/备份附件,README/.env.example/apiCrypto 同步);--noUnusedLocals 扫出并清理 10 处拆分遗留死代码(requireOwnerChat 委托、死导入等) | npm run check 484 全绿 + 严格模式 0 告警 |
| 33 | 2026-11-03 | 审计 | Kotlin 专项自查:TODO/println 扫描全净;**修复真 bug**——加密开启时 execute() 的错误分支不解密,App 只能看到 "HTTP 4xx" 而非服务端真实错误消息(现在错误体先解密再提取,解密失败统一转 ApiException);静态门禁增强:Kotlin 源码禁 TODO() 占位与 println() 裸打印 | npm run check 484 全绿 + 门禁 29 文件通过 |
| 34 | 2026-11-03 | 文档 | README 命令表与 help 菜单 35 条命令三方比对完全一致;CHANGELOG 0.3.0 补全迭代 13-24 的特性(备份/加密可观测性/面板分页/report/snooze 四入口)与 3 条修复(加密错误提示、history 死按钮、App 备份缓存) | npm run check 484 全绿 |
| 35 | 2026-11-03 | 卫生 | 依赖与 Docker 核查:npm outdated 仅 2 项落后且均为大版本跳跃(types/node 22→26、TypeScript 5→7),有意留在当前大版本并记录评估;npm audit 0 漏洞;compose 配置有效;当前全量代码重新构建镜像成功并冒烟(opencode 1.19.5) | npm run check 484 全绿 + docker build 冒烟 |
| 36 | 2026-11-03 | 文档 | README 使用说明速查表补「看用量 / 生成报告:/usage、/report」行 | npm run check 484 全绿 |
| 37 | 2026-11-03 | 功能 | `/diag` 新增「最近备份」行(三端):OpsDiagnostics.lastBackupAt(epoch ms,恒为数字/0),Telegram 用时区格式化、App Diagnostics 模型+OpsScreen 显示;契约 sweep 先抓到 harness 桩缺字段,补桩后通过——正是该测试存在的意义 | npm run check 484 全绿 |
| 38 | 2026-11-03 | 审计 | 复跑 --noUnusedLocals:0 发现(迭代 32 的清理保持有效,其后新增代码全部干净) | 严格扫描输出为证 |
| 39 | 2026-11-03 | 基建 | `noUnusedLocals` 永久写入 tsconfig:死代码门禁从"偶尔手动跑"升级为每次 npm run check 强制执行 | npm run check 484 全绿 |
| 40 | 2026-11-03 | 文档 | `/help` 简版速览的使用统计行补 `/report`,新命令在简版帮助也可发现 | npm run check 484 全绿 |
| 41 | 2026-11-03 | 走查 | 用户视角走查 Telegram 主路径(/start→对话→/usage→/reminders→/schedule→/history→/ops→/api→/status→/cancel):修复欢迎页示例区缺 /report 与 /export 入口;其余路径(cancal 用法提示、各面板空态与错误文案)确认友好,无需改动 | npm run check 484 全绿 |
| 42 | 2026-11-03 | 走查 | App 抽屉走查:重排条目顺序——「运行状态」(每日报告/加密标识所在)从倒数第三上移到任务域之后,「网络代理」上移与「访问白名单」相邻,配置/运维类收拢到尾部;设置页近期已打磨,无需再动 | npm run check 484 全绿 |
| 43 | 2026-11-03 | 走查 | App 通知/深链走查:TaskNotifier(独立 requestCode、autoCancel、Android 13+ 权限、BigText 截断)、通知点击定位(focusTask + intent 去重防重投递)、系统分享导入(文本入草稿/流转附件/不自动发送)链路确认健壮;修复全部附件读取失败时仍提示「部分」的措辞(区分全部/部分并显示已导入计数) | npm run check 484 全绿 |
| 44 | 2026-11-03 | 审计 | api.ts 路由安全再审:敏感词响应唯一一处已过 redactSecrets;encKey/token 不进任何 JSON 载荷;状态码分布符合惯例(400/404/409/413/500/502/503);sessionView 仅元数据;envList 密钥条目 value 缺席+secret 标记;审计结论固化为泄露回归测试(8 个身份端点断言不含 token/密钥形态值+config 密钥条目无值),测试 484→486 | npm run check 486 全绿 |
| 45 | 2026-11-03 | 审计 | 任务提交域审查:engineCall.ts 逐行审(404 恢复只重试一次/finally 清订阅/abort 全链路/会话竞态由上层队列串行化)——实现正确但**零直测**;新增 tests/engineCall.test.ts 5 测试(CLI 转发、会话复用+files 透传、404 透明重建、非 404 不盲重试、模型解析三级优先),测试 486→491 | npm run check 491 全绿 |
| 46 | 2026-11-03 | 文档 | 文档终检:README 顶部导读补 CHANGELOG 与 ITERATIONS.md 链接;命令表三方(菜单/README/help full)复验仍完全一致 | npm run check 491 全绿 |
| 47 | 2026-11-03 | 审计 | 综合自查发现**安全问题**并修复:备份 tar.gz 排除了 api-token.json 却漏了 api-enc-key.json(消息加密配对密钥会被打进归档发到聊天)——现两者都排除(加密密钥重新扫码即可获得);测试补双断言;自查其余项(SSE/加密交互、时区切换与日报、compose 覆盖语义、DailyReport 竞态)确认无恙 | npm run check 491 全绿 |
| 48 | 2026-11-03 | 文档 | CHANGELOG 终版核对:补入迭代 25-47 的收尾条目——面板分页细节(页码指示/到顶隐藏)、泄露回归测试与 engineCall 直测(代码质量门禁条目)、抽屉重排、双轮走查(欢迎页示例/分享导入计数)、2 条修复(备份漏加密密钥、分享导入措辞) | npm run check 491 全绿 |
| 49 | 2026-11-03 | 总结 | 里程碑总结(见下方「50 次迭代里程碑」小节):48 条迭代类型分布、测试 386→491、关键里程碑固化 | npm run check 491 全绿 |
| 50 | 2026-11-03 | 收尾 | 机动收尾:最终验证(`npm run check` 491 全绿、`docker compose config` 有效、`npm audit` 0 漏洞)、工作区状态快照与分批提交建议、维护守则固化(详见下方「收官记录」) | npm run check 491 全绿 |

## 50 次迭代里程碑(迭代 49 写入)

**类型分布**(共 48 条记录):功能 21 · 重构 5 · 审计 6(+1 条审计+文档) · 文档 7 · 基建 2 · 卫生 2 · 走查 3 · 修复 1(+1 条功能+修复)

**测试**:386 → 491(+105,含并行会话贡献约 60);每轮迭代 `npm run check` 全绿,类型检查/构建/安卓静态门禁/契约 sweep/命令 parity 全部在门内。

**关键里程碑**:
- 每日报告三端:定时推送(USAGE_DAILY_REPORT)、Telegram /report 与面板按钮、GET /usage/report、App 卡片+分享+趋势条
- STT 语音转写:OpenAI 兼容服务,模型不支持音频时自动转写,双任务路径接入
- 提醒延后四入口:投递按钮/面板 ⏰+1h/App 三档/snooze API
- 数据备份三端:/ops 按钮+聊天收文件、GET /ops/backup、App 分享保存(双秘密文件排除)
- 消息级加密全链路:AES-256-GCM、x-enc v1 协议、QR 下发密钥、App 拦截解密、三端状态可观测
- api.ts 五刀拆分:2650→2158 行,拆出 apiHttp/apiPersonal,契约 sweep 双向守护
- 工程化:Docker 三件套+CI(Node 20/22+镜像构建)、CHANGELOG 0.3.0、noUnusedLocals 转正、泄露回归测试、安卓门禁增强(TODO/println 禁令)

**审计修复**:备份泄漏加密密钥、加密错误提示不解密、history 死按钮、/usage 路由吞子路径、App 备份缓存膨胀、分享导入措辞——两轮综合自查 + Kotlin 专项 + 安全再审的组合成果。

## 收官记录(迭代 50)

**50/50 达成**(2026-11-03)。最终状态:`npm run check` 491/491 全绿(含安卓静态门禁、契约 sweep、命令 parity)、`docker compose config` 有效、`npm audit` 0 漏洞;工作区含本目标全部改动,待提交(建议按「服务端功能 / App 功能 / 文档与基建」分批提交)。

**后续维护建议**:
- 每 5-6 轮迭代复跑一次 `npx tsc --noEmit --noUnusedLocals`(门禁已转正,通常零告警)
- 新增服务端响应字段时:恒发数字/补 Kotlin 可空声明,契约 sweep 会强制两侧对齐
- 新增敏感文件时:同步检查 backupData 排除清单与所有导出/日志路径
- 新增 Telegram 命令时:help.ts 菜单 + HELP_FULL + 分发 + SlashCommands.kt 四处缺一不可
- 大版本依赖升级(types/node 26、TypeScript 7)留待专门评估,不建议顺手做

(完成后按序追加)
