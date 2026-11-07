# 100 次深度迭代台账(问题 ↔ 解决 交替)

> **当前进度：42/100 轮（进行中）。** 早期并行审查留下了重复的轮次编号（如 11/12、15/16 各出现两次），内容以表格中的执行顺序为准；后续从第 43 轮继续。

**规则**(2026-11-05 设定):奇数轮「提出问题」——对指定领域做深度代码审查,列出具体问题清单(文件:行/问题描述/严重度);偶数轮「解决问题」——逐条修复上轮清单(或给出保留理由),每轮 `npm run check` 全绿。第 100 轮为止,累计提出与解决问题各 ≥50 条为完成线。

领域轮转池:telegram.ts(分段)、api.ts(分段)、agentCli、ccCommands、ops、ccswitch、reminders、scheduler、opencode、modelAdmin、agentInstaller、proxy、media、store/usage/history、Kotlin(ApiClient/AppViewModel/各 Screen)、Kotlin(ChatScreen/ListScreens)、脚本与部署、文档一致性、安全专项、性能专项。

| 轮次 | 类型 | 领域 | 摘要 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 提出 | telegram.ts 命令分发区 | 4 项发现:Q1 拼错命令静默发给 AI(中,待实现);Q2-Q4 经核实为有意设计,建议保留 | — |
| 2 | 解决 | 同上 | 实现 Q1(邻近命令提示);Q2-Q4 保留理由入档 | npm run check 625 全绿 |
| 3 | 提出 | 持久层(store/usage/history/jsonStore) | 5 项发现:Q1 history 加载不按时间排序(中,待实现);Q2 SessionStore 空壳记录累积(低,待实现);Q3 formatStamp 无效时区静默回退 UTC(极低,保留);Q4-Q5 null-prototype/原子写/损坏留档/prune 节流确认正确 | — |
| 4 | 解决 | 同上 | 修复 Q1(history #load 按 at 降序,保 newest-first 语义)+Q2(SessionStore 加载时丢弃空壳记录,engine-only 等有状态记录保留);新增 2 测试(乱序文件排序、空壳丢弃+engine-only 保留);Q3 保留理由入档 | npm run check 627 全绿 |
| 5 | 提出 | reminders/scheduler | 5 项发现:Q1 runNow 返回执行前旧快照,API/App 拿到陈旧 runningAt/lastRunAt(中-高,真 bug,待修);Q2-Q5 经核实正确(#runManual 生命周期、zonedParts %24 防 Intl 24 时、zonedToUtc 双迭代 DST、10s interval 下限由 MAX_PER_CHAT 限流) | — |
| 6 | 解决 | 同上 | 修复 Q1(runNow 返回更新后的 store 快照);新增测试(运行中快照带 runningAt、结束后 lastStatus/lastRunAt 写入);Q2-Q5 保留理由入档 | npm run check 628 全绿 |
| 7 | 提出 | opencode.ts(SSE 客户端与 prompt) | 全文审:重连退避/1MB 事件上限/abortSession 服务端止损/双超时/settled 防迟到 SSE——实现质量高,**零必修缺陷**;发现 3 个测试缺口(超大事件重连路径、health 非 200、硬超时与 idle 的钳制关系未测) | — |
| 8 | 解决 | 同上 | 补 3 个边界测试:超限事件触发断开重连且健康连接的事件仍送达(按真实语义:断开+1s 退避,而非行内丢弃);health 401 即使 healthy:true 也返回 false;确认 maxTimeoutMs 被 Math.max(idle) 钳制为设计使然,测试 628→630 | npm run check 630 全绿 |
| 9 | 提出 | media.ts/proxy.ts | 双文件全文审:SSRF 防御矩阵(IPv4 全段/IPv6 含 NAT64/6to4/Teredo)、pinnedLookup 钉死、符号链接逃逸、SOCKS 握手、双重复查——**零必修缺陷**,测试覆盖 23+9 已含 SSRF 矩阵与 env 生命周期;唯一缺口:parseProxyUrl 的 hash 拒绝分支未测 | — |
| 10 | 解决 | 同上 | 补 hash 拒绝断言(一行);media/proxy 零缺陷结论与覆盖清单入档 | npm run check 630 全绿 |
| 11 | 提出 | agentCli.ts(进程管理与 argv 防御) | 全文审:进程组信号/优雅升级 SIGKILL/stdioDrained/argv 注入防御/O(n) 输出截断——质量高;1 个假设待验证:自定义 profile 的 resumeErrorPattern 若为非法正则,close 回调里 new RegExp 是否让进程崩溃 | — |
| 12 | 解决 | 同上 | 假设**证伪**:registry 加载期已有正则校验+per-profile try/catch 隔离(双层防御),非法 pattern 的 profile 被拒且不影响同文件其他 profile;隐式守卫固化为显式测试,测试 630→631 | npm run check 631 全绿 |
| 15 | 提出 | modelAdmin.ts(自定义模型与 opencode.json 同步) | 全文审:损坏注册表拒绝写/权限保留写入/五重冲突检查/路径逃逸防御/$ 字面量——**零必修缺陷**;2 个低项保留(add 跨文件双写无事务,失败面极窄;provider.models 损坏数组被修复性覆盖);2 个测试缺口(assignAgent 无 frontmatter 报错分支、坏数组修复语义未测) | — |
| 16 | 解决 | 同上 | 补 2 测试(无 frontmatter 报错且文件原样保留;坏数组修复且 repaired-model 键落位);调试中确认 add 的 opencode.json 写入行为正确——教训:断言键名要与实际 JSON 键一致(锆写 repaired vs repaired-model 造成假红),测试 631→633 | npm run check 633 全绿 |
| 49 | 提出 | Kotlin LocalStore/MediaFiles/TaskNotifier(254 行) | 审查:read 预检+流式截断+空文件拒绝、saveMessages 2MB 预算+最新行必保、loadMessages 逐行容错、MediaCache 键清洗+降采样——**零必修缺陷**;1 项语义确认:MediaCache 靠系统回收 cacheDir,无需显式 trim | — |
| 50 | 解决 | 同上 | MediaCache 文档固化 cacheDir 语义(解释为何无需 trim);走查确认项入档;Kotlin data 层三小文件审毕 | npm run check 694 全绿 + lint 0 告警 |
| 47 | 提出 | Kotlin ApiClient.kt(App 网络层,800 行) | 全文审:submitTask(逐字段构造/task 字段守卫)、streamTask(**settled JSON 快照回退**——api.ts 对已结束任务返回普通 JSON 的行为被正确处理)、execute 加密集成——质量高;**发现 Q1(中)**:SSE 读循环不响应协程取消(OkHttp 阻塞读),离开页面线程最长滞留一个心跳周期 | — |
| 48 | 解决 | 同上 | 修复 Q1(循环内加 ensureActive(),每行之间检查,取消时 use{} 立即关闭响应);其余确认项入档 | npm run check 694 全绿 + lint/knip 0 告警 |
| 41 | 提出 | 远程媒体下载链路(#fetchRemoteMedia + readCappedBody) | 全文审:逐跳 assertUrlAllowed(重定向手动跟随,hop≤3)、pinnedLookup DNS 钉死(代理时交由代理网络,注释明确)、双重大小限制(declared+流式)、body.cancel 释放——**零必修缺陷**;缺口:重定向链与私网逐跳拒绝零直测 | — |
| 42 | 解决 | 同上 | 补集成测试(telegram.test.ts,经 bridge 公开方法+本地 http server):私网逐跳拒绝(默认配置 302 链全部被拒);HarnessOptions 加 mediaAllowPrivateUrls 开关。测试 644→645 | npm run check 645 全绿 |
| 39 | 提出 | scripts/ 目录(12 个脚本,1604 行) | 全扫:sniper_free_vps/send_mail/x_action/check_inbox/check_free_site/x_search/check-android-sources/install-cc-switch/restart/proxy-exec——Playwright 会话文件模式、无命令注入(execFile/$$eval 固定)、proxy-exec 的 set -euo pipefail 正确;**发现 S-1(中-高,安全)**:sniper 登录失败时 stringify 整个响应体进持久日志,凭据回显会泄漏进日志文件 | — |
| 40 | 解决 | 同上 | 修复 S-1(登录失败日志对 email/password 字段脱敏,node --check 验证);其余确认项入档(Playwright session 存储模式、无 console 凭据泄漏、SNIPER_* 环境变量读取) | node --check + 人工核对 |
| 35 | 提出 | ccswitch.ts 前段(toDeeplinkApp/parseMcpConfig/校验链) | 审查:parseMcpConfig 双模式、assertPlainText/ProviderUrl/SafeId、resolveCcSwitchBin 三形态、defaultRunner 自有 deadline+SIGKILL、errorDetail redact——**零必修缺陷**;缺口:assertProviderUrl 的 @ 拒绝与 500 字上限未直测 | — |
| 36 | 解决 | 同上 | 补 2 断言(带凭据 URL 拒绝、过长拒绝);toDeeplinkApp 已有覆盖(含 toString 原型防御断言);确认项入档 | npm run check 643 全绿 |
| 97 | 提出 | 终结复合自查 | noUnusedLocals 0/TODO 0/console.log 仅 CLI 入口/lint+knip 0;近期改动抽查(savedAttachments×7、ensureActive×2)痕迹正确 | — |
| 98 | 解决 | 同上 | 零发现确认入档 | npm run check 703 全绿 |
| 95 | 提出 | 机动确认轮——全部门禁复扫 | noUnusedLocals 0/TODO 0/lint 0 告警/knip 零发现;确认用户已提交两批(aa31dcc 深度审查修复、db27ba5 项目优化),远程已同步 | — |
| 96 | 解决 | 同上 | 门禁全绿确认入档;工作区剩余为本会话后段迭代改动(DEEP-100.md/CHANGELOG 等) | npm run check 703 全绿 |
| 93 | 提出 | Kotlin SlashCommands.kt 全文(399 行,命令表与分发) | 审查:matchCcQuery 最长词组优先+read-only 优先于写+目标有无 tie-breaking;applySlashCommand 全分支用法提示(export/agent/agents/model/dir/timezone/cancel/schedule/env/access/alias/proxy/cc/logs/ops/update/restart/service);fallback 优雅引导去 Telegram;SLASH_COMMANDS 与 appParity 对齐——**零必修缺陷** | — |
| 94 | 解决 | 同上 | 确认入档;SlashCommands 审毕 | npm run check 703 全绿 |
| 91 | 提出 | setup-cli.ts(11 行,CLI 入口包装) | 审查:薄包装正确(错误打印 err.message,setup.ts 错误已脱敏);微项:非 Error 对象时打印对象本身而非 String 化 | — |
| 92 | 解决 | 同上 | 非 Error 分支改 String(err)(与 messages/错误语义一致);setup-cli 审毕,src/ 全文件审毕 | npm run check 703 全绿 |
| 89 | 提出 | apiOpsRoutes(72 行)+ apiAgentRoutes(74 行)抽查 | OpsRoutes:diag/service/check-update/backup(二进制迁移正确)/logs(行数钳制 10-400)/POST 动作白名单——与旧 api.ts 一致;AgentRoutes:resolveEngine 特判/isManaged 守卫/使用中 409/#running 单飞/redactSecrets——**零必修缺陷** | — |
| 90 | 解决 | 同上 | 确认入档;apiOpsRoutes/apiAgentRoutes 审毕 | npm run check 703 全绿 |
| 87 | 提出 | 新拆模块抽查(apiCc.ts 537 行/apiCcSpecs.ts 514 行/apiModelRoutes.ts 96 行) | 审查:依赖注入模式与 apiPersonal 统一(CcRouteDeps:ccQuery 读/runCcAction 写/withCcLock 互斥三者分离);apiModelRoutes 校验/冲突/能力提示完整;apiCcSpecs 纯函数校验——**零必修缺陷** | — |
| 88 | 解决 | 同上 | 确认入档:并行会话的 api.ts 拆分质量高(读写锁分离设计正确);新模块抽查完毕 | npm run check 703 全绿 |
| 33 | 提出 | ccCommands 剩余分支(#handleCcGroup/#runCcGeneric/#dispatchCc) | 审查:三层 dispatch 防御(--app 拒绝/禁跑清单/确认计划)、deeplink 白名单、provider add 的 apiKey 警告与输出掩码、importMcp 的 base64url deeplink 编码——**零必修缺陷**,掩码已有直测;缺口:mcp add 的 deeplink 编码未直测 | — |
| 34 | 解决 | 同上 | 补 deeplink 编码测试(config 经 base64url 往返一致、apps 键断言);确认项入档(--app 全拼写拒绝/禁跑清单/deeplink 长度上限) | npm run check 643 全绿 |
| 85 | 提出 | apiRateLimit.ts(115 行,并行会话新功能)+ api.ts 拆分全景 | **发现:并行会话完成 api.ts 全面拆分**(2158→1014 行,拆出 apiCc/apiCcSpecs/apiRateLimit/apiModelRoutes/apiAgentRoutes/apiOpsRoutes/apiTaskRoutes 等 13 模块);apiRateLimit 审查:失败预算/冷却/recordSuccess 不洗白冷却(防代理共享地址攻击)/maxKeys 防内存/429+retry-after——**零必修缺陷**,已有直测 | — |
| 86 | 解决 | 同上 | 确认入档(apiRateLimit 接线:授权先行,错误 token 才计预算);api.ts 拆分全景确认,后续轮次按新模块结构轮转 | npm run check 703 全绿 |
| 83 | 提出 | 机动抽查——已修 bug 回归清单 | 5 项抽查点:①runNow 返回更新快照(scheduler);②备份排除 api-enc-key.json(ops,双断言);③escapeMarkdown 往返一致(messages);④redactToken 泄漏(setup);⑤markdown 注入转义(ccCommands) | — |
| 84 | 解决 | 同上 | 5 项回归测试全部在位且通过(npm test 703 全绿);近期修复零回归,确认入档 | npm run check 703 全绿 |
| 81 | 提出 | Kotlin PickerDialog + StatusScreen 尾段走查 | PickerDialog:LaunchedEffect 刷新、稳定 key、选中态对比、空模型提示、恢复默认;StatusScreen:最近备份行/每日报告卡/连接信息——**零必修缺陷**(确认轮) | — |
| 82 | 解决 | 同上 | 确认入档;PickerDialog/StatusScreen 审毕 | npm run check 703 全绿 |
| 79 | 提出 | parseReply 边界补充 + abortSession 复核 | 实测验证:连续指令(`…a.png]][[file:…b.pdf]]`)产生两个 media、路径逃逸目标(outbox/../..)由 resolveMedia 分层拦截(parse 只解析)、大写 KIND 归一、abortSession 全部调用方带 .catch——**零必修缺陷**(确认轮) | node 实测 |
| 80 | 解决 | 同上 | 确认入档:分层设计(parse 解析/resolve 安全)为有意架构;边界实测脚本留存于台账记录 | npm run check 703 全绿 |
| 77 | 提出 | x_search_free_servers.mjs 全文(144 行) | 走查:hostOf 域名过滤、pickExternal 锚文本还原真实外链、seen 去重、slug 清洗、登录检测、每查询 try/catch——**零必修缺陷**;微项:UA 尾段 Safari/124.0.0.0 为无效版本号(与 x_action 不一致) | — |
| 78 | 解决 | 同上 | UA 尾段修正为 Safari/537.36(与 x_action 一致);确认项入档(去重 key、t.co 锚文本还原、slug 文件名安全) | npm run lint 0 告警 |
| 75 | 提出 | lock.ts/logger.ts/binPath.ts(299 行) | 全文审:lock 的 link 原子锁/claim 回收竞态/PID 复用检测(/proc starttime)/同进程判断;logger 的 copytruncate 轮转/保留 7 份/分级 redactSecrets(string 参数);binPath 的 PATH 扩展(existsSync 重检)/scrubEnv(合并后剥离)/installerChildEnv——**零必修缺陷**;LB-2 保留:logger 对象参数不脱敏(Error 展开) | — |
| 76 | 解决 | 同上 | 确认轮:三文件无缺陷可修,LB-2 保留理由入档(调用方大多传字符串、对象多不含凭据);lock/logger/binPath 审毕 | npm run check 703 全绿 |
| 73 | 提出 | setup.ts(首次连接向导,341 行) | 全文审:TOKEN_RE 格式校验、maskToken、parseUserIds 数字白名单、apiCall 错误 redactToken(URL 含 token 脱敏)、writeEnvFile 原子写+0600 双 chmod、upsertEnv 重复键全重写(dotenv last-wins)、写入前重读防覆盖、waitForOwner 私聊过滤+超时、canRunSetup TTY+CI——**零必修缺陷**,11 个测试覆盖完备;缺口:redactToken 错误脱敏无端到端断言 | — |
| 74 | 解决 | 同上 | 补 redactToken 泄漏测试(getMe 网络错误 URL 含 token → 打印与结果全部掩码);setup.ts 审毕 | npm run check 703 全绿 |
| 71 | 提出 | Kotlin ListScreens + SettingsScreen 走查 | 审查:dueCountdown 渐进计算(秒/分/时/天)、rememberClock 30s 服务器时钟、Reminders 延后/删除、Settings 本地状态+扫码(zxing 需运行时 CAMERA 权限,注释正确)+encKey 输入框——**零必修缺陷**;前中段清单型组件,确认为主 | — |
| 72 | 解决 | 同上 | 确认轮:两屏无缺陷可修,确认项入档(dueCountdown 类型 Long 比较、cameraPermission 服务于扫码配对);ListScreens/SettingsScreen 审毕 | npm run check 702 全绿 |
| 69 | 提出 | messages.ts 全文(175 行,展示工具) | 审查:clip/clipTail 双向 surrogate 防御、pickCut、splitMessage 的 Markdown 感知拆分(fence 关闭重开/inline span 移动/重开预算/surrogate)、escapeMarkdown(legacy 集 `[_*`[]\\]` 正确)、pruneChatState 活跃保护——**零必修缺陷**,12 个既有测试覆盖;缺口:escapeMarkdown 无直测 | — |
| 70 | 解决 | 同上 | 补 escapeMarkdown 直测(特殊字符往返+字面反斜杠转双反斜杠);适配 lint 门禁(正则无谓转义×2,改 startsWith 断言);测试 701→702 | npm run check 702 全绿 + lint 0 告警 |
| 67 | 提出 | opencode.ts files 路径(附件→data URL) | 复审:files→data URL 构造已有直测;mime 上游受控(attachments 分类/apiTasks MIME_RE)、数量上游限 4、base64 编码正确——确认正确;1 个防御性低项:mime 直接拼 data URL 无空值兜底 | — |
| 68 | 解决 | 同上 | mime 加 octet-stream 兜底(防 data URL 被截断);已有 files 测试保持通过 | npm run check 701 全绿 |
| 61 | 提出 | ccCommands model 分支(#agentsText/#ccModelPanel) | 审查:4096 字符预算+push 函数、escapeMarkdown 全量转义、截断提示指回 npm run models、reloadCustomModels 热加载——**零必修缺陷**;缺口:agentsText 的 markdown 转义(agent 元数据注入面)未直测 | — |
| 62 | 解决 | 同上 | 补 markdown 注入测试(恶意 description 的 [链接]/*粗体* 被转义为 \[ 与 \*);确认项入档 | npm run check 701 全绿 |
| 13 | 提出 | ccswitch.ts(脱敏与 pty 确认) | 全文审:shellQuote 白名单+'\'' 转义(buildPtyCommand 唯一 shell 路径全 token 引号)、redactSecrets 五层正则、runPty 双流滚动 tail/优雅终止/BusyBox 探测、parseProviderList 表格解析——**零必修缺陷**;2 个测试缺口:xoxb 槽位与 private_key 键名变体未测 | — |
| 14 | 解决 | 同上 | 补 2 断言(xoxb-1234、private_key = MIIE… 均被掩码);C-3 保留理由入档(runWithConfirm 的 "y\n" 依赖 cc-switch 提示行为稳定,属上游契约) | npm run check 631 全绿 |
| 23 | 提出 | ccCommands.ts #handleCcModel 分支(add/del/assign) | 审查:参数解析边界(--ctx 越界、未知 - 参数)与 del force 确认流确认正确;**发现 Q1(真 bug,中)**:telegram 端 assign 的 applyOpenCodeModel 未防护——文件已写入但会话切换失败时用户收到 ❌(API 端同逻辑有 try,不一致) | — |
| 24 | 解决 | 同上 | 修复 Q1(applyOpenCodeModel 包 try,失败降级为「⚠️ 绑定已写入,请用 /model 手动切换」);新增回归测试(applyOpenCodeModel 抛错时成功消息仍送达+原始错误不独占反馈);调试顺带补 fixture(assistant.md);测试 638→639 | npm run check 639 全绿 |
| 37 | 提出 | attachments.ts(123 行,附件落盘/读取/清理)+ collectAttachments | 全文审:saveAttachment(0700 目录+0600 文件+同毫秒防覆盖+路径剥离)、readTextAttachment(**只读窗口** cap*4+4 不整读 20MB+surrogate 尾清理)、pruneInbox(.gitkeep 保留/逐条 try)、collectAttachments(photo 最大尺寸/分类/mime 兜底)——**零必修缺陷且测试完备**(14 测试);缺口:pruneInbox 符号链接不跟随语义未测 | — |
| 38 | 解决 | 同上 | 补符号链接安全测试(过期链接被删、inbox 外目标不受影响);顺带发现并适配并行会话新增的 lint/knip 门禁(修 2 处:import 语法、未用参数);测试 639→644 | npm run check 644 全绿 + lint/knip 0 告警 |
| 99 | 提出+解决 | CHANGELOG 终核 | 0.3.0 条目抽查通过(消息级加密/每日报告/snooze/备份/门禁全在册,2 处安全修复在册);与 ITERATIONS.md/DEEP-100.md 三方对齐 | npm run check 703 全绿 |
| 100 | 收笔 | 里程碑终笔 | **100/100 达成**:54 对提出-解决迭代 + 2 轮机动;提出约 120 项(含确认项)、修复真 bug 与安全问题 16 个;测试 386→703(+317);src/ 全文件审毕(含并行会话 13 个 api 拆分模块);0.3.0 发布就绪。台账全文见本文件 | npm run check 703 全绿 |
| 31 | 提出 | apiPersonal 路由域(dir/timezone/aliases/config/access/peers 委托层) | 走查:全部校验下沉在 store/service 层,路由薄——**零必修缺陷**;1 个 API 层测试缺口:alias 非法名字经 API 的 400 转换未直测(store 层校验已测) | — |
| 32 | 解决 | 同上 | 补 API 层断言(POST /aliases 非法名字 → 400 + 快捷指令名指引);确认项入档(dir 的 statSync/hasActiveTask、config 的 REMINDER_TIMEZONE 热路径、access 的 ids 过滤、peers 的 scope 校验) | npm run check 642 全绿 |
| 65 | 提出 | Kotlin ChatScreen 尾段(AssistantBubble 剩余/RunningLine/媒体气泡/复制) | 走查:重试按钮(failed/cancelled)、RunningLine 本地秒级计时、复制按钮 1.5s 自动复位、媒体分派(image→内嵌/其他→卡)、openMedia 全屏——质量高;1 个假设待验证:mediaImages 缓存疑无界增长(bitmap ~10MB/图) | — |
| 66 | 解决 | 同上 | 假设**证伪**:已有 MAX_MEDIA_IMAGES=8 的 LRU 截断(注释明确 ~10MB/图、滚回重新解码)——缓存有界;确认项入档(RunningLine 计时、复制状态自动复位) | npm run check 694 全绿 |
| 63 | 提出 | scripts/x_action.js + x_search_free_servers.mjs | 审查:会话 storageState、UA 显式、--no-sandbox、finally close——正确;**发现 Q1(与轮 58 同型,共 4 实例)**:CHROME_PATH 硬编码 chromium-1248(x_action/x_search 漏修);Q2 保留:postTweet 无发出断言(X DOM 检测脆弱,固有限制) | — |
| 64 | 解决 | 同上 | x_action.js 套用 detectChromePath 模式(env→探测→兜底,与邮件脚本一致);grep 全 scripts 确认无残留硬编码;Q2 保留理由入档 | node --check + 导入验证 |
| 59 | 提出 | apiPersonal.ts export 路由复审 | 确认:format 白名单(markdown/json)、key 仅回 app 自身、双格式附件响应正确——零必修缺陷;缺口:API 端点零直测(Telegram 端 /export 有测,App 端无) | — |
| 60 | 解决 | 同上 | 补端点直测(json 响应头/entries/key 非敏感、markdown 标题与任务文本、xml 格式 400),测试 697→700 | npm run check 700 全绿 |
| 57 | 提出 | scripts/send_mail.js + check_inbox.js(邮件脚本) | 审查:会话文件经 storageState 持久化(/data/ 已忽略 ✓)、浏览器路径**硬编码版本号**(chromium-1248)——Playwright 升级即失效(S-2,低-中);无其他凭据泄漏 | — |
| 58 | 解决 | 同上 | 两脚本统一抽 detectChromePath():CHROME_PATH 环境变量 → 缓存目录探测最新 chromium-* → 历史路径兜底;node --check + 导入验证 | node --check + 导入验证 |
| 55 | 提出 | api.ts session 路由域(GET session/POST new/model/agent) | 走查:sessionView(engine/model/hasSession/workDir 仅 CLI)、POST /new requireIdle、POST /agent resolveEngine 特判 opencode、POST /model 提前解析——**零必修缺陷**,既有测试覆盖 switch/reset;缺口:任务活跃时 /new 与 /model 的 409 拒绝未断言 | — |
| 56 | 解决 | 同上 | 补 409 回归测试(挂起任务期间 POST /new 与 /model 均 409 + 任务执行中文案);sessionView 确认项入档(key 仅回 app 自身、CLI 分支 workDir 仅 CLI 引擎下发) | npm run check 697 全绿 |
| 53 | 提出 | Kotlin OpsScreen/CcScreen 走查 | OpsScreen(LogCard 分源/行数切换/SelectionContainer/状态分派、InfoRow、formatBytes)标准实现;CcScreen 发现 **Q1(低-中,真 bug)**:cc-switch 可用但 views/commands 为合法空列表时,/cc run 请求因 isEmpty 误当“未加载”而悬挂无反馈 | — |
| 54 | 解决 | 同上 | 修复 Q1(改用 ccStatus==null 判定加载完成,reloadCcTables 恒置 ccStatus);OpsScreen 确认项入档;CcScreen 确认流(ccRunRequested 重放 key 设计/确认对话框/导入链接)确认正确 | npm run check 694 全绿 |
| 29 | 提出 | Kotlin AppViewModel 第二段(发送/轮询/重试/停止) | 全文审:pollTask 去重+SSE 优先+分级退避(401/5xx/429/code0 有界/IOException)、send 失败回填草稿+one-off 保留、404 服务器重启语义、通知门控——**零必修缺陷**;1 个竞态待验证:busy 门在 launch 内置位,快速连发可双过 | — |
| 30 | 解决 | 同上 | 修复竞态(busy 置位提前到 launch 外,finally 重置不变);走查确认项入档(pollTask 分级退避矩阵、404 语义、retryFromBanner 限真实失败) | npm run check 639 全绿 |
| 27 | 提出 | Kotlin AppViewModel(连接生命周期与状态调度) | 走查:guarded(取消语义正确)/conn 动态 encKey/恢复轮询/附件上限——质量高;**发现 Q1(低-中)**:未配置连接时每次导航仍触发一次注定失败的 refreshSession(错误横幅反复闪现+无谓请求) | — |
| 28 | 解决 | 同上 | 修复 Q1(refreshSession 加 configured 门;设置页保存后由 saveConnection 触发);guarded 取消语义/conn 动态密钥/恢复轮询等确认项入档 | npm run check 639 全绿 |
| 25 | 提出 | apiTasks.ts(任务提交域,555 行) | 审查:附件校验链/队列 409/model 提前解析/队列链/SSE 节流/prune/view 剥离 key 确认正确;**发现 Q1(中-高,内存)**:submit 把原始 base64 附件存进 task 对象直到 200 条 prune(可达数 GB 驻留);2 项确认(取消判定正则可接受、cleared 任务由 runTask 首行守卫跳过) | — |
| 26 | 解决 | 同上 | 修复 Q1:附件提交即落盘 inbox,task 只存 SavedAttachment 摘要(base64 不驻留);runTask 改用已存摘要;落盘失败并入提示词;retry 从 inbox 重读转 base64;端到端附件测试确认行为不变,测试 639→639(重编号无净增) | npm run check 639 全绿 |
| 21 | 提出 | 测试缺口专项(承轮 2/20) | 2 个已知缺口定稿:①ccCommands speedtest 单飞零直测(轮 20 撤下);②轮 2 实现的 nearestMenuCommand 邻近提示零测试 | — |
| 22 | 解决 | 同上 | 双双补齐:①ccCommands.test.ts 经面板按钮 test:1×2 验证单飞与结果送达(调试中揪出 fixture 表格缺 ID header 行——parseProviderList 依赖 header 定位,无 header 只走 Current 兜底);②telegram.test.ts 集成测试(/sttus 提示+正确命令无提示),测试 637→638 | npm run check 638 全绿 |
| 51 | 提出 | Kotlin ChatScreen 第一中段(输入/录音/相机/命令面板/气泡,1-660 行) | 走查:录音全生命周期(120s 上限+权限+离开释放+短录音清理)、相机权限注释坑、命令三层优先(builtin>server>alias)、气泡长按复制/附件图标/时间戳——**零必修缺陷**;微项:命令列表每次重组重建(21 对象,记录保留) | — |
| 52 | 解决 | 同上 | 走查结论入档(AssistantBubble 重试/媒体/openMedia 链路同段确认);纯 UI 文件本环境无法编译验证,守卫依赖 check-android-sources 门禁 | npm run check 643→694 全绿(并行会话同轮加测试) |
| 45 | 提出 | 部署脚本(install-cc-switch.sh 84 行 + restart.sh 88 行) | 审查:install(set -Eeuo pipefail/tmp+trap/curl --fail/.new+mv 原子替换/PATH 提示)与 restart(陈旧 PID 防御 cmdline 验证/lock 回退/TERM→KILL 优雅/日志轮转/启动失败诊断)——**零必修缺陷**;1 个低项:wget 无 --fail(与 curl 不对称,404 错误页会落盘临时目录) | — |
| 46 | 解决 | 同上 | wget 加 --fail(与 curl --fail 对称);IS-3 保留理由入档(上游无 checksums 发布,校验和留待上游);两脚本 bash -n 语法验证 | bash -n + 人工核对 |
| 23 | 提出 | media.ts parseReply 边界 + opencode files 路径 | 补充审查:空目标 dropped、ReDoS 杂散前缀(10 万字符 <250ms)、上限 5、超长目标、fence/inline code 叠加、flushText 合并、opencode files 的 mime 上游受控——**零必修缺陷且覆盖完备**;微缺口:大写 KIND 无断言 | — |
| 24 | 解决 | 同上 | 补大写 KIND 断言(IMAGE/Video 归一化为 image/video);确认项入档(flushText 丢空行为、files mime 受控) | npm run check 694 全绿 |
| 15 | 提出 | ccCommands.ts(1142 行,cc 面板交互) | 全文审:**零专属测试文件**(确认令牌生命周期/chatId 绑定/一次性消费/单飞测速/分发逻辑全零直测);代码本身质量高(shellQuote 已在 ccswitch 层、确认 TTL+chatId 绑定+一次性、redact 全覆盖、surrogate clip) | — |
| 16 | 解决 | 同上 | 新建 tests/ccCommands.test.ts 3 组测试:①use→确认→切换生效;②令牌 chatId 绑定/一次性/过期与未知 token;③(单飞测速因 fake runner 形状调试成本高,留待后续)。调试学到:CcSwitchService 构造字段是 runner(非 runnerOverride),handleCommand 的 use 直走 requestCcConfirm 不经面板缓存 | npm run check 636 全绿 |
| 15 | 提出 | agentInstaller.ts(Telegram 触发的 npm/pip 安装) | 全文审:PACKAGE_RE 严格包名、EXTRA_ARG_RE 白名单(持久化记录同滤)、installerChildEnv 剥离凭据(npm lifecycle 风险)、#busy 单飞、detached+terminateProcess、stdio destroy 释放管道、损坏记录隔离——**零必修缺陷**;1 个测试缺口:sanitizeExtraArgs 对手改清单注入的过滤未测 | — |
| 16 | 解决 | 同上 | 补注入过滤测试(手改清单塞 --evil/--prefix=相对路径 → 白名单只留绝对 --prefix,update argv 无注入);I-2/I-9 确认保留(pip 记录不会有 --prefix,uninstall 的 pipFlags 过滤正确) | npm run check 633 全绿 |

## 轮次详情(续)

### 轮 1(提出)——telegram.ts 命令分发与白名单中间件区(约 600-745 行)

- **Q1(中严重度,待解决)**:用户拼错的菜单命令(如 `/sttus`、`/helpp`)会**静默地**当作普通提示词发给 AI——用户不知道命令没生效。alias 展开依赖这条兜底路径,所以不能拦截,但应当提示。
- Q2(确认保留):`/agents` 分发处手工构造 Job 形状对象——下游 `#handleAgentInstallCommand` 确实使用 chatId/userId/generation 字段,非冗余。
- Q3(确认保留):未匹配命令 fallback 进任务队列——用户自定义快捷指令(`/名称`,经 `expandAlias` 在队列内展开)依赖此路径,不能改为"未知命令报错"。
- Q4(确认保留):同步 await(读型面板)与 offLoop(子进程类:proxy add/logs/diag/ops/export/report)的分配正确——读写文件或 spawn 的都离线了。

### 轮 2(解决)——落实轮 1 清单

- **Q1 已实现**:`nearestMenuCommand`(Levenshtein ≤1,长度 ≥3,排除自身)——fallback 入队前,若命令形状(无参数)且邻近某菜单命令,先发一条「💡 未找到命令 `/xxx`。你是想输入 `/yyy` 吗?这条消息仍会发给 AI 处理」提示,然后照旧入队。不拦截(保 alias)、不影响带参数消息、短命令(<3 字符)不提示。
- Q2/Q3/Q4 保留,理由如上(设计意图,非缺陷)。

### 轮 3(提出)——持久层 store/usage/history/jsonStore

- **Q1(中)**:`TaskHistoryStore.#load` 不排序——手工编辑或旧版本文件乱序时,`/history` 面板与 `/export` 的 newest-first 语义被破坏。
- **Q2(低)**:`SessionStore` 的空壳记录(`/new`、恢复默认模型/目录后只剩 updatedAt 的记录)在磁盘上无限累积,无清理路径。
- Q3(极低,保留):`formatStamp` 无效时区静默回退 UTC,无日志——难排查但影响极小。
- Q4-Q5(确认正确):null-prototype 防御(`__proto__`/`constructor` 键)、tmp+rename 原子写 + 0600、损坏文件 `.corrupt-<ts>` 留档、prune 节流(每小时最多一次)。

### 轮 4(解决)——落实轮 3 清单

- **Q1 已修复**:`#load` 按 `at` 降序排序后入库。
- **Q2 已修复**:`#load` 丢弃空壳记录(sessionID/engine/model/dir/cliSessions/cliModels 全空);engine-only 等有状态记录保留,新增测试锁定该语义。
- Q3 保留(影响极小)。

### 轮 5(提出)——reminders/scheduler

- **Q1(中-高,真 bug)**:`ScheduleService.runNow` 在 `updateById({runningAt})` 之后返回的是 **find() 时的旧拷贝**——API 的 `POST /schedules/:id/run` 响应与 App 展示拿到的是执行前状态(lastRunAt 缺失、lastStatus 陈旧)。
- Q2(确认):`#runManual` 的 finally 统一写 `runningAt: undefined + lastRunAt + lastStatus`,executor 抛错也走该路径,生命周期正确。
- Q3(确认):`zonedParts` 的 `hour % 24` 防 en-US hour12:false 的 "24:xx" Intl 坑。
- Q4(确认):`zonedToUtc` 两次偏移迭代正确处理 DST。
- Q5(确认保留):`sanitizeRepeat` 允许 10s interval——用户自选频率,`MAX_PER_CHAT=20` 已限流。

### 轮 6(解决)——落实轮 5 清单

- **Q1 已修复**:`runNow` 返回 `this.#store.find(chatId, id)`(更新后快照)。
- 新增测试:运行中返回快照带 `runningAt`;executor resolve 后 `runningAt` 清空、`lastStatus:"ok"`、`lastRunAt` 写入。
- Q2-Q5 保留理由如上。

### 轮 7(提出)——opencode.ts(SSE 客户端与 prompt 注入)

- 全文逐段审查:重连指数退避(30s 上限)、1MB 事件/缓冲上限、captive-portal 的 delivered 标志、abortSession 服务端止损(idle/硬超时/外部取消/网络错误四路都调)、settled 静默迟到 SSE、readBody 32MB 响应上限、capability 缓存失败保旧——**实现质量高,零必修缺陷**。
- 3 个测试缺口:超大事件的重连路径、health 非 200 分支、硬超时与 idle 钳制关系。

### 轮 8(解决)——补齐测试缺口

- 新增 3 测试:①超限事件 → 客户端断开缓冲并按 1s 退避重连,重连后的健康连接事件正常送达(按真实语义验证,而非想当然的"行内丢弃");②health 对 401 响应即使 body 声称 healthy:true 也返回 false(未读 body 被主动丢弃);③确认 maxTimeoutMs 被 `Math.max(idle)` 钳制为设计使然——硬超时单独触发需要 SSE 持续喂活动,构造不成比例,以注释替代测试。

### 轮 9(提出)——media.ts / proxy.ts

- 全文审查:SSRF 防御矩阵(IPv4 私有段全列、IPv6 含 NAT64 64:ff9b、6to4 2002、Teredo 2001:0、ULA/链路本地/组播)、DNS 钉死(pinnedLookup 拒绝非校验主机+family 过滤)、符号链接双重 realpath 逃逸防御、SOCKS4/5 手写握手(单次回调保证)、TLS servername 传递、代理 add 的双重复查、env 文件原子写+引号转义——**零必修缺陷**。
- 测试覆盖 23+9 已含 SSRF 矩阵与 env 生命周期;唯一缺口:hash 拒绝分支。

### 轮 10(解决)——落实轮 9

- 补 `parseProxyUrl("http://…#frag")` 拒绝断言(一行)。
- media/proxy 零缺陷结论与覆盖清单入档:这两个文件与 opencode.ts 同为高质量区。

### 轮 11(提出)——agentCli.ts(进程管理与 argv 防御)

- 全文审查:进程组信号(detached 下 `kill(-pid)`)+ 优雅升级 SIGKILL(5s 后)+ stdioDrained 防 pid 复用误杀、argv 注入防御(MODEL_ARG_RE/SESSION_ARG_RE 拒绝 `-` 开头)、O(n) 输出截断(2×cap 一次回切)、resume 重试限一次、scrubEnv 剥离访问控制变量发生在 profile.env 合并之后——质量高。
- 1 个假设待验证:用户可控的 `resumeErrorPattern`(data/agents.json)若为非法正则,`new RegExp` 在 close 回调抛错是否杀死进程。

### 轮 12(解决)——假设证伪,守卫固化

- 证伪过程:测试先按"崩溃"假设写(红)→ 根因是 registry **加载期**已校验正则并 throw → per-profile try/catch 把坏 profile 隔离掉 → prompt 得到"未知的 Agent 引擎"而非崩溃。
- 产出:该隐式双层防御固化为显式测试(profile 拒绝 + 同文件好 profile 仍加载 + 进程存活三断言)。

### 轮 11(提出)——agentCli.ts(进程管理与 argv 防御)

- 全文审查:进程组信号(detached 下 `kill(-pid)`)+ 优雅升级 SIGKILL(5s)+ stdioDrained 防 pid 复用误杀、argv 注入防御(MODEL_ARG_RE/SESSION_ARG_RE 拒绝 `-` 开头)、O(n) 输出截断(2×cap 一次回切)、resume 重试限一次、scrubEnv 在 profile.env 合并后才剥离访问控制变量——质量高。
- 1 个假设待验证:用户可控的 `resumeErrorPattern`(data/agents.json)若为非法正则,`new RegExp` 在 close 回调抛错是否杀死进程。

### 轮 12(解决)——假设证伪,守卫固化

- 证伪过程:测试先按"崩溃"假设写(红)→ 根因是 registry **加载期**已校验正则并 throw → per-profile try/catch 把坏 profile 隔离 → prompt 得到"未知的 Agent 引擎"而非崩溃。
- 产出:该隐式双层防御固化为显式测试(profile 拒绝 + 同文件好 profile 仍加载 + 进程存活三断言)。

### 轮 13(提出)——ccswitch.ts(脱敏与 pty 确认)

- 全文审查:`shellQuote`(安全字符白名单 + `'\''` 转义)使 `buildPtyCommand` 这条唯一 shell 路径无注入面;`redactSecrets` 五层正则(JSON 键值/键:值引号对/sk- 与 ghp_ 与 xox 前缀/Bearer/URL 凭据);`#runPty` 双流滚动 tail、SIGTERM→SIGKILL 升级、BusyBox script 探测、EPIPE 守卫;`parseProviderList`/`parseSpeedtest` 表格解析。
- **零必修缺陷**;测试缺口:xoxb 槽位与 private_key 键名变体。

### 轮 14(解决)——落实轮 13

- 补 2 断言:`xoxb-1234-…` 与 `private_key = MIIE…` 均被掩码(确认正则的 `[baprs]` 槽位与 `private[\s_-]?key` 变体真实生效)。
- C-3 保留:`runWithConfirm` 无条件写 `"y\n"` 依赖 cc-switch 提示行为稳定,属上游契约,变更会在集成时暴露。

### 轮 13(提出)——ccswitch.ts(脱敏与 pty 确认)

- 全文审查:`shellQuote`(安全字符白名单 + `'\''` 转义)使 `buildPtyCommand` 这条唯一 shell 路径无注入面;`redactSecrets` 五层正则(JSON 键值/键:值引号对/sk- 与 ghp_ 与 xox 前缀/Bearer/URL 凭据);`#runPty` 双流滚动 tail、SIGTERM→SIGKILL 升级、BusyBox script 探测、EPIPE 守卫;`parseProviderList`/`parseSpeedtest` 表格解析。
- **零必修缺陷**;测试缺口:xoxb 槽位与 private_key 键名变体。

### 轮 14(解决)——落实轮 13

- 补 2 断言:`xoxb-1234-…` 与 `private_key = MIIE…` 均被掩码(确认正则的 `[baprs]` 槽位与 `private[\s_-]?key` 变体真实生效)。
- C-3 保留:`runWithConfirm` 无条件写 `"y\n"` 依赖 cc-switch 提示行为稳定,属上游契约,变更会在集成时暴露。

### 轮 15(提出)——modelAdmin.ts(自定义模型与 opencode.json 同步)

- 全文审查:损坏注册表拒绝写入(防丢模型)、writeJson/writeTextAtomic 保留原权限 + bot 与 CLI 不共享 tmp 名、四组输入正则、`#agentFile` 防路径逃逸、add 五重冲突检查、assignAgent 函数替换保 `$` 字面量、remove 的引用清理与 stale 报告——**零必修缺陷**。
- 2 个低项保留:①add 对 opencode.json 与注册表双写无跨文件事务(失败面极窄,重试可恢复);②provider.models 被手写成数组时,add 以空表修复性覆盖。
- 2 个测试缺口:assignAgent 到无 frontmatter 文件、坏数组的修复语义。

### 轮 16(解决)——落实轮 15

- 补 2 测试:①无 frontmatter 的 agent 文件 assign 时报错且文件原样保留;②坏数组被空表替换、`repaired-model` 键落位。
- 调试插曲:断言键名锆写(`models.repaired` vs 实际 `models["repaired-model"]`)造成假红——独立复现脚本确认实现正确后,才定位到断言笔误。

### 轮 17(提出)——agentInstaller.ts(Telegram 触发的 npm/pip 安装)

- 全文审查(安全敏感):`PACKAGE_RE` 严格包名(拒绝 `; rm -rf` 注入)、`EXTRA_ARG_RE` 白名单只允许绝对路径 `--prefix` 与 `--break-system-packages` 且**持久化记录加载时同滤**、`installerChildEnv` 剥离所有形似密钥的变量(npm lifecycle 脚本风险)、update/uninstall 仅限 Bot 自装记录、`#busy` 单飞、detached+terminateProcess 进程组终止、stdio destroy 显式释放、损坏记录隔离留档。
- **零必修缺陷**;1 个测试缺口:`sanitizeExtraArgs` 对手改清单注入的过滤未测。

### 轮 18(解决)——落实轮 17

- 补注入过滤测试:手改清单塞 `--evil` / `--prefix=relative/path` / 合法 `--prefix=/home/u/.npm-global` → 加载后白名单只留绝对 prefix,update 的 argv 无注入值。
- I-2/I-9 确认保留:pip 记录不可能携带 `--prefix`(不同 method 的 record);uninstall 的 pipFlags 过滤有既有测试覆盖。

### 轮 17(提出)——agentInstaller.ts(Telegram 触发的 npm/pip 安装)

- 全文审查(安全敏感):`PACKAGE_RE` 严格包名(拒绝 `; rm -rf` 注入)、`EXTRA_ARG_RE` 白名单只允许绝对路径 `--prefix` 与 `--break-system-packages` 且**持久化记录加载时同滤**、`installerChildEnv` 剥离所有形似密钥的变量(npm lifecycle 脚本风险)、update/uninstall 仅限 Bot 自装记录、`#busy` 单飞、detached+terminateProcess 进程组终止、stdio destroy 显式释放、损坏记录隔离留档。
- **零必修缺陷**;1 个测试缺口:`sanitizeExtraArgs` 对手改清单注入的过滤未测。

### 轮 18(解决)——落实轮 17

- 补注入过滤测试:手改清单塞 `--evil` / `--prefix=relative/path` / 合法 `--prefix=/home/u/.npm-global` → 加载后白名单只留绝对 prefix,update 的 argv 无注入值。
- I-2/I-9 确认保留:pip 记录不可能携带 `--prefix`(不同 method 的 record);uninstall 的 pipFlags 过滤有既有测试覆盖。

### 轮 17(提出)——ccCommands.ts(cc 面板交互,1142 行)

- 全文审查:确认令牌生命周期(TTL 5min/chatId 绑定/一次性消费/过期清扫)、#ccTesting 单飞测速(finally 清理)、#executeCc 的 preview redact+escape+clip、deeplink 协议白名单+8192 上限、surrogate-safe clip——**代码质量高,零必修缺陷**。
- **重大测试缺口**:该文件零专属测试,确认流是唯一能覆盖"危险操作二次确认"完整语义的地方。

### 轮 18(解决)——补确认流直测

- 新建 tests/ccCommands.test.ts:fake CcHost(记录 text+keyboard)+ fake runner(CcSwitchService 的 `runner` 字段)。
- 3 组测试:①use→确认→Provider 切换生效;②令牌 chatId 绑定(他聊拒)、一次性(再按失效)、未知 token 优雅应答;③speedtest 单飞(因 fake runner 的 args 形状与 speedtestText 断言调试成本高,本轮撤下留待后续)。
- 调试要点:CcSwitchService 构造的字段名是 `runner`(不是 runnerOverride);handleCommand 的 use 直走 requestCcConfirm,不依赖面板缓存;fake host 必须记录 keyboard 否则令牌无从提取。

### 轮 21(提出)——测试缺口专项

- 承接轮 2 与轮 20 的两个撤下项:speedtest 单飞、nearestMenuCommand 邻近提示——均为已实现但零测试的行为。

### 轮 22(解决)——双双补齐

- **speedtest 单飞**:经面板按钮 `test:1` 两次调用,断言「正在测速→正在测速中→结果送达→可再次发起」完整时序。
- **邻近提示**:telegram.test.ts 集成测试——`/sttus` 触发「你是想输入 /status」提示且 fallback 任务照常执行,正确命令 `/status` 无提示。
- **审查副产物**:`parseProviderList` 依赖表格 **ID/Name header 行**定位列;无 header 时只走 `Current:` 兜底返回单条——fixture 必须按真实 cc-switch 输出结构构造。

### 轮 23(提出)——ccCommands.ts #handleCcModel(add/del/assign)

- 参数解析边界确认:`--ctx`/`--output` 独立值越界时优雅报错;未知 `-` 参数抛「未知参数」;del 走确认流(force 经 appendArgs 合并)。
- **Q1(中,真 bug)**:`assign` 分支在 `assignAgent` 成功后调用 `applyOpenCodeModel` **无 try**——该调用失败(如 OpenCode 重置会话异常)时用户收到 ❌,但 frontmatter 文件**其实已写入**;API 端同逻辑(api.ts:860)有 try 且注释明确"failure must not undo the file write",两端不一致。

### 轮 24(解决)——落实轮 23

- **Q1 已修复**:包 try 降级为「⚠️ Agent 绑定已写入,但当前会话切换模型失败——请用 /model 手动切换」,与 API 端语义对齐。
- 新增回归测试:applyOpenCodeModel 抛错场景下成功消息仍送达、⚠️ 提示出现、原始错误不独占反馈。fixture 顺带补 assistant.md(assign 需要)。

### 轮 25(提出)——apiTasks.ts(任务提交域,并行会话新拆出模块)

- 全文审查:附件校验链(数量/name/mime/base64/总量)、MAX_API_QUEUE 409、modelOverride 提交期解析(400 而非延迟失败)、队列链 previous.then(run,run)、SSE 250ms 节流+终态即清+心跳、prune 保留活跃任务、view 剥离 key/controller/attachments——**架构与安全确认正确**。
- **Q1(中-高,内存)**:`submit` 把原始 base64 附件存进 task 对象——每条任务持有最多 15MB base64 直到 200 条记录被清理,最坏数 GB 驻留。
- Q2(确认):取消判定用正则匹配错误消息(错误来自引擎封装层非用户内容)可接受;clearQueue 的 cancelled 任务由 runTask 首行守卫跳过。

### 轮 26(解决)——落实轮 25

- **Q1 已修复**:附件提交时即落盘 inbox(`#saveAttachments` 前移),task 只存 `savedAttachments` 摘要(SavedAttachment[],base64 不驻留);runTask 改用摘要构建 prompt;落盘失败在提交期并入提示词;`/task/:id/retry` 从 inbox 重读转回 base64(文件被清理时跳过该附件)。
- 端到端附件测试(accepts base64 attachments end to end)确认行为不变。

### 轮 27(提出)——Kotlin AppViewModel(连接生命周期与状态调度,第一段)

- 走查确认:`guarded` 的 CancellationException 重抛(取消非失败)、`conn()` 每次从 settings 重建(encKey 动态生效)、进程被杀后恢复任务轮询、附件数量/总大小上限、draft 写入节流——质量高。
- **Q1(低-中)**:`navigate()` 尾部 `if (session == null) refreshSession()`——未配置连接时每次导航都发一次注定失败的请求,错误横幅反复闪现。

### 轮 28(解决)——落实轮 27

- **Q1 已修复**:`refreshSession` 加 `configured` 门;真正的触发点在设置页 `saveConnection`(保存即测连)。
- 确认项入档:guarded 取消语义、conn 动态密钥、恢复轮询、附件上限。

### 轮 29(提出)——Kotlin AppViewModel 第二段(消息发送/任务轮询)

- 全文审查:pollTask 的 polls 去重 + SSE 优先 + 轮询兜底、分级退避矩阵(401 等重新配对/5xx·408·429 退避/code0 有界重试/IOException 无限退避——服务端任务有 10 分钟硬上限所以无限退避是对的)、404 = 服务器重启语义(bubble 转 cancelled 而非发明失败)、send 失败回填草稿 + one-off pins 保留、retryFromBanner 只在真实任务失败时触发——**零必修缺陷**。
- 1 个竞态待验证:busy 门在 `launch` 内置位,检查在协程外——快速连发可双双通过。

### 轮 30(解决)——落实轮 29

- **竞态已修复**:busy 置位提前到 `launch` 之前(检查后立即),finally 重置不变。
- 走查确认项入档。

### 轮 31(提出)——apiPersonal 路由域(dir/timezone/aliases/config/access/peers)

- 走查确认:校验全部下沉在 store/service 层,路由是薄委托;`routeDir` 的 statSync 目录校验与 hasActiveTask 409、`routeConfig` 的 REMINDER_TIMEZONE 热路径、`routeAccess` 的 ids 过滤、`routePeers` 的 scope 校验均正确。
- 1 个 API 层测试缺口:alias 非法名字(store 层 `isValidAliasName` 校验)经 API 的 400 转换未直测。

### 轮 32(解决)——落实轮 31

- 补 API 层断言:POST /aliases 非法名字 → 400 + 快捷指令名指引;确认项入档。

### 轮 33(提出)——ccCommands 剩余分支

- 审查:`#handleCcGroup`(deeplink/update --check 与 pty 确认/mcp add/prompts new/provider add + apiKey 聊天警告)、`#runCcGeneric`(--app 拒绝/deeplink)、`#dispatchCc` **三层防御**(ccAppFlagToken 全拼写拒绝 → ccBlockedReason 禁跑清单 → ccConfirmPlan 危险确认)——**零必修缺陷**。
- `importMcp` 走 `runBare(["deeplink", buildMcpDeeplink(...)])`:JSON 经 base64url 编码进 deeplink,argv 直传无 shell——零注入面。掩码已有直测;缺口:mcp add 编码未直测。

### 轮 34(解决)——落实轮 33

- 补 deeplink 编码测试:`mcp add` 的 JSON 经 base64url 往返一致、`apps=opencode` 键断言。
- 确认项入档。

### 轮 35(提出)——ccswitch.ts 前段

- 审查:`parseMcpConfig` 双模式(mcpServers 包裹/裸映射)、`assertPlainText`(控制字符)/`assertProviderUrl`(http(s)、@ 凭据拒绝、长度)/`assertSafeId`(`-` 开头/路径片段)、`resolveCcSwitchBin` 三形态(裸名 PATH/绝对/相对 projectDir)、`defaultRunner`(maxBuffer 8MB + 自有 deadline + SIGKILL 升级 + MAXBUFFER 错误识别)、`errorDetail` redact+1200 clip——**零必修缺陷**。
- 缺口:`assertProviderUrl` 的 @ 拒绝与 500 字上限未直测。

### 轮 36(解决)——落实轮 35

- 补 2 断言:带凭据 URL(`https://user:pass@x.test`)拒绝、过长 URL 拒绝。
- `toDeeplinkApp` 已有覆盖(别名映射含 `toString` 原型防御断言)。确认项入档。

### 轮 37(提出)——attachments.ts + collectAttachments

- 全文审查:`saveAttachment`(0700 目录 + 0600 文件——配置文件带 API key 的隐私、同毫秒防覆盖、`sanitizeFilename` 路径剥离与隐藏文件防御)、`readTextAttachment`(**只读窗口** cap*4+4,不整读 20MB;surrogate 尾占位符清理)、`pruneInbox`(.gitkeep 保留、逐条 try、链接 unlink 语义)、`#collectAttachments`(photo 最大尺寸、document/voice/audio 分类、mime 兜底扩展名)——**零必修缺陷且测试完备**。
- 缺口:pruneInbox 符号链接「删链接不跟随」的安全语义未测。

### 轮 38(解决)——落实轮 37

- 补符号链接安全测试:过期链接被删、inbox 外的目标文件不受影响。
- 顺带发现并行会话在 check 里新增了 **oxlint 与 knip 门禁**——适配两处(import 语法、未用参数),检查面又扩了一层。

### 轮 39(提出)——scripts/ 目录(12 个脚本,1604 行)

- 全扫:send_mail/check_inbox/x_action(Playwright 会话文件模式,凭据不经命令行)、sniper_free_vps(SNIPER_* 环境变量 + Bearer token)、check_free_site/x_search(公开抓取无凭据)、install-cc-switch/restart/check-android-sources、proxy-exec(set -euo pipefail + 生成文件引号转义 ✓)。
- 无命令注入(execFile/$$eval 均为固定字面量)、无 console 凭据泄漏。
- **S-1(中-高,安全)**:`sniper_free_vps.mjs` 登录失败时 `JSON.stringify(data)` 把**整个响应体**写进持久日志(LOG_FILE)——部分 API 会回显提交的 email/password,凭据泄漏进日志文件。

### 轮 40(解决)——落实轮 39

- **S-1 已修复**:登录失败日志对 email/password 字段脱敏后再落盘(`node --check` 语法验证)。
- 其余确认项入档。

### 轮 41(提出)——远程媒体下载链路(#fetchRemoteMedia)

- 全文审查:逐跳 `assertUrlAllowed`(redirect: manual 手动跟随、hop≤3)、pinnedLookup DNS 钉死(**代理时交由代理网络解析**——注释明确该设计决定)、双重大小限制(declared content-length + 流式累计)、body.cancel 释放连接、pinned.close() 每跳 finally——**零必修缺陷**(SSRF 防御教科书级)。
- 缺口:重定向链与私网逐跳拒绝零直测。

### 轮 42(解决)——落实轮 41

- 补集成测试:本地 http server 模拟 302 链(4 跳)——默认配置(禁私网)下**每一跳都被 assertUrlAllowed 拒绝**;HarnessOptions 新增 `mediaAllowPrivateUrls` 开关供未来正向场景测试。

### 轮 23(提出)——media.ts parseReply 边界 + opencode files 路径

- 补充审查:空目标 `[[image:]]` dropped、ReDoS 杂散前缀(10 万字符扫描 <250ms,懒匹配防御)、上限 5、超长目标按纯文本、fence/inline code 叠加、flushText 相邻合并、opencode prompt files 的 mime 由附件分类受控(且过 MIME_RE)——**零必修缺陷且覆盖完备**(299-360 行的边界测试齐备)。
- 微缺口:大写 KIND(`[[IMAGE:…]]`)无断言。

### 轮 24(解决)——落实轮 23

- 补大写 KIND 断言(IMAGE/Video 归一化)。
- 确认项入档:flushText 合并丢空行为(展示层面)、files mime 上游受控。

### 轮 45(提出)——部署脚本(install-cc-switch.sh + restart.sh)

- **install-cc-switch.sh**:set -Eeuo pipefail、TMP_DIR+trap 清理、curl `--fail`(404 不落盘)、.new+chmod+mv 原子替换、版本参数 v 前缀规范化、PATH 提示——正确。
- **restart.sh**:陈旧 PID 防御(cmdline 必须含 dist/index.js)、lock 回退、TERM→50×0.2s→KILL、日志轮转 10MB(rotated 文件由 Bot 进程 prune 保留 7 份)、启动失败 tail 诊断+清 PID——正确。
- 低项:wget 分支无 `--fail`(与 curl 不对称)。
- 低项(保留):install 无下载校验和——上游 release 未发布 checksums,留待上游。

### 轮 46(解决)——落实轮 45

- wget 加 `--fail`(404 时立即失败,不落错误页);两脚本 `bash -n` 语法验证。

### 轮 47(提出)——Kotlin ApiClient.kt(App 网络层)

- 全文审查:submitTask(逐字段 JSON 构造/task 字段守卫)、task 双重空守卫、streamTask(**settled JSON 快照回退**——api.ts 对已结束任务返回普通 JSON 而非流,客户端正确处理该分支)、execute 的加密集成(轮 22)——质量高。
- **Q1(中)**:SSE `readUtf8Line` 阻塞读不响应协程取消——离开页面时线程最长滞留一个心跳周期(15s)。

### 轮 48(解决)——落实轮 47

- **Q1 已修复**:读循环内加 `ensureActive()`——每行之间检查协程存活,取消时 `use{}` 立即关闭响应。
- 确认项入档:stopTasks 返回 stopped ids、加密按 x-enc 头对称处理。

### 轮 49(提出)——Kotlin LocalStore/MediaFiles/TaskNotifier

- 审查:`read` 的 querySize 预检 + readCapped 流式截断(防 OOM)+ 空文件拒绝(防失败附件滞留)、`saveMessages` 的 2MB 历史预算与最新行必保、`loadMessages` 逐行容错(单条坏不空历史)、`MediaCache` 键清洗 + `decodeMediaFile` 降采样、TaskNotifier(轮 43 已确认)——**零必修缺陷**,注释水准极高。
- 1 项语义确认:MediaCache 位于 cacheDir,由 Android 在存储压力下回收,无需显式 trim。

### 轮 50(解决)——落实轮 49

- MediaCache 文档固化 cacheDir 语义(解释无需 trim 的原因)。
- Kotlin data 层三小文件审毕;Kotlin 侧已审:ApiClient、AppViewModel 两段、TaskNotifier、LocalStore、MediaFiles。

### 轮 51(提出)——Kotlin ChatScreen 前中段(输入/录音/相机/命令面板/气泡)

- 走查:录音全生命周期(120s 上限+LaunchedEffect 计时+权限+DisposableEffect 离开释放+短录音清理+失败释放半构建 recorder)、相机权限坑(声明 CAMERA 后系统不借相机,需显式检查)、命令面板三层优先(builtin>server>alias,builtin 命中名冲突不遮蔽)、气泡长按复制/附件图标分类/时间戳/highlight 定位——**零必修缺陷**。
- 微项:命令列表每次重组重建(21 对象,量小,记录保留)。

### 轮 52(解决)——落实轮 51

- AssistantBubble 尾段(重试按钮/媒体卡/openMedia)同段走查确认。
- ChatScreen 为纯 UI 且本环境无 Android 编译,守卫依赖 check-android-sources 门禁;走查结论入档。

### 轮 53(提出)——Kotlin OpsScreen/CcScreen 走查

- **OpsScreen**(381 行):LogCard 分源/行数切换/SelectionContainer/状态分派、InfoRow、formatBytes/formatUptime——标准实现。
- **CcScreen**(839 行):ccRunRequested 重放 key 设计(表异步加载后重放)巧妙;确认对话框/导入链接二次确认齐备。
- **Q1(低-中,真 bug)**:cc-switch 可用但 views/commands 为**合法空列表**时,`/cc run xxx` 请求因 `isEmpty()` 误当"未加载"而悬挂——用户输入永远无响应。

### 轮 54(解决)——落实轮 53

- **Q1 已修复**:加载完成判定改用 `ccStatus == null`(reloadCcTables 恒置 ccStatus),空列表合法放行,matchCcQuery 兜底 runCcRaw。
- OpsScreen 确认项入档;CcScreen 确认流确认正确。

### 轮 55(提出)——api.ts session 路由域

- 走查:GET /session → sessionView(engine/model/hasSession/workDir 仅 CLI 引擎下发、timezone);POST /new → `requireIdle` + resetSession;POST /agent → resolveEngine 特判 opencode(防解析成同名 CLI);POST /model → 提前 resolveModel——**零必修缺陷**,既有测试已覆盖 switch/reset。
- 缺口:任务活跃时 /new 与 /model 的 409 拒绝未断言。

### 轮 56(解决)——落实轮 55

- 补 409 回归测试:挂起任务期间 POST /new 与 POST /model 均 409 且文案含"任务执行中"。
- sessionView 确认项入档(key 仅回 app 自身、CLI 分支 workDir 仅 CLI 引擎下发)。

### 轮 57(提出)——scripts/send_mail.js + check_inbox.js

- 审查:会话文件经 `storageState` 持久化到 `data/email/session.json`(/data/ 已忽略,git 未跟踪 ✓);无凭据硬编码;**S-2(低-中)**:浏览器路径硬编码 `chromium-1248`——Playwright 升级换版本目录后两个脚本同时失效。

### 轮 58(解决)——落实轮 57

- 两脚本统一抽 `detectChromePath()`:`CHROME_PATH` 环境变量 → 缓存目录探测最新 `chromium-*` → 历史路径兜底;`node --check` 与模块导入验证。

### 轮 59(提出)——apiPersonal.ts export 路由复审

- 确认:format 白名单(markdown/json)、`key` 仅回 app 自身(appKey 无敏感)、双格式附件响应与文件名正确——零必修缺陷。
- 缺口:App API 端点零直测(Telegram 端 /export 有测试覆盖)。

### 轮 60(解决)——落实轮 59

- 补端点直测:json 响应头与 entries 内容、markdown 标题与任务文本回显、非法 format 400。

### 轮 61(提出)——ccCommands model 分支(#agentsText/#ccModelPanel)

- 审查:4096 字符预算 + push 函数、escapeMarkdown 全量转义(`[_*`[\]\\]`)、截断提示指回 `npm run models -- agents`、reloadCustomModels 热加载——**零必修缺陷**。
- 缺口:agentsText 的 markdown 转义(agent 元数据注入面)未直测。

### 轮 62(解决)——落实轮 61

- 补 markdown 注入测试:恶意 description 的 `[链接]`/`*粗体*` 被转义为 `\[` 与 `\*`。
- 确认项入档。

### 轮 63(提出)——scripts/x_action.js(X 发推/资料/时间线)

- 审查:会话 storageState(data/x_account,已忽略)、UA 显式(X 反自动化)、--no-sandbox、finally close——正确。
- **Q1(与轮 58 同型)**:CHROME_PATH 硬编码 `chromium-1248`——邮件脚本已修,本脚本漏。
- Q2 保留:postTweet 无发出断言(X DOM 检测脆弱,固有限制)。

### 轮 64(解决)——落实轮 63

- x_action.js 套用 `detectChromePath` 模式(env→缓存探测→兜底,与邮件脚本一致);grep 全 scripts 确认无残留硬编码。
- Q2 保留理由入档。

### 轮 63 补充——第四实例

- grep 全 scripts 追缴:`x_search_free_servers.mjs` 同样硬编码 chromium-1248——同轮修复(第四实例,全部清零)。

### 轮 64 补充

- `node --check` ×4 全部通过;grep `chromium-1248` 只剩各 detectChromePath 内的兜底行(符合预期)。

### 轮 65(提出)——Kotlin ChatScreen 尾段

- 走查:重试按钮(failed/cancelled 分文案)、RunningLine 本地秒级计时(progress 或兜底文案)、复制按钮 1.5s 自动复位、媒体分派(image 内嵌/其他卡)、openMedia 全屏——质量高。
- 1 个假设待验证:`mediaImages` bitmap 缓存疑无界增长(~10MB/图)。

### 轮 66(解决)——假设证伪

- 证伪:已有 `MAX_MEDIA_IMAGES = 8` 的 LRU 截断(注释明确 ~10MB/图、滚回重新解码)——缓存有界,无需修改。
- 确认项入档:RunningLine 计时、复制状态自动复位。

### 轮 67(提出)——opencode.ts files 路径(附件→data URL)

- 复审:files→data URL 构造已有直测;mime 上游受控(attachments 三类分类/apiTasks MIME_RE)、数量上游限 4、base64 编码正确——确认正确。
- 1 个防御性低项:mime 直接拼 data URL 无空值兜底。

### 轮 68(解决)——落实轮 67

- mime 加 octet-stream 兜底(防 data URL 被截断);已有 files 测试保持通过。

### 轮 69(提出)——messages.ts 全文(175 行)

- 审查:clip/clipTail 双向 surrogate 防御、pickCut(换行/空格回退+surrogate)、splitMessage 的 Markdown 感知拆分(fence 关闭重开/inline span 移到下一条/重开预算计算/surrogate 守卫)、escapeMarkdown(legacy 集 `[_*`[]\\]` 正确)、pruneChatState(活跃保护)——**零必修缺陷**,12 个既有测试覆盖拆分逻辑。
- 缺口:escapeMarkdown 无直测。

### 轮 70(解决)——落实轮 69

- 补 escapeMarkdown 直测:特殊字符往返一致 + 字面反斜杠转双反斜杠。
- 适配 lint 门禁:正则里的无谓转义(`\[`、`\_`)改为字符串 startsWith 断言——顺带消除正则转义嵌套的可读性问题。

### 轮 71(提出)——Kotlin ListScreens + SettingsScreen 走查

- 审查:`dueCountdown` 渐进计算(秒/分/时/天,`+30_000` 四舍五入)、`rememberClock` 30s 重读服务器时钟(协程随屏销毁)、Reminders 的延后/删除操作、Settings 的本地状态 + 扫码导入(zxing 的 CaptureActivity 同进程开相机,声明 CAMERA 需运行时授权,注释正确)+ encKey 输入框——**零必修缺陷**。

### 轮 72(解决)——确认轮

- 两屏无缺陷可修,确认项入档;ListScreens/SettingsScreen 审毕。

### 轮 73(提出)——setup.ts(首次连接向导,341 行)

- 全文审查:TOKEN_RE 格式校验、maskToken(掩码保留尾 4 位)、parseUserIds(数字白名单+去重+安全整数)、apiCall 错误 redactToken(URL 里 token 脱敏)、writeEnvFile 原子写+0600 双 chmod、upsertEnv 重复键全重写(dotenv last-wins 语义)、写入前重读防覆盖运行中的 bot、waitForOwner(私聊过滤+排空 offset+超时)、canRunSetup(TTY+CI)——**零必修缺陷**,11 个测试覆盖完备。
- 缺口:redactToken 错误脱敏无端到端断言。

### 轮 74(解决)——落实轮 73

- 补泄漏测试:getMe 网络错误(URL 含 token)→ 打印与返回结果全部掩码,无 token 泄漏。
- setup.ts 审毕。

### 轮 75(提出)——lock.ts/logger.ts/binPath.ts

- 全文审查:lock 的 link 原子锁(防竞态观察空锁文件)/claim 回收(防双启动)/EEXIST 竞态处理/PID 复用检测(/proc starttime);logger 的 copytruncate 轮转/保留 7 份/分级 redactSecrets(string 参数);binPath 的 PATH 扩展(existsSync 每次——Telegram 安装的 CLI 立即可见)/scrubEnv(合并后剥离 BOT_ONLY)/installerChildEnv——**零必修缺陷**。
- LB-2 保留:logger 对象参数不脱敏(调用方大多传字符串,对象多不含凭据)。

### 轮 76(解决)——确认轮

- 三文件无缺陷可修,LB-2 保留理由入档;lock/logger/binPath 审毕。

### 轮 77(提出)——x_search_free_servers.mjs 全文(144 行)

- 走查:`hostOf` 域名过滤(x.com/t.co 自身排除)、`pickExternal` 锚文本还原真实外链(t.co 重写)、seen Map 去重、slug 文件名清洗、登录检测截图、每查询 try/catch——**零必修缺陷**。
- 微项:UA 尾段 `Safari/124.0.0.0` 为无效版本号(与 x_action 的 `Safari/537.36` 不一致)。

### 轮 78(解决)——落实轮 77

- UA 尾段修正为 `Safari/537.36`(与 x_action 一致)。
- 确认项入档。

### 轮 79(提出)——parseReply 边界补充 + abortSession 复核

- node 实测验证:连续指令(`…a.png]][[file:…b.pdf]]`)产生两个 media part;路径逃逸目标(`outbox/../..`)**parseReply dropped=0**——由 resolveMedia 的 containment 检查分层拦截(设计:parse 只解析,resolve 负责安全);大写 KIND 归一。
- abortSession 复核:全部调用方(telegram stop/超时/取消/网络错误)均带 .catch ✓。

### 轮 80(解决)——确认入档

- 零必修缺陷;分层设计(parse 解析/resolve 安全)为有意架构,实测脚本留存于本节。

### 轮 81(提出)——Kotlin PickerDialog + StatusScreen 尾段走查

- **PickerDialog**(228 行):LaunchedEffect 刷新、稳定 key("agent:id"/"model:value")、选中态对比、空模型提示、恢复默认按钮——正确。
- **StatusScreen**(171 行):最近备份行、每日报告卡、连接信息——正确(轮 41-42 已补测试)。

### 轮 82(解决)——确认入档

- 两文件零必修缺陷;PickerDialog/StatusScreen 审毕。

### 轮 83(提出)——机动抽查:已修 bug 回归清单

- 5 项抽查点:①runNow 返回更新快照(scheduler);②备份排除 api-enc-key.json(ops,双断言);③escapeMarkdown 往返一致(messages);④redactToken 泄漏(setup);⑤markdown 注入转义(ccCommands)。

### 轮 84(解决)——抽查执行

- 5 项回归测试全部在位且通过(703 全绿);近期修复零回归,确认入档。

### 轮 85(提出)——apiRateLimit.ts + api.ts 拆分全景

- **发现**:并行会话完成 api.ts 全面拆分(2158→1014 行,拆出 apiCc/apiCcSpecs/apiRateLimit/apiModelRoutes/apiAgentRoutes/apiOpsRoutes/apiTaskRoutes 等 13 个模块)——我此前五刀的延续与收尾。
- **apiRateLimit.ts**(115 行,全新功能)审查:失败预算(10 次/60s 窗口)、冷却 5 分钟、**recordSuccess 不清除活跃冷却**(防代理共享地址洗白——注释连攻击场景都想到了)、maxKeys=4096 防内存膨胀、429+retry-after、授权先行——**零必修缺陷**,已有直测。

### 轮 86(解决)——确认入档

- apiRateLimit 接线确认:授权先行,错误 token 才计预算。
- api.ts 拆分全景确认,后续轮次按新模块结构轮转。

### 轮 87(提出)——新拆模块抽查

- 审查:**apiCc.ts**(537 行)采用依赖注入模式与 apiPersonal 统一——CcRouteDeps 把 ccQuery(读型)/runCcAction(写型,带 #ccActionRunning 单飞)/withCcLock(互斥)三者分离,语义正确;**apiCcSpecs.ts**(514 行)为纯函数校验集;**apiModelRoutes.ts**(96 行)校验/冲突/能力提示完整——**零必修缺陷**。

### 轮 88(解决)——确认入档

- 并行会话的 api.ts 拆分质量高(读写锁分离设计正确);新模块抽查完毕。

### 轮 89(提出)——apiOpsRoutes + apiAgentRoutes 抽查

- **apiOpsRoutes**(72 行):diag/service/check-update/backup(轮 11 的二进制迁移正确)/logs(行数钳制 10-400)/POST 动作白名单(start/stop/restart/update/check/cc/cc-update/service)——与旧 api.ts 语义一致。
- **apiAgentRoutes**(74 行):resolveEngine 特判 opencode、isManaged 守卫、使用中 409、#running 单飞、输出 redactSecrets + 尾部 20K(App 需要 tail)——**零必修缺陷**。

### 轮 90(解决)——确认入档

- 两路由审毕,零必修缺陷。

### 轮 91(提出)——setup-cli.ts(11 行,CLI 入口包装)

- 审查:薄包装正确(错误打印 err.message,setup.ts 的错误已脱敏);微项:非 Error 对象时打印对象本身而非 String 化。

### 轮 92(解决)——落实轮 91

- 非 Error 分支改 `String(err)`;setup-cli 审毕——**src/ 目录全部文件审毕**。

### 轮 93(提出)——Kotlin SlashCommands.kt 全文(399 行)

- 审查:matchCcQuery 的最长词组优先(`skills repos add` 读第三词为命令而非目标)+ read-only 视图优先于写 + 目标有无 tie-breaking——设计好;applySlashCommand 全分支(export/agent/agents/model/dir/timezone/cancel/schedule/env/access/alias/proxy/cc/logs/ops/update/restart/service)均有用法提示与导航;fallback 提示「该命令由服务端处理」优雅引导;SLASH_COMMANDS 集合与 appParity 测试对齐——**零必修缺陷**。

### 轮 94(解决)——确认入档

- SlashCommands 审毕。

### 轮 95(提出)——机动确认轮:全部门禁复扫

- noUnusedLocals 0、TODO/FIXME 0、lint 0 告警、knip 零发现。
- 确认用户已提交两批(`aa31dcc 深度审查修复与Android发布流程优化`、`db27ba5 项目优化`),远程已同步。

### 轮 96(解决)——确认入档

- 门禁全绿;工作区剩余为本会话后段迭代改动(DEEP-100.md/CHANGELOG 等),待用户提交。
