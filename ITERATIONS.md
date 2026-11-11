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

## 续目标记录(安卓控制面 parity)

**模型关键词三端统一**:Telegram 的 `/model` 复位语义原先只活在 telegram.ts 里——API 只认 `default`/`默认`,非 strict 的 CLI 引擎还会把 `reset`/`auto` 当字面模型 ID 存下来,App 的按钮和打字输入走同一条本地判定且不看「声明优先」规则。本轮:

- 服务端:复位词表迁到 `src/models.ts`(`MODEL_DEFAULT_WORDS` + `isModelResetWord`),telegram.ts 改为导入;`AgentCliRegistry.declaresModel(engine, word)` 承载「模型声明优先于复位词」的判定,telegram.ts 的内联副本删除;`#applyModel` 重写为异步,两种引擎都走完整词集 + 声明优先 + `reset:true` 强制复位,并且换模型/复位都清掉上一个模型的上下文(OpenCode 删会话、CLI 清 cliSession),重复选中当前模型则保持上下文——与 Telegram 的三种回复措辞一一对应。
- 安卓端:`POST /model` 新增 `reset` 字段,`ApiClient.setModel(..., reset =)`;「恢复默认模型」按钮强制复位,打字 `/model <词>` 经新的 `applyModelWord` 原样交给服务器判定,`/model! <词>` 的一次性指定保留本地声明优先判断。
- 契约:`tests/api.test.ts` 新增「api model switch matches Telegram's reset-word and context rules」,覆盖声明了 `auto` 模型的自定义引擎、`reset:true`、三种复位词在 CLI 上生效、OpenCode 复位清上下文、重复选择保持上下文(此前 `POST /model` 无任何测试)。
- 文档:README 的 `POST /model` 行与 android README 的「引擎与模型切换」条目同步。

**引擎切换的回执**:Telegram 点按钮会回答`已切换至 X`/`已经是当前引擎`,CLI 不在 PATH 时还会警告;`POST /agent` 此前只回 `{ok, session}`,App 自己拼一句「已切换到 X」,把未安装的引擎切过去后用户毫不知情。本轮 `POST /agent` 复用同一套判定(重复选择直接回`当前已经是 X，无需切换`,选中缺失 CLI 附`但未检测到命令 <bin>`),App 新增 `EngineSwitch {ok, session, message}` 模型并直接把这个 `message` 当轻提示;契约 sweep 也首次支持 POST 型用例(`postBody`),把 `POST /agent` 的响应纳入比对。

`npm run check` 493/493 全绿(安卓静态门禁 29 个 Kotlin 文件、契约 sweep、命令 parity)。

**cc-switch 白名单补口 + `/retry` 不分成败**:对照 Telegram 逐条排查剩余 parity 缺口,选定 cc-switch 与重试两处。用 `/data/workspace/cc-switch-cli/cc-switch <组> <子> --help` 核实了每条真实语法(`failover move <ID> <up|down>`、`mcp set-apps --apps <APP[,APP]> <ID>`、`prompts rename <ID> [--name|位置]`、`proxy config --listen-address/--listen-port`、`mcp validate <COMMAND>`、`skills repos list`),不靠 help.ts 猜。本轮:

- 视图:`CC_VIEWS` 加 `skills-repos`、`mcp-validate`。`provider export` 先加后撤——它的 `-o` 默认写 `{cwd}/.claude/settings.local.json`,是副作用不是只读视图,这条判断写进了 CC_VIEWS 的注释免得后来人再放回去。
- 命令:`CC_EXEC_COMMANDS` 加 `failover-move`、`mcp-set-apps`、`prompt-rename`、`proxy-listen-address|port`、`cc-update-check`、`cc-update`(cc-switch 自升级,和运维中心的安装脚本是两条路;`CC_UPDATE_TIMEOUT_MS` 从 ccCommands.ts 提到 ccswitch.ts 导出,两端共用 180 秒);确认门槛严格照抄 Telegram 的清单(这几条 Telegram 不确认,App 也不加)。
- 两个值走一个 `arg`:App 每个命令只弹一次输入框,所以服务器按空格拆——前段 `assertSafeId`,后段按 `extra` 类型验(`direction`/`apps`/`name`/`number`/`host`,应用列表复用 `CC_SWITCH_APPS`)。`GET /cc/exec` 的 `needsTarget` 在响应里含义是「需要 arg」(`spec.needsTarget || spec.extra !== undefined`),否则纯 extra 的代理命令在 App 里不会弹框。
- 词组:`ccPhrases` 只看 argv 前两个非 flag 词,`update` 与 `proxy config` 各自撞车(`provider export` 撤了,`proxy config` 两条撞在一起),给 `CcViewSpec`/`CcExecSpec` 加 `phrases` 覆盖;`skills-repos` 视图与 `skills-repos-add` 命令抢 `skills repos` 这一对词,被「视图不能压住写命令」的门禁逮到,视图改为只声明三词 `skills repos list`。
- 安卓端:零改动即拿到上述全部新项(清单与 `targetLabel` 都是服务器下发);唯一行为修正是 `retryLastFailed` → `retryLastTask`,按 Telegram 的 `/retry` 重发上一条任务而不筛失败/取消,上一条仍在排队/执行时提示,本地纯文本补发退化为「服务器已清理该任务」的兜底(三处调用点同步改名)。

`npm run check` 497/497 全绿。剩余已知缺口(下一轮候选):`/cc run <任意参数>` 通用透传、`config export/import <文件>`(涉及服务器路径,需单独设计)、`hermes memory`。

**cc-switch 通用透传(`/cc run` 三端同一条通道)**:白名单只能覆盖想到的写法,Telegram 用户还能 `/cc run <任意参数>`,App 遇到表外词组只会「未识别」。把这条通道搬到 API 前,先解决「判定只能写一遍」:

- 新模块 `src/ccGuards.ts`:`ccBlockedReason(args, surface)`、`ccConfirmPlan(args)`、`isLongCcCommand(args)`、`CcActionPlan` 从 `CcCommands` 的私有方法整段搬出(`PendingCcAction extends CcActionPlan`),telegram.ts 改为导入;`surface` 参数让同一份文案在 App 里说「无法在 App 中运行」。
- 搬的过程逮到两个真 bug:① `--app` 的紧凑写法 `-acodex` 通不过旧的 `^(-a|--app)(=|$)`,而 cc-switch 照样读它——等于聊天里能改写别的应用配置;新增 `ccAppFlagToken()` 统一拦 `-a`/`-a=`/`-aX`/`--app`/`--app=`,同时放过 `--apps`。② 新写的门禁「白名单每条 argv 必须活过共用的判定」一连抓到 5 条 App 标了 `confirm` 而 Telegram 不确认的命令(`provider set-default`、`provider import-live`、`provider remove-from-config`、`auth default`、`daemon stop`)——都是写全局配置的动作,选择把确认加到 Telegram 侧而不是把 App 放宽,门禁同时校验 `pty` 一致。
- `POST /cc/run {args, confirm?}`:`parseCcRunArgs` 限 16 段/单段 240 字/总长 2000 字/无控制字符;`deeplink` 明确指回 `POST /cc/deeplink`(它的 URL 会带 Provider 密钥,专用端点不回显);`provider use|switch` 走 `cc.useProvider()` 而不是裸 argv(与按钮同一条路径,带 opencode.json 优先的提示);确认后按 plan 补 `--yes`/`--confirm` 并用 `pty`/`timeoutMs`。响应 `{ok, code, command, message, text}` 的 `command` 只取前三段、逐段截 80 字、过 `redactSecrets`——用户在 argv 里打的密钥不会经响应回到 App 的历史里。
- 安卓端:`CcRunResult` 模型 + `ApiClient.ccRun`;聊天框 `/cc <表外词组>` 不再只是提示,`ccRawArgv()` 剥掉 Telegram 自己消费的 `run` 词后原样发出。是否要确认由服务器说了算:400 里带「需要确认」就弹与 Telegram 同款的确认框,确认后同一 argv 带 `confirm` 重发——App 不必复制一份判定表,以后服务器加门槛也不用发版。单词(`/cc provider`)落到 cc-switch 自己的分组帮助,是发现命令的入口而不是报错。
- 测试:新增三条(raw run 行为、`-a/--app` 写法矩阵、白名单 argv × 共用判定门禁),并把 `CcRunResult` 纳入契约 sweep(`postBody` 用例)。`CC_VIEWS`/`CC_EXEC_COMMANDS` 改为导出,门禁才能读到真实 argv。

`npm run check` 503/503 全绿。剩余已知缺口:`config export/import <文件>`(涉及服务器路径,需单独设计)、`hermes memory`(需在 cc-switch 里确认可用子命令后再决定是视图还是命令)。

**会话级改动与任务共存(409 拒绝 + 排队深度)**:审计把「HTTP 端能在任务执行时改会话状态」列为最高优先级,逐条核对后确认 Telegram 的按钮路径一律先拒绝(`telegram.ts:996/1037/1075/1113/3320` 的 `#runningSince.has(key)` → 「任务执行中，请先停止」),而 HTTP 端只有「换目录」有守卫。本轮:

- `src/api.ts` 新增 `#requireIdle(what)`(复用已有 `#hasActiveTask()`),`POST /new`、`#applyModel`(即 `POST /model` 与 `POST /models/assign` 的会话侧)都先过这道门;守卫放在函数开头而不是各个改动分支前——照抄 Telegram:执行中连「已经是当前模型」这种空操作也拒绝,免得 App 以为改了。`src/apiPersonal.ts` 的 `routeDir` 把守卫上移到读 body 之后,`{reset:true}` 分支(此前绕过守卫直接清目录并重置 CLI 会话)与换目录共用一条 409;`POST /peers/follow` 补同样一句(它一次改引擎+模型+目录)。
- 区分是必要的而不是图省事:`POST /agent` 只写 `store.setEngine`,正在跑的任务早在 `#submitTask` 里固化了 `task.engine`,切引擎不会碰到它的会话 ID——所以它**不加**守卫,保持比 Telegram 的排队更即时。这条判断写进代码注释,第一次尝试时我给它加了守卫,契约 sweep 立刻把「执行中不能切引擎」当成回归报了回来。
- 排队深度:`POST /task` 此前不限长度(Telegram 的 `#ensureCapacity` 卡 `MAX_PENDING = 4` 条待处理),新增 `#waitingCount()` + `MAX_API_QUEUE = 4`,文案照抄「待处理消息过多(最多排队 4 条)……/stop」。放在 `#submitTask` 里,`POST /task/:id/retry` 一起受约束。
- `POST /models/assign` 原来 `catch { sessionMessage = undefined }`,会话没跟上时用户完全不知道;改为把原因写进 `sessionMessage`(模型表已写成功,仍回 200)。
- 安卓端:拒绝的原因走 `guarded` 的 `connectionError` 横幅,所以旧 APK 也能看懂 409;本轮仍做了四处改动——① `ApiClient` 把 OkHttp 每主机并发从默认 5 提到 16,因为队列允许 1 跑 + 4 排队、每条任务各占一个 SSE 长连接,默认值会把普通请求挡在队列后面;② `AppViewModel.hasLiveTask`(由聊天里 queued/running 的气泡派生,重启后 init 会重新 poll 这些任务所以不会长期误报)+ 会话设置卡片的「任务执行中……切换引擎不受影响」提示与「停止」按钮,免得用户先撞一次 409 才知道规则;③ 顺着这条线逮到一个本地 bug:`newChat()` 先清空 `messages` 再发 `POST /new`,执行中点「新建会话」会把还在跑的那条气泡一起抹掉(回复再也贴不回来),现在先挡一道并给同一句话;④ `/history <N>` 的本地 clamp 从 200 改为服务器的真实窗口 50 并提示,自定义模型添加框接受 Telegram 的 `--attachment/--vision/-a`、`--context[=N]`、`--output[=N]`/`--max-output`(服务器端点本就收这些字段,`POST /models/custom` 补正整数校验并把「能力写没写进 opencode.json」照 Telegram 句式回进 `message`)。
- 测试:新增「api waits for the live task before it rewires the session」——挂起一条任务后逐条断言 `/new`、`/model`、`/dir`(reset 与 set)、`/peers/follow` 回 409 且 `cliSession`/`dir`/`engine` 一字未动,`/agent` 仍 200,第 5 条排队被拒,放行后同几条端点恢复 200;`api manages custom models` 补 `contextWindow` 的 `-5/0/1.5/"200000"/2e9` 全部 400 且注册表没被写、带能力参数的添加回显能力句。

`npm run check` 505/505 全绿。剩余已知缺口:`config export/import <文件>`(涉及服务器路径,需单独设计)、`hermes memory`(可只读目录项)、带附件的 `/retry` 会话级重放(两端都要改)。

**Hermes 记忆两端共管(共享守卫 + App 编辑器页)**:上一轮把 `hermes memory` 记为「可只读目录项」,但真实子命令决定它不该做成视图。用 `/data/workspace/cc-switch-cli/cc-switch hermes memory --help` 与逐条试跑核实:`limits`/`show [memory|user]`/`set <kind> --content <文本>`/`clear <kind>`/`enable|disable <kind>`/`open-dir`,两份记忆是 `MEMORY.md`(工作记忆)与 `USER.md`(用户画像)。本轮:

- 先否掉「塞进白名单」的方案:exec 通道的 `arg` 按 `/\s+/` 拆词,一份多行记忆会被拆成半截命令;而 `show` 的输出是整篇自由文本,放进「只读视图」面板既不可编辑也不能滚动。选择新增专用端点 `GET`/`POST /cc/hermes` + App 一整页编辑器,服务器不再制造「两种做法做同一件事」。
- 守卫仍要共享(聊天里手打 `/cc hermes memory clear user` 也得受同一套规矩):`ccBlockedReason` 补三词判定拦 `open-dir`(它在服务器上拉起文件管理器,手机与聊天都没处显示);`ccConfirmPlan` 在两位数 `key` 的 switch **之前**处理 `hermes memory`,因为「覆盖哪一份」写在第三个词上,而 `provider use` 这类两位词的形状表达不了它。
- cc-switch 的一个真坑:`hermes memory clear` 不带 `--yes` 时只打印一句拒绝却 **exit 0**——照 Telegram 的「确认后执行」原样搬过去会显示「已清空」而文件纹丝不动。方案是 `appendArgs: ["--yes"]`(与 `sessions delete`、`failover clear` 同一机制),API 侧 `clear` 也固定补 `--yes`。
- 状态一次回齐 `{limits, memory, user, memoryEnabled, userEnabled}`:`GET` 里 `show` 两份 + `limits` 一次。空记忆文件 CLI 打印的是 `Hermes user memory is empty (file not created yet)`(kind 在 "memory" **前面**,与另一份的措辞顺序不同),必须识别成空串,否则这句 CLI 提示会进编辑器再被用户「保存」成正式内容。开关状态从 `limits` 原文用宽容正则 `hermesLimit()` 解析,措辞一变就回 `null`/不警告,而不是猜。
- 写入侧的门禁都在落盘前:`kind`/`action` 白名单、`set` 与 `clear` 需 `confirm: true`、空内容(要它请走 clear)、>20000 字、除换行与制表符外的控制字符全部 400 且 cc-switch 一次都不调用(测试逐条断言 `ccCalls` 长度没变);内容按**一个 argv 词**交给 CLI,多行与空格原样保留(实测)。写完比对 `limits` 的字数预算,超了就回截断警告——预算是 Hermes 加载时的行为,不是硬门槛,超了照样写。
- 安卓端:`Screen.Hermes` + `HermesScreen.kt`(第 30 个 Kotlin 源文件),两份记忆各一张卡片(多行 `OutlinedTextField`,6–14 行),显示字数、「有未保存的改动」、启用/停用开关、「保存」「清空」,覆盖/清空前弹与 Telegram 同义的确认框;`limits` 原文单独一张可选中、等宽字体的卡片。草稿用 `remember(state?.memory)` 承接服务器值,所以切开关/刷新不会抹掉正在写的长文本。有意**不**加进 `onForeground()` 的每页刷新——它会把用户改了半截的内容刷回服务器版本;页内「刷新」按钮承担这件事。cc-switch 页底部加「Hermes 记忆 …」入口(它不是服务器下发的视图,入口写死在 App 里)。
- 测试:契约 sweep 加 `HermesMemory` 与 `HermesResult`(`postBody` 用例);`api.test.ts` 的 cc 桩改为忠实回显(`limits` 两行预算、`show user` 的空句语序、`set` 回字数);新增两条用例——一条走 GET 状态、六个必 400 的 POST(断言 CLI 一次没被调)、多行 `set` 的 argv 原文、超预算警告、`clear` 补 `--yes`、`enable` 后回新状态,一条走 `ccGuards`(三词形状的封禁/确认/`appendArgs`)。`/cc help` 补出这些形状并把 `open-dir` 列进「只能由 TUI 完成」清单。

`npm run check` 509/509 全绿。剩余已知缺口:`config export/import <文件>`(涉及服务器路径,需单独设计)、带附件的 `/retry` 会话级重放(两端都要改)、`GET /cc/views` 与 `GET /cc/exec` 在 `x-enc: v1` 下仍是明文清单(内容不含密钥,但可考虑一并加密)。

**工作目录可点选(`GET /dir/browse` + App 目录浏览器)**:App 的会话设置页此前只有一个输入框让人手打绝对路径——手机上这是最难受的一次操作,而 Telegram 用户在桌面键盘上并没有这个负担。本轮把这个「只有聊天端不难、移动端很痛」的缺口补掉:

- 先定安全边界:浏览目录**不新增权限**。`POST /dir` 本来就接受该账号能到达的任何路径(`normalizeWorkDirInput` 之后 `statSync` 验证),所以列举只是把「已经能设的东西」显示出来。据此复用同一个解析器而不是再写一套:同样的 `~`/相对路径/控制字符/512 字上限/文件系统根目录拒绝,错误文案一字不差。列出的内容刻意收窄到**只有目录名与路径**——不列文件、不给大小、不读符号链接目标的内容,隐藏项(`.cache`/`.env` 这类)整类跳过。
- 服务器:`src/apiPersonal.ts` 新增 `dirListing()` 与 `routeDir(…, sub)`;`api.ts` 把路由段 `id` 透进去。软链接只在真实指向目录时列出(悬空链接与指向文件的链接丢弃),排序用 `localeCompare(…, {sensitivity:"base"})` 让 `Alpha`/`zeta` 按名字而不是按码位排,超过 200 条截断并回 `truncated`。`POST /dir/browse` 405、其它 `/dir/<子路径>` 404——此前 `routeDir` 根本不读路由段,`POST /dir/whatever` 会照样把目录设进去(看起来像子接口在改设置),这条收紧把它关掉。
- 安卓端:`DirEntry`/`DirListing` 模型、`ApiClient.dirBrowse`、`AppViewModel.openDirBrowser/loadDir/closeDirBrowser/chooseDir` 与会话设置页的「浏览服务器目录…」。对话框里「默认 / 主目录 / 运行目录 / 上一级」四个快捷跳转 + 可滚动的子目录列表,「选择此目录」调的还是 `setWorkDir`,所以两条路径永远不会分叉。列表为空/被截断各有明确一句话,截断时提示改用「修改目录」手打。
- 门禁逮到自己写的 bug:`appParity` 的「ViewModel 成员必须真实存在」扫描发现 SessionScreen 引用了 `vm.loadDir`,而 ViewModel 里叫 `loadDirList`——沙箱里没有 Kotlin 编译器,这一条正是替编译器干活,改名后通过。
- 测试:新增「api lists server directories for the App picker without touching the session」——建一棵真树(两个目录、一个隐藏目录、一个文件、一个有效软链接、一个悬空软链接),断言只有四个目录按序出现、`lstatSync` 证明悬空链接确实存在过所以是被过滤而不是缺失、`parent/home/defaultWorkDir/sessionDir` 全对、**连续两次浏览后 `store.getDir()` 仍为空且 `cliSession` 未被重置**、无 `path` 与 `~` 都落到预期目录、文件/不存在/控制字符/`/` 各自 400、`POST /dir/browse` 405、`/dir/nope` 404、205 个目录时截断成 200 且 `truncated` 为真。契约 sweep 加 `dir/browse` 与嵌套 `DirListing.dirs → DirEntry`,并在 sweep 的种子阶段建一个子目录,免得空列表把 `DirEntry` 的比较悄悄跳过。

`npm run check` 511/511 全绿。剩余已知缺口:`config export/import <文件>`(现在有了安全的目录列举,可在此基础上让用户挑导出位置)、Telegram `/dir` 面板的目录浏览按钮、带附件的 `/retry` 会话级重放(两端都要改)、`GET /cc/views` 与 `GET /cc/exec` 在 `x-enc: v1` 下仍是明文清单。

**队列页可重跑已结束的任务(App「最近任务」+ `GET /tasks` 的定位)**:Telegram 的 `/retry` 能重放服务器自己存的那条任务(原文本、临时模型、附件),App 此前只有在聊天页里对**最后一条**用得上这条通道;已结束一段时间、或想重跑更早一条时,手机没有任何入口。本轮把这个入口做进任务队列页,顺带把 `/tasks` 这条一直没消费者端点的作用写清楚:

- 先确认数据源只能是 `GET /tasks`:`GET /queue` 只回 queued/running,已结束的行一条不给;`/history` 的记录虽然跨重启还在,但 `cleanPrompt()` 会把提示压缩成一行摘要、也没有任务 ID,拿它「重试」等于发一条不同的消息。`#tasks` 里的记录保留 200 条(`MAX_TASK_RECORDS` + `#pruneTasks`),`#view()` 已剥掉 `controller`/`key` 并补上 `attachmentCount`/`media`,所以服务器**什么都不用改**——这条能力早就在,缺的是消费它的那一端。
- 因此 `tests/appParity.test.ts` 的 `NOT_IN_APP = ["tasks"]` 清空了。那条注释写的是「App 用 queue + history 看同样的东西」,现在看是错的;改成空数组也意味着以后新增服务器资源必须同时给 App 调用方,或者在这里写明理由。
- 中途否掉自己的一个改动:先给 `/tasks` 加了「按 `task.key === appKey` 过滤 + `scope=all` 看全部」,写完才发现 `#submitTask` 永远写 `key: this.appKey`,这个进程里不存在别的键的记录,`GET /queue` 上那句同样的过滤也一直是恒真——为一个不会发生的场景加参数是纯粹的复杂度,回退成一行注释说明 `/tasks` 与 `/queue` 的分工(是否包含已结束的)。`#tasks` 若哪天真的接住别的来源,再按那时的事实写过滤。
- 安卓端:`ApiClient.tasks(limit=20)`(与 `queue()` 同一批 `Task` 模型,不加新 schema)、`AppViewModel.recentTasks` 由 `refreshQueue()`/`pollQueue()` 一起拉(过滤掉 `isRunning`,所以与实时列表按 ID 天然互斥,`items(key = { it.id })` 不会撞),`retryRecord(id)` 只发 `POST /task/:id/retry` 然后把新任务贴回聊天并接着轮询——与 `retryTask()` 走同一条服务器路径,区别只是 ID 来自记录而不是本地气泡。队列页空态条件从 `vm.queue.isEmpty()` 改为 `queue.isEmpty() && recentTasks.isEmpty()`,否则「没有正在跑的任务」时整段记录列表根本渲染不到(LazyColumn 提前 return)。`taskStatusLabel` 补 `done/failed/cancelled` 的中文,记录卡片显示「状态 · 耗时 · 完成时刻 · 引擎 · 模型 · 附件数」和失败原因。
- 测试:新增「api tasks keeps the settled records the App re-runs from and /queue drops」——两条任务先后 settle(先 settle 再提交下一条,让时间戳差开,排序断言才是在测响应而不是测种子速度),断言两条都在 `/tasks` 里、按 `createdAt` 倒序、老记录带原文与 `reply`、`finishedAt >= createdAt`、`key`/`controller` 不是自身属性,`/queue` 回空,`?limit=1`→1 条、`?limit=0`→1 条(clamp 到 1 而不是回落默认)、`?limit=abc`→默认窗口而不是空列表(`clampLimit` 的 NaN 分支),最后用列表里读到的 ID 直接 `retry` 拿 202。契约 sweep 加 `{url:"tasks", pick:"tasks", model:"Task", list:true}`——App 手写的 `Task` 模型现在同时被两个端点检验。
- 顺手更正一条挂了很久的「已知缺口」:`/retry` 的附件重放早就是服务端行为(`POST /task/:id/retry` 用 `failed.attachments`,测试「api task retry replays the stored prompt, engine, model pin and attachments」已在断言 `attachmentCount`),两端都不用改,App 的 `retryRecord` 也直接受益。

`npm run check` 513/513 全绿。剩余已知缺口:`config export/import <文件>`(现在有了安全的目录列举,可在此基础上让用户挑导出位置;`import` 会覆盖在用的 cc-switch 库,探测时不要真跑)、Telegram `/dir` 面板的目录浏览按钮、`GET /cc/views` 与 `GET /cc/exec` 在 `x-enc: v1` 下仍是明文清单(内容不含密钥,但可考虑一并加密)、跨端(Telegram ↔ App)任务记录与历史互不可见:`/tasks` 与 `/history` 都只覆盖 `api:app` 这一个键,手机看不到 Telegram 聊天的运行。

## 20 轮维护迭代(2026-11-07 启动)

规则:第 1/3/5…19 轮只做问题发现并留下可复现证据;第 2/4/6…20 轮修复上一轮发现的问题。每轮结束更新本台账,**不单独提交**;全部轮次与最终 `npm run check` 通过后只提交一次。

| 轮次 | 类型 | 范围 | 发现 / 改动 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 发现 | 每日报告 | `formatDailyReport()` 的星期直接用系统当前时间 `new Date()`,而日期标题与数据来自传入的 `now`(定时 tick、预览、测试均可注入)。两者可能不是同一天;我在 2026-11-07 用 `day:"2026-01-01"` 复现出“2026-01-01（星期六）”,而 2026-01-01 实际是星期四。 | 独立 `tsx` 复现:`formatDailyReport({day:"2026-01-01",...},"Asia/Shanghai")` 首行为 `2026-01-01（星期六）`;待加回归测试。 |
| 3 | 发现 | API 鉴权限流 | `AuthFailureLimiter` 达 `maxKeys` 上限时按 `Map` 插入顺序无条件删除最旧键,连 `blockedUntil > now` 的封禁记录也会被地址轮换挤掉。新增测试“cannot evict a live cooldown by rotating addresses”在 `maxKeys:2` 下复现:攻击地址已封禁,两次其他地址失败请求后,`check("attacker")` 重新变成 allowed。注释声称“只淘汰更老的记录”,但没排除仍在生效的封禁。 | `node --import tsx --test tests/apiRateLimit.test.ts` → `fail 1`;其余原有用例仍覆盖窗口/成功清理/边界。 |
| 4 | 修复 | API 鉴权限流 | 上限淘汰改为只按“是否仍封禁 + 解封时间”选择:先淘汰未封禁的失败窗口;若全部封禁则淘汰最早解封的一条。新增回归用例通过,原有“地址旋转仍保持 `maxKeys` 上限”与“封禁有效期”用例也通过。 | `node --import tsx --test --test-reporter=spec tests/apiRateLimit.test.ts` → 6/6 pass。 |
| 5 | 发现 | 定时任务关停 | `ScheduleService.dispose()` 只清 interval,不等待 `#inflight`;而 `TelegramBridge.stop()` 不调用 scheduler 的 `idle()`,主进程 `shutdown()` 最后以约 100ms 定时 `process.exit()`。新测试让一个定时任务挂起后调用 `dispose(true)`,断言“返回前必须等任务落盘”;当前 `dispose` 为同步 void,`stopped instanceof Promise` 立即失败。 | `node --import tsx --test tests/scheduler.test.ts` → `fail 1`;`npm run typecheck` 仍通过。 |
| 6 | 修复 | 定时任务关停 | `dispose(true)` 现在先停止 timer 并进入 stopping,再返回 `idle()` 的 Promise;无参调用保持同步兼容。`TelegramBridge.stop()` 先发起 scheduler 排空但不在这里阻塞,随后 abort 正在等待队列的任务,最后把 schedule 排空、队列和 OpenCode abort 一起以 `SHUTDOWN_DRAIN_MS` 为上限等待,避免关停死锁。回归测试改用 recurring 任务,在任务挂起时确认 `dispose(true)` 不提前完成,完成后 `runningAt` 清空且 `lastStatus` 已落盘。 | `node --import tsx --test --test-reporter=spec tests/scheduler.test.ts` → pass;`npm run typecheck` → pass。 |
| 7 | 发现 | 过期通知与访问白名单 | 普通提醒投递会先检查 `#access(reminder.userId)`,但“停机超过 7 天”的一次性提醒在清理分支先发“已自动删除”通知,没有检查白名单;`ScheduleService.tick()` 的过期一次性任务同样在访问检查之前调用 `#notify()`。因此被移出白名单的用户仍会收到带提醒/任务编号与内容的通知。新增两条回归用例,均令 access 恒为 false、任务已过期 8 天,断言记录被清理但 `sent`/`notices` 为空。 | 独立 TSX 复现:提醒输出 `["⏰ 提醒 #1 已过期未发送：…已自动删除。"]`,定时任务输出 `["🗓 定时任务 #1 已过期未执行：…已自动删除。"]`;`node --import tsx --test` 两个文件均失败。待修复。 |
| 8 | 修复 | 过期通知与访问白名单 | 两处过期清理分支在发送通知前增加 `#access(userId)` 判断:记录仍按原逻辑删除/滚动,但已失去访问权的用户不再收到任何通知。普通提醒投递原有的访问检查保持不动。 | `node --import tsx --test --test-reporter=spec tests/reminders.test.ts tests/scheduler.test.ts` → pass;`npm run typecheck` → pass。 |
| 9 | 发现 | API 媒体下载 | `#settleReply()` 只在任务完成时调用 `resolveMedia()` 验证一次(outbox 包含关系、大小),但把绝对路径存进 task;`sendMedia()` 之后直接 `readFileSync(item.target)`,没有重新解析或限量。于是任务完成后把文件换成指向 outbox 外的 symlink,API 会原样返回外部文件;文件增长到上限以上也会照发。文件被 outbox 清理后则会抛出未包装的 ENOENT/500,而不是“已不存在”。新增用例同时覆盖 symlink 替换、下载时增长、清理三类场景,以 `ApiError` 状态断言。 | 独立 TSX 复现:输出 `symlink body: must-not-leak`;当前测试在第一条 symlink 断言处失败 `Missing expected rejection`。 |
| 10 | 修复 | API 媒体下载 | 本地媒体在 `sendMedia()` 读取前重新调用 `resolveMedia()`,按当前路径重新做 outbox realpath 包含检查、普通文件检查与大小上限检查;resolved 路径才用于读取。文件不存在映射为 410,超限映射为 413,其他不可用状态也返回 410;读取瞬间消失的 ENOENT/ENOTDIR 同样映射为 410。远程媒体流程不变。 | `node --import tsx --test --test-reporter=spec tests/apiTasks.test.ts` → 3/3 pass;`npm run typecheck` → pass。 |
| 11 | 发现 | CLI 子进程关停 | `AgentCliService.dispose()` 对每个 detached 子进程只调用 `terminateProcess()`,而它的 SIGKILL 升级 timer 被 `unref()`;`index.ts` 的 shutdown 随后只给约 100ms 就 `process.exit()`。忽略 SIGTERM 的 CLI 因而不但不会被 SIGKILL 收走,还会成为孤儿继续运行。新增独立测试 `tests/agentCliDispose.test.ts`:伪 CLI 记录 pid 并忽略 SIGTERM,断言 `dispose(100)` 必须返回 Promise 且完成后进程已消失。 | `node --import tsx tests/agentCliDispose.test.ts` → `AssertionError: shutdown must be awaitable so the parent cannot exit first`。 |
| 12 | 修复 | CLI 子进程关停 | `childKill.ts` 新增 `terminateProcesses()`:先发 SIGTERM/启动升级 timer,再等待每个子进程的 exit/close,等待上限为 grace+1s。`AgentCliService.dispose(graceMs)` 复用该函数并返回 Promise;无参调用保留同步语义供已有测试/轻量清理使用。主进程 shutdown 改为 `await agents.dispose(1_000)`,确保 SIGTERM 无效时升级到 SIGKILL 并等子进程退出后才继续释放锁和退出。 | `node --import tsx --test --test-reporter=spec tests/agentCliDispose.test.ts` → pass;`npm run typecheck` → pass。 |
| 13 | 发现 | 提醒关停 | `ReminderService.dispose()` 只清 interval 并立即返回;正在执行的 `tick()` 仍可能卡在最长 20 秒的 `#sendWithTimeout()` 投递中,而主进程 shutdown 只再等约 100ms 就退出。结果是提醒可能已发出但未 `settle`,或发送被进程退出硬切断。新增用例在发送未完成时调用 `dispose(true)`,断言它必须返回可等待的 Promise 且返回前记录已落盘。 | `node --import tsx tests/reminders.test.ts` → `AssertionError: shutdown must be awaitable so a reminder is not cut off`。 |
| 14 | 修复 | 提醒关停 | `ReminderService` 记录当前 `tick()` 的 Promise;`dispose(true)` 清 timer 后返回该 Promise,无参调用仍同步。为保持错误处理语义,`tick()` 只负责登记运行并复用原有完整循环。`TelegramBridge.stop()` 的排空集合加入该 Promise,与队列/调度器一起受同一个 `SHUTDOWN_DRAIN_MS` 上限约束。回归用例通过,并确认投递完成后记录已 settle。 | `node --import tsx --test --test-reporter=spec tests/reminders.test.ts` → pass;`npm run typecheck` → pass。 |
| 15 | 发现 | 收件目录权限 | `saveAttachment()` 用 `mkdirSync(dir, { recursive: true, mode: 0o700 })` 创建 inbox,但该 mode 只对新建目录生效;目录若已存在(启动时 `mkdirSync` 按 umask 建出 775,或旧版本留下 775),之后上传不会收紧。文件本身是 0600,但同组/其他用户仍能列出目录、看到附件文件名。新增用例先建 0775 inbox、再 `saveAttachment`,断言目录与文件都必须是私有模式。 | `node --import tsx tests/attachments.test.ts` → `an already-existing inbox must not stay group/other-readable`(`509 !== 448`,即 0775 vs 0700)。 |
| 16 | 修复 | 收件目录权限 | `saveAttachment()` 在建目录后显式 `chmodSync(dir, 0o700)`,让既有 inbox 在首次上传时也被收紧;新目录仍由 0700 mode 创建,写入文件保持 0600。回归用例通过。 | `node --import tsx --test --test-reporter=spec tests/attachments.test.ts` → 9/9 pass;`npm run typecheck` → pass。 |
| 17 | 发现 | 日报关停 | 与提醒相同的第二处独立关停缺口:`DailyReportService.dispose()` 只清 30 秒 interval,不等待正在进行的 `tick()`(发送日报)。若进程在发送完成、`lastSent` 落盘前退出,重启后同一天会再次推送;发送本身也可能被硬切断。新增用例挂起 `send`,调用 `dispose(true)`,断言返回前必须等待且 `lastSent` 已写入。 | `node --import tsx tests/usage-report.test.ts` → `AssertionError: shutdown must be awaitable so the report is not cut off`。 |
| 18 | 修复 | 日报关停 | `DailyReportService` 同样记录正在执行的 tick Promise;`dispose(true)` 清 timer 后返回该 Promise,无参调用保持同步。`TelegramBridge.stop()` 将其与提醒、调度器的排空 Promise 一并纳入统一的 `SHUTDOWN_DRAIN_MS` 上限,保证“发送完成 → lastSent 落盘”才允许继续停服。 | `node --import tsx --test --test-reporter=spec tests/usage-report.test.ts` → pass;`npm run typecheck` → pass。 |
| 19 | 发现 | API 附件大小 | `parseAttachments()` 以 `floor(base64.length * 3 / 4)` 估算解码字节数;带 `=` 填充时每个附件最多虚增 2 字节。4 个附件合计真实大小低于 15MB 时仍可能被误判超限。构造 3 个 `size % 3 == 1` 的大附件 + 1 个补齐到 `MAX_ATTACH_TOTAL_BYTES - 3`,旧代码在该合法批次上抛 `400 附件总大小超过 15MB 上限`。 | `node --import tsx tests/apiTasks.test.ts` → `attachment parsing counts decoded bytes instead of base64 padding` fail;直接复算得到 `b64Length*3/4` 比真实字节多 2。 |
| 20 | 修复 | API 附件大小 | `parseAttachments()` 改用 `Buffer.from(stripped, "base64").byteLength` 计算真实解码大小;base64 正则与总上限校验不变。合法 15MB 减 3 字节的四附件批次现可通过,真正超限的批次仍被 400 拒绝。 | `node --import tsx --test --test-reporter=spec tests/apiTasks.test.ts` → 4/4 pass;`npm run typecheck` → pass。 |

## 双实例新用户巡检(2026-11-10 启动,长期目标)

规则:在 `ab-linux-long` 与 `ab-android-long` 两个新实例上以新用户视角真实操作;每轮只改确认过的问题并留下测试与 UI 证据;不删除、不停止、不占用已有 `codex`/`gemini`/`grok`,不清理 `data/` 与会话。

实例:`ab-linux-long`(`m_agq4jqowzztteuxiwjcftsbnby`,Linux Bot 与 OpenCode)、`ab-android-long`(`m_agq4jqp5crmsgraloggb4746ju`,Android 模拟器与 App)。控制方式为 `instabox exec <name> -- …`、`instabox push/pull`、`adb install -r`;截图与 APK 只走文件通道。复现步骤见 README 的「双实例真实测试（Linux + Android）」。

| # | 类型 | 内容 | 验证 |
| --- | --- | --- | --- |
| 1 | 修复 | `ListScreens.kt`:清空任务历史、删除提醒、删除定时任务都在点击后先弹确认,取消不再丢数据;提醒/定时任务读取失败时隐藏无法成功的右下角「+」入口 | `npm run check:android`;真实 Android UI 点「清空历史」→确认框→取消后 32 条记录仍在;无推送目标时两个列表只显示错误与「重试」 |
| 2 | 修复 | `StatusScreen.kt`:缩小顶部信息与右侧状态的争宽,长服务器 URL 改为整行可选择文本,状态读取失败与尚未加载给出明确文案和重试入口 | 720×1280 真实截图:标题单行、在线状态在 hero 卡、URL 完整可辨认;相关契约测试全绿 |
| 3 | 修复 | 历史清空改用服务端返回的实际条数:非空时提示“已清空 N 条历史”,空列表时提示“没有可清空的历史”并禁用菜单项;补齐隔离测试覆盖 `cleared:0` | `npm run check` 910/910 全绿;真实 Android 非空历史仍弹确认,取消后 32 条记录保留 |
| 4 | 契约 | `tests/appParity.test.ts`:固定历史/提醒/定时任务的确认框与错误态入口、历史清空计数语义,以及状态页 URL 整行与短副标题 | `npm run check` 910/910 全绿;Android `assembleDebug` 成功 |
| 5 | 安全 | `SettingsScreen.kt`:配对令牌与加密密钥默认改为密码字段遮蔽,新增明确的「显示/隐藏」开关和“凭据已隐藏/当前可见”提示;离开设置页重新进入自动恢复遮蔽。`AppTextField` 增加 `keyboardOptions` 参数以关闭密码字段自动纠错 | `npm run check` 911/911 全绿;真实 Android UI:首次进入为「凭据已隐藏」且两字段 `password=true`;点显示后可见、点隐藏后恢复;重进入仍默认隐藏 |
| 6 | 安全 | `src/ops.ts`:`data/backups/` 始终收紧到 `0700`,新归档在 `tar` 成功后为 `0600`,已保留的旧归档也一并收紧;`src/index.ts` 启动时对 `data/outbox/`、`data/inbox/` 同样显式收紧,避免旧目录沿用 `0775` 让同机其他用户读取附件与备份 | `node --import tsx --test tests/ops.test.ts` 24/24;Linux 实例隔离真实 `tar` 验证 `dirMode=700,fileMode=600`;重启后执行一次真实备份,`backups` 从 `775` 收紧为 `700`,新旧归档均为 `600`;未发送通知、未删除业务数据 |
| 7 | 修复 | `AppDrawer.kt`:分组导航与外层顶部间距拆开,内容区单独 `verticalScroll`;滚动内容顶部加 6dp 缓冲,滑到中部时首行不再贴住固定「新对话」按钮;底部「设置」仍在滚动区外。`tests/appParity.test.ts` 改为断言 `padding(top)` 位于 `verticalScroll` 之前、设置位于滚动区之后,并检查顶部缓冲,旧排版不能通过 | `npm run check` 911/911 全绿;Gradle `assembleDebug` 成功;真实 720×1280 抽屉首屏与上滑截图均可见固定「设置」,上滑后「配置项/帮助」可达;`adb install -r` 后 `firstInstallTime=2026-11-10 09:31:00` 保持不变 |
| 8 | 修复 | `src/ops.ts` 的 `lastBackupAt` 取 `statSync().mtimeMs` 小数,App 的 Kotlin `Long` 解码失败,整个运维诊断因此无法显示。服务端统一 `Math.floor`;`tests/ops.test.ts` 用真实小数 mtime 回归;`tests/appContract.test.ts` 把 Kotlin `Int/Long/Short` 从“JSON number”提升为“安全整数”,避免同类字段再次漏检 | `node --import tsx --test tests/ops.test.ts tests/appContract.test.ts` 全绿;真实 `/ops/diag` 与 `/ops/release` 均返回 `1794323972109`(safe integer);真机运维页显示「最近备份 11-10 15:19」且无解析错误 |
| 9 | 修复 | 公网 Instabox 入口约 20 秒切断长请求,`POST /ops/check` 同步等待 30 秒只在手机侧变成 502 而服务端仍在跑。新增 `OpsActionJobs` 与 `GET /ops/actions/:id`(及 `/latest?label=` 重连),`?async=1` 立即返回 202 任务 ID;Android `ApiClient` 轮询结果,旧同步响应保持兼容;`scripts/app-smoke.mjs` 覆盖异步检查更新 | 公共 URL 实测 `POST /ops/check?async=1` 0.10s 返回 202,轮询约 28s 取回 916/916 检查结果;真机点「运行检查」显示忙碌态,15s 后结果卡「完成 / 检查通过」;Linux 完整 `npm run check` 916/916 全绿 |
| 10 | 修复+契约 | 左抽屉每次从关闭变为打开都复位到顶部,保持打开时重组不打断阅读;提醒/定时任务补齐加载中、读取失败、推送目标不可用、空列表与有数据五态,`GET /info` 新增 `automation.{available,reason}`,无 owner 聊天时页面提前解释并隐藏创建入口;不可用页的「重新检查」会先重读 `/info` 再取列表,服务端随后配好 Telegram/飞书时无需重启 App;未连接首屏移除可发送的假示例,只保留“先在设置填写地址与令牌”和「打开设置」;设置页的服务器地址允许换行,长 Instabox 主机名不再被截断。`tests/api.test.ts` 覆盖 `/info` 契约、两类自动化写入 409 与晚到 owner,`tests/appParity.test.ts` 覆盖抽屉复位、自动化五态、重新检查、未连接引导与地址换行 | `npm run check` 921/921 全绿并构建成功;`assembleDebug` 成功;真机连续关闭/重开抽屉两次均在顶部,提醒页显示不可用原因且点「重新检查」后无错误横幅,清空连接字段后首屏只显示设置引导,设置页完整地址在 720×1280 屏上换行显示;恢复原连接配置后 SHA-256 `1e563cbc0db31c277836d3729acfc15a7b00e25ca48593ec07a9eb268643f59f` 与备份一致,聊天历史和已连接状态均保留;截图 `round10-reminders-check.png` SHA-256 `1c10b38d3de27a9e73ee29e78443986618ecdd36bffb2b5230e0af33295c849a`、`round10-settings-wrap.png` SHA-256 `679cd93ce9c90c5a11ce3cec764d3329afbc1f54f3287c31961e98cf1d24651a` |
| 11 | 修复+契约 | 任务队列页原先只有空列表时才渲染读取失败,而重试失败写入的全局横幅只在聊天页显示;从队列点重试成功后也没有任何确认,用户无法判断新任务是否真的提交。新增共享 `PageErrorNotice`(可关闭/可重新加载),队列页分别展示读取失败、动作失败;`retryRecord`/`stopTask`/`clearQueue` 的失败落到本页,成功重试显示「已重新提交任务,结果可在聊天中查看」;已有记录刷新失败时保留旧列表并显示原因。`tests/appParity.test.ts` 固定错误条、成功提示、非私有读取属性与三类动作失败反馈 | `node --import tsx --test tests/appParity.test.ts` 37/37;`npm run check` 922/922 全绿并构建成功;Android `assembleDebug` 成功(期间真实编译器抓到两处 `private set` 读取错误并修复);`adb install -r` 后设备 APK SHA-256 `f1935a85f5a69f56b899a7d47262b8da293eae6e7a7bc06e6b6f61a757879350`,`firstInstallTime=2026-11-10 09:31:00`、`lastUpdateTime=2026-11-11 01:03:47`;真机点「重试」看到成功 Snackbar 与新增 00:54 记录,断网重启后队列正确显示「暂时无法加载任务队列」及原因/重试,测试后连接配置哈希恢复一致且聊天历史仍在 |
| 12 | 修复+契约 | 模型管理的添加/绑定/删除失败原先写进仅在聊天页渲染的 `connectionError`;添加框随后直接关闭,真机输入无效格式后页面毫无反馈、输入也丢了。新增模型页 `modelActionError`,三类失败都留在本页;格式校验失败返回 `false`,添加框保持打开并保留输入,再用 `modelDraftRejected` 在框内显示原因(否则错误条会被对话框盖住);服务器失败则关闭对话框并显示页面错误条。共享 `TextPromptDialog` 增加可选内联 `error`,仅供表单校验使用;键盘弹出时整个弹窗随 `imePadding` 上移,标题/说明/输入区在剩余高度内滚动,分隔线与操作按钮固定在弹窗底部,720×1280 真机上“取消/添加”完整可见。`tests/appParity.test.ts` 固定失败落点、非私有属性、只在校验失败时保留对话框、错误条位置,以及正文权重、分隔线与操作栏必须是同一根 `Column` 的兄弟节点 | `node --import tsx --test tests/appParity.test.ts` 39/39;`npm run check` 924/924 全绿并构建成功;Gradle `assembleDebug` 成功;设备同款 debug key 重签 APK SHA-256 `02f6e8ab939107296b475f0ffc0e5121d2541b8ae5bfefc96eec54eafdf3fcda`;`adb install -r` 后设备 APK 哈希一致,`firstInstallTime=2026-11-10 09:31:00`、`lastUpdateTime=2026-11-11 01:56:36`;真机输入 `badmodel` 后键盘打开时“取消/添加”完整可见,提交后对话框保持打开、文本仍在,框内显示「用法：简称 provider/modelID …」,取消后模型页错误条仍可见;截图 `shots/round12-inline-error-keyboard.png` SHA-256 `dccc33ebae9a839ad66cd9521f4145bca5d1fb9b653cd159ae935643df8e0253`、`shots/round12-model-error-after-cancel.png` SHA-256 `5ea4fcd4e661f53304dbe7b5ff93b415ec725455f839e1ecb6ced4b4bd8d9e95`;运行状态页首屏/中部/底部无溢出,长 URL、会话 ID 可折行,7 天趋势与每日报告完整 |
| 13 | 修复+契约 | 配置、白名单、代理、快捷指令和会话设置的写操作原先失败时,提示可能只落在聊天页的全局横幅或被直接关闭的弹窗里;用户在表单中既看不到失败原因,输入也随弹窗丢失。现在每个页面都有本页可关闭的 `*ActionError`;服务端 400 也会设置 `*DraftRejected`,让错误直接显示在弹窗内并保留输入,只有成功才关闭。新增删除配置项、移除白名单、删除快捷指令、删除代理的确认框,失败时确认框保持打开并展示原因。`unsetConfig`、`removeProxy` 与 `followPeer` 增加结果回调,“跟随会话”也只在成功时关闭。打开弹窗时清理上一次的错误,避免串页。真机走查又发现键盘打开时输入框会被长错误原因挤出视口:共享 `TextPromptDialog` 现在把标题/帮助留在上方可滚动正文,错误原因固定在输入框上方并默认折叠为两行(超过 60 字可点按展开),输入框与操作按钮固定在根 `Column` 内;这样长错误、草稿和按钮不会互相遮挡。`tests/appParity.test.ts` 固定服务端拒绝、确认框失败、跟随会话、错误清理、回调用法及折叠式错误布局,共 40 条断言 | `npm run check:android` 33 个 Kotlin 文件通过;`node --import tsx --test tests/appParity.test.ts` 40/40;`npm run typecheck`;Android 实例上真实 `./gradlew assembleDebug --no-daemon` 成功;全文 `npm run check` 925/925 全绿并构建成功 |
| 14 | 真机验证 | 在同一台 `ab-android-long` 上验证第 13 项的真实失败路径。快捷指令输入 `help oops` 被服务端 400 拒绝后弹窗保持、输入未清空,折叠错误区显示与内置命令冲突的原因并可展开;取消后旧错误条消失。配置新增 `BAD_KEY badvalue` 显示服务端支持键列表的折叠摘要,草稿仍在,`.env` SHA-256 不变且键数仍为 51。自定义时区提交非法值后弹窗内显示 IANA 校验错误,`.env` 与 `REMINDER_TIMEZONE` 仍为 `Asia/Shanghai`。代理输入 `invalid`、白名单输入 `abc` 和 21 位数字都显示本页/弹窗内原因并保留输入。白名单删除不存在的 ID 由服务端返回 400,没有增删任何用户。另发现并当场清理了一次被服务端接受并规范化为 `/badname` 的测试快捷指令,最终列表恢复为空 | 最终设备 APK SHA-256 `2dcc18b292651ec2a8eb8b0fef383c4cd071597395635d2c030c65cce7bc8d5e`,与构建产物一致;`firstInstallTime=2026-11-10 09:31:00` 保持不变,`lastUpdateTime=2026-11-11 03:05:30`;全部覆盖安装前后偏好文件 SHA-256 均为 `a0a6746e4b51fc262afdf010458ab2ab39eb7a0a86e841e48188432e2f21d52f`;冷启动 `LaunchState: COLD`,焦点回到 `com.agentbot.app/.MainActivity`,连接状态和已有聊天历史仍在;Linux 实例 `3080/4096/3425` 保持监听,带令牌 `/api/v1/health` 返回 200,`.env` 仍为 51 键且 SHA-256 为 `a207a11d9624c8d2c1e83ae596c82db2773c925a372b9d8a2dd41cdfdf141d2a`;关键截图已拉回并通过哈希核对,最终键盘下布局见 `shots/round15e-alias-collapsed.png`(短错误)与 `shots/round15e-config-collapsed.png`(长错误) |

安装与持久化证据:第 7 项 APK SHA-256 `cb1fdec9d1d63036a235e3bdce9c2a125cba3efdbd6b9182c7fdcbfcff5c1d83`;第 9 项 APK SHA-256 `183357eec6f275c36fb2fdd829c2ad7e7691d3c2e7e3b3034fded3531894a112`;第 10 项设备上已安装 APK 的 SHA-256 `bf2e92d87e4d5be3390c02fa36c6530dba5a076e2c974d50a97cb6598481966a`(直接读取 `pm path` 指向的 base.apk)。多次 `adb install -r` 后 `firstInstallTime` 均保持 `2026-11-10 09:31:00`;最新 `lastUpdateTime=2026-11-11 01:56:36`,设备上已安装 APK 的 SHA-256 与本地构建一致;连接配置仍在,设置页可正常读取并遮蔽令牌与密钥。

运行态验证:第 6 项先用 `npm run build` 更新 `dist/`,再在 `ab-linux-long` 执行 `npm run bot -- restart`;Bot 新 PID 为 `49999`、受管 OpenCode 新 PID 为 `49983`,重启自检通过。`3080`、`4096`、`3425` 均保持监听,未带令牌访问 `/api/v1/health` 与 `/ops/backup` 都返回 `401`;`data/outbox`、`data/inbox` 重启后为 `700`,真实备份后 `data/backups` 为 `700`、两份归档均为 `600`。第 9 项发布后 Bot PID `67548`、受管 OpenCode PID `67534`,启动自检通过。

App 端验证:重启后在 `ab-android-long` 的聊天页发送「Reply today in UTC only」,界面从「已连接」收到 `2026-11-10（UTC，当前 15:21:50）`,确认手机端会话、任务与 SSE/轮询链路均可用。项目自带 `npm run smoke:app` 另跑通 16/16 步,覆盖健康、会话/模型/状态、任务终态、文本附件、SSE 与停止任务;本轮只操作 smoke 自己创建的任务。抽屉改进后重新构建并 `adb install -r` 当前 APK,`lastUpdateTime=2026-11-10 15:48:03`;首屏与上滑截图哈希分别为 `17258767d14f5b61720571ed23d8de40133447eb4ddef81d93f6027cc2cea527`、`e3773eb3040c25a276c9fad47e94856bfe2b121c16f44b6f222b9ae6f2c67ac4`。第 9 项再次 `assembleDebug` 与 `adb install -r`,设置页与聊天记录仍在;真机运维页的「运行检查」从忙碌态变为成功结果卡。

第 10 项复跑公网 `npm run smoke:app`:18/18 通过(`GET /health` 与 `/ops/check-update?async=1`、十个只读端点、真实任务终态、文本附件、SSE 4 帧、停止自己起的任务),只新增 smoke 任务,未改动会话、目录或队列之外的任何数据。冷启动回归后窗口焦点落到 `com.agentbot.app/.MainActivity`,原聊天历史仍在;最终首页截图 `round10-final-home.png` SHA-256 `5066e56b672eef28f5b598d987a1107af011811d5200664b656a635f56176b4b`。

第 11 项真机证据:队列页重试成功时 Snackbar 文本为「已重新提交任务,结果可在聊天中查看」,顶部新增 `11-11 00:54` 的已完成记录,截图 `round11-retry-toast.png` SHA-256 `3e83c4bbff6f0a801d63ff757b0117489c23c15df670676cb093882130732373`;不可达地址冷启动进入队列时显示「暂时无法加载任务队列」及完整原因与重试,未显示成空列表。之后用备份恢复 `shared_prefs/agent_bot.xml`,恢复前后哈希一致;冷启动重新连接,聊天历史仍在。最终首页截图 `round11-final-home.png` SHA-256 `3a48ab53335f2c5678a6d4b7394fea0d68f1f494b3fcddeae12516d2fb75a959`。

第 14 项双实例连通复核:在 `ab-linux-long` 用公网入口与真实 `API_TOKEN`、`API_ENCRYPTION` 密钥执行 `npm run smoke:app`,18/18 通过(健康、十个只读端点、文本与附件任务、SSE 4 帧、异步检查更新、停止自己起的任务);随后在 `ab-android-long` 的聊天页输入 `android-e2e-ok` 并发送,服务器任务 `tmwbhgn4m21` 状态为 `done`,App 偏好文件中的聊天记录同步出现同任务 ID 的助手回复,收起键盘并滚到底后界面显示 `Agent / android-e2e-ok / 11-11 02:11`。验证期间只新增该条任务,未改引擎、目录或他人队列;两台实例仍为 running,`codex` 不变,`gemini`/`grok` 仍 suspended;本轮为传 APK/截图临时发布的 8765/8766/8767 已全部撤销并停止本地监听,Linux 的 3080/4096/3425 未被触碰。

剩余缺口:提醒与定时任务的删除确认框尚未在真实列表上触发,因为当前实例没有 Telegram/飞书推送目标,API 返回 409;目前由静态门禁与契约测试覆盖。第 11 项「已有列表刷新失败仍保留并提示」的端到端路径需要在不重启 Activity 的情况下切换为不可达配置;本轮交替替换偏好文件会重新初始化 ViewModel,只验证到冷启动失败页。条件与读/动作失败分支已由 `tests/appParity.test.ts` 固定,后续可在同一 Activity 内用设置页的“探测失败但保留旧配置”流程补真机证据。后续继续巡检运行状态、任务队列之外的高频页面。
| 16 | 修复 | `SettingsScreen.kt` / `AppViewModel.kt`:配对探测失败时把真实原因留在设置表单,并明确旧配置是否保留;新地址失败不再污染仍可用的旧连接,也不自动跳走。成功时先显示「连接成功,即将返回聊天」约 1.5 秒再回聊天。失败文案去掉重复的「连接失败」,失败原因不再在页面底部重复渲染。同步把提醒/定时任务的推送说明从「仅 Telegram」改为「Telegram 或飞书/当前聊天渠道」。 | `npm run check:android` → 33 个 Kotlin 文件通过;`node --import tsx --test tests/appParity.test.ts` → 40/40;真机失败路径显示单条「连接失败,已保留原配置。无法连接服务器……」,旧连接仍为「已连接 agent-bot 0.4.0」;真机成功路径约 0.4 秒时显示「连接成功,即将返回聊天」,随后自动回聊天且仍连接。APK SHA-256 `7f03501a7c831732393314588cbdc002e776c486bc2d92c927368d85c40dec62`,设备 `pm path` 指向的 base.apk 哈希一致,`lastUpdateTime=2026-11-11 03:25:59`,`firstInstallTime` 仍为 `2026-11-10 09:31:00`。失败/成功截图 SHA-256 分别为 `16fc69704eed32e9340f9dd42ea8a6212d2603fe2e349ab52bbdc7282dc8a5b5`、`2a37d8747b289371282f62315991be29427c970d61e328ba87055369c3422718`。 |
| 17 | 验证 | 双实例真机复核任务队列的读失败状态:用受控临时入口先保存一条真实可用的连接,再让它返回 502,在队列页刷新时确认旧列表与错误提示同时保留;并复核空列表冷启动显示完整失败原因与重试。新增 `tests/appParity.test.ts` 契约,固定 `refreshQueue()` 必须两次读取都成功后才替换列表、失败分支不得清空 `queue`/`recentTasks`。 | 真机队列原有 5 条记录在刷新失败后全部保留,顶部显示「无法加载任务队列：temporarily unavailable」及「重新加载」,截图 `round17-queue-502-with-list.png` SHA-256 `30b347596556eff3010e74ecf1daf3db6ab50eef9ae65feb1e2bfb94b2fa5d17`;空列表失败态显示「暂时无法加载任务队列」、完整原因与「重试」,截图 `round17-queue-cold-fail2.png` SHA-256 `8da6da5a651eba0c4a3281ae01964b8a93f34eb1e49068e9fa2d3e51e85928a4`。`node --import tsx --test tests/appParity.test.ts` → 41/41。验证临时端口 3081/3082 与代理已撤销,Linux 仅保留原 3080 发布;App 已恢复 `3080`,重新连接且聊天记录仍在,最终截图 `round17-final-restored.png` SHA-256 `58ef4b30c8479321264458a4a52a7c48af816ad43db5eb954f39de1acca94fc3`。 |
| 18 | 修复 | App 附件大小标签统一走 `formatFileSize()`:待发送 chip、已发送气泡、任务媒体与设置页 APK 大小此前各自保留一套取整逻辑,同一个 34B 文件发送前显示 `1KB`、发送后显示 `34B`。小于 1KB 保留精确字节数,较大文件保留一位小数;补契约测试固定发送前后使用同一格式函数。 | `node --import tsx --test tests/appParity.test.ts` → 42/42;`npm run check:android` → 33 个 Kotlin 文件通过;Android 实例真机贴同一个 34B 文件,发送前与发送后均显示 `34B`,截图 `round17-attachment-fixed.png` SHA-256 `1fd9816ff28a8da16283f1076cb7cdde20d651e54b6f49c752bab569ad5b5d38`。最终 APK `b23edb92c24e1bec4c575fcdd8fd9ee25e5306d3e419503c8cea38854d9c1e98`,设备 `base.apk` 哈希一致。 |
| 19 | 调查 | 聊天输入焦点“跑到助手消息”复核:先用 `uiautomator` 的 bounds 判断焦点错误,但软键盘弹出后窗口被 resize、测试树仍返回上一屏坐标,且手动 `adb input tap` 按错误坐标点中了消息文本。清理 `chat_draft`、冷启动后按真实 composer 与发送按钮坐标重测,只在 composer 输入 `focustest`,草稿保持单值、焦点留在底部输入框,发送任务 `tmwbl22wx23` 收到回复,证明不是 Compose 消息语义串线;未保留无效的 `FocusRequester` 实验补丁。真机成功链路另见 `round18-final`(`tmwbl3wty24`)。 | `node --import tsx --test tests/appParity.test.ts` → 43/43;真机偏好文件 `chat_draft` 在输入/发送后均为空,`chat_messages` 只追加正常用户与助手两条;最终首页截图 `r18-final-home.png` SHA-256 `ae03c7092606301a5bc05cb60ed90c0fa24d107f07aedee30a55d807236ac894`;发送后截图 `r18-final-chat.png` SHA-256 `05f94ee2dbc268bed10564bb04af5ac7f6454fe8a3db4ce4545f96eab9f6de91`。 |

第 18/19 项真机只在 `ab-android-long` 上替换 App 与偏好文件,`firstInstallTime` 仍为 `2026-11-10 09:31:00`,`lastUpdateTime=2026-11-11 03:53:09`;没有停止、删除或占用 `codex`/`gemini`/`grok`,也没有改 Linux 的监听端口或配置。`uiautomator` 在键盘动画期间的 bounds 不能作为“焦点/tap 落点”的唯一证据,后续真机走查先等键盘稳定,再用偏好文件的实际 `chat_draft` 与任务终态交叉确认。
