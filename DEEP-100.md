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
| 41 | 提出 | 远程媒体下载链路(#fetchRemoteMedia + readCappedBody) | 全文审:逐跳 assertUrlAllowed(重定向手动跟随,hop≤3)、pinnedLookup DNS 钉死(代理时交由代理网络,注释明确)、双重大小限制(declared+流式)、body.cancel 释放——**零必修缺陷**;缺口:重定向链与私网逐跳拒绝零直测 | — |
| 42 | 解决 | 同上 | 补集成测试(telegram.test.ts,经 bridge 公开方法+本地 http server):私网逐跳拒绝(默认配置 302 链全部被拒);HarnessOptions 加 mediaAllowPrivateUrls 开关。测试 644→645 | npm run check 645 全绿 |
| 39 | 提出 | scripts/ 目录(12 个脚本,1604 行) | 全扫:sniper_free_vps/send_mail/x_action/check_inbox/check_free_site/x_search/check-android-sources/install-cc-switch/restart/proxy-exec——Playwright 会话文件模式、无命令注入(execFile/$$eval 固定)、proxy-exec 的 set -euo pipefail 正确;**发现 S-1(中-高,安全)**:sniper 登录失败时 stringify 整个响应体进持久日志,凭据回显会泄漏进日志文件 | — |
| 40 | 解决 | 同上 | 修复 S-1(登录失败日志对 email/password 字段脱敏,node --check 验证);其余确认项入档(Playwright session 存储模式、无 console 凭据泄漏、SNIPER_* 环境变量读取) | node --check + 人工核对 |
| 35 | 提出 | ccswitch.ts 前段(toDeeplinkApp/parseMcpConfig/校验链) | 审查:parseMcpConfig 双模式、assertPlainText/ProviderUrl/SafeId、resolveCcSwitchBin 三形态、defaultRunner 自有 deadline+SIGKILL、errorDetail redact——**零必修缺陷**;缺口:assertProviderUrl 的 @ 拒绝与 500 字上限未直测 | — |
| 36 | 解决 | 同上 | 补 2 断言(带凭据 URL 拒绝、过长拒绝);toDeeplinkApp 已有覆盖(含 toString 原型防御断言);确认项入档 | npm run check 643 全绿 |
| 33 | 提出 | ccCommands 剩余分支(#handleCcGroup/#runCcGeneric/#dispatchCc) | 审查:三层 dispatch 防御(--app 拒绝/禁跑清单/确认计划)、deeplink 白名单、provider add 的 apiKey 警告与输出掩码、importMcp 的 base64url deeplink 编码——**零必修缺陷**,掩码已有直测;缺口:mcp add 的 deeplink 编码未直测 | — |
| 34 | 解决 | 同上 | 补 deeplink 编码测试(config 经 base64url 往返一致、apps 键断言);确认项入档(--app 全拼写拒绝/禁跑清单/deeplink 长度上限) | npm run check 643 全绿 |
| 13 | 提出 | ccswitch.ts(脱敏与 pty 确认) | 全文审:shellQuote 白名单+'\'' 转义(buildPtyCommand 唯一 shell 路径全 token 引号)、redactSecrets 五层正则、runPty 双流滚动 tail/优雅终止/BusyBox 探测、parseProviderList 表格解析——**零必修缺陷**;2 个测试缺口:xoxb 槽位与 private_key 键名变体未测 | — |
| 14 | 解决 | 同上 | 补 2 断言(xoxb-1234、private_key = MIIE… 均被掩码);C-3 保留理由入档(runWithConfirm 的 "y\n" 依赖 cc-switch 提示行为稳定,属上游契约) | npm run check 631 全绿 |
| 23 | 提出 | ccCommands.ts #handleCcModel 分支(add/del/assign) | 审查:参数解析边界(--ctx 越界、未知 - 参数)与 del force 确认流确认正确;**发现 Q1(真 bug,中)**:telegram 端 assign 的 applyOpenCodeModel 未防护——文件已写入但会话切换失败时用户收到 ❌(API 端同逻辑有 try,不一致) | — |
| 24 | 解决 | 同上 | 修复 Q1(applyOpenCodeModel 包 try,失败降级为「⚠️ 绑定已写入,请用 /model 手动切换」);新增回归测试(applyOpenCodeModel 抛错时成功消息仍送达+原始错误不独占反馈);调试顺带补 fixture(assistant.md);测试 638→639 | npm run check 639 全绿 |
| 37 | 提出 | attachments.ts(123 行,附件落盘/读取/清理)+ collectAttachments | 全文审:saveAttachment(0700 目录+0600 文件+同毫秒防覆盖+路径剥离)、readTextAttachment(**只读窗口** cap*4+4 不整读 20MB+surrogate 尾清理)、pruneInbox(.gitkeep 保留/逐条 try)、collectAttachments(photo 最大尺寸/分类/mime 兜底)——**零必修缺陷且测试完备**(14 测试);缺口:pruneInbox 符号链接不跟随语义未测 | — |
| 38 | 解决 | 同上 | 补符号链接安全测试(过期链接被删、inbox 外目标不受影响);顺带发现并适配并行会话新增的 lint/knip 门禁(修 2 处:import 语法、未用参数);测试 639→644 | npm run check 644 全绿 + lint/knip 0 告警 |
| 31 | 提出 | apiPersonal 路由域(dir/timezone/aliases/config/access/peers 委托层) | 走查:全部校验下沉在 store/service 层,路由薄——**零必修缺陷**;1 个 API 层测试缺口:alias 非法名字经 API 的 400 转换未直测(store 层校验已测) | — |
| 32 | 解决 | 同上 | 补 API 层断言(POST /aliases 非法名字 → 400 + 快捷指令名指引);确认项入档(dir 的 statSync/hasActiveTask、config 的 REMINDER_TIMEZONE 热路径、access 的 ids 过滤、peers 的 scope 校验) | npm run check 642 全绿 |
| 29 | 提出 | Kotlin AppViewModel 第二段(发送/轮询/重试/停止) | 全文审:pollTask 去重+SSE 优先+分级退避(401/5xx/429/code0 有界/IOException)、send 失败回填草稿+one-off 保留、404 服务器重启语义、通知门控——**零必修缺陷**;1 个竞态待验证:busy 门在 launch 内置位,快速连发可双过 | — |
| 30 | 解决 | 同上 | 修复竞态(busy 置位提前到 launch 外,finally 重置不变);走查确认项入档(pollTask 分级退避矩阵、404 语义、retryFromBanner 限真实失败) | npm run check 639 全绿 |
| 27 | 提出 | Kotlin AppViewModel(连接生命周期与状态调度) | 走查:guarded(取消语义正确)/conn 动态 encKey/恢复轮询/附件上限——质量高;**发现 Q1(低-中)**:未配置连接时每次导航仍触发一次注定失败的 refreshSession(错误横幅反复闪现+无谓请求) | — |
| 28 | 解决 | 同上 | 修复 Q1(refreshSession 加 configured 门;设置页保存后由 saveConnection 触发);guarded 取消语义/conn 动态密钥/恢复轮询等确认项入档 | npm run check 639 全绿 |
| 25 | 提出 | apiTasks.ts(任务提交域,555 行) | 审查:附件校验链/队列 409/model 提前解析/队列链/SSE 节流/prune/view 剥离 key 确认正确;**发现 Q1(中-高,内存)**:submit 把原始 base64 附件存进 task 对象直到 200 条 prune(可达数 GB 驻留);2 项确认(取消判定正则可接受、cleared 任务由 runTask 首行守卫跳过) | — |
| 26 | 解决 | 同上 | 修复 Q1:附件提交即落盘 inbox,task 只存 SavedAttachment 摘要(base64 不驻留);runTask 改用已存摘要;落盘失败并入提示词;retry 从 inbox 重读转 base64;端到端附件测试确认行为不变,测试 639→639(重编号无净增) | npm run check 639 全绿 |
| 21 | 提出 | 测试缺口专项(承轮 2/20) | 2 个已知缺口定稿:①ccCommands speedtest 单飞零直测(轮 20 撤下);②轮 2 实现的 nearestMenuCommand 邻近提示零测试 | — |
| 22 | 解决 | 同上 | 双双补齐:①ccCommands.test.ts 经面板按钮 test:1×2 验证单飞与结果送达(调试中揪出 fixture 表格缺 ID header 行——parseProviderList 依赖 header 定位,无 header 只走 Current 兜底);②telegram.test.ts 集成测试(/sttus 提示+正确命令无提示),测试 637→638 | npm run check 638 全绿 |
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
