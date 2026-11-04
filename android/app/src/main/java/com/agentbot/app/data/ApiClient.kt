package com.agentbot.app.data

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** A request the server answered with a non-2xx status; message carries the API error text. */
class ApiException(val code: Int, message: String) : Exception(message)

/** Thrown when the app has no usable server settings yet. */
class NotConfiguredException : Exception("尚未配置服务器地址与令牌")

data class Connection(
    val baseUrl: String,
    val token: String,
    /** 消息级加密配对密钥（base64）；为空时全部请求走明文。 */
    val encKey: String? = null,
)

/**
 * Thin client for the bot's /api/v1 surface. The bot may run a self-signed or
 * plain-HTTP endpoint, so the client tolerates cleartext by trusting the user's
 * explicit configuration rather than wiring a custom SSL context.
 */
class ApiClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        // Four queued prompts plus the running one each hold an SSE stream: the default
        // five-per-host would put every ordinary call behind them until a task finished.
        .dispatcher(Dispatcher().apply { maxRequestsPerHost = 16 })
        .build()

    /** Agent installs, git pulls and builds can take many minutes; only those calls use this client. */
    private val longHttp: OkHttpClient = http.newBuilder()
        .readTimeout(30, TimeUnit.MINUTES)
        .build()

    private fun url(connection: Connection, path: String): String =
        connection.baseUrl.trimEnd('/') + "/api/v1" + path

    // 加密只覆盖 JSON 请求/响应；SSE 流、媒体与备份是原始字节/长连接，保持明文。
    // 用段判断而非带引号的斜杠字面量，避免 appParity 的路径扫描把辅助函数当成端点。
    private fun encryptionSkipped(path: String): Boolean {
        val segments = path.split('?').first().split('/')
        return segments.contains("events") || segments.contains("media") || segments.lastOrNull() == "backup"
    }

    private fun encryptionKeyBytes(encKey: String): ByteArray =
        java.util.Base64.getDecoder().decode(encKey)

    private fun encryptBody(encKey: String, plaintext: String): String {
        val keyBytes = encryptionKeyBytes(encKey)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(keyBytes, "AES"))
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val out = ByteArray(cipher.iv.size + ciphertext.size)
        cipher.iv.copyInto(out)
        ciphertext.copyInto(out, cipher.iv.size)
        return java.util.Base64.getEncoder().encodeToString(out)
    }

    private fun decryptBody(encKey: String, payload: String): String {
        val raw = java.util.Base64.getDecoder().decode(payload)
        if (raw.size < 12 + 16) throw ApiException(0, "加密响应不完整")
        val keyBytes = encryptionKeyBytes(encKey)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            javax.crypto.Cipher.DECRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
            javax.crypto.spec.GCMParameterSpec(128, raw, 0, 12),
        )
        return cipher.doFinal(raw, 12, raw.size - 12).toString(Charsets.UTF_8)
    }

    private fun request(connection: Connection, method: String, path: String, body: JsonObject? = null): Request {
        val builder = Request.Builder()
            .url(url(connection, path))
            .header("Authorization", "Bearer ${connection.token}")
        val encKey = connection.encKey?.takeIf { it.isNotBlank() && !encryptionSkipped(path) }
        if (encKey != null) {
            builder.header("x-enc", "v1")
            // 响应解密时 execute 只拿得到 Request，把密钥挂在 tag 上随身携带
            builder.tag(EncKeyTag::class.java, EncKeyTag(encKey))
        }
        when {
            body != null -> {
                val plaintext = json.encodeToString(JsonObject.serializer(), body)
                val wire = if (encKey != null) encryptBody(encKey, plaintext) else plaintext
                builder.method(
                    method,
                    wire.toRequestBody("application/json; charset=utf-8".toMediaType()),
                )
            }
            method == "DELETE" || method == "POST" -> builder.method(method, ByteArray(0).toRequestBody(null))
            else -> builder.get()
        }
        return builder.build()
    }

    private suspend fun execute(request: Request, client: OkHttpClient = http): String = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            // 错误响应同样可能是密文（服务端对所有 JSON 应答一视同仁），先还原再提取消息
            val encKey = request.header("x-enc")?.let { connectionKeyFor(request) }
            val plain = if (res.header("x-enc") == "v1" && encKey != null) decryptWithGuard(encKey, text) else text
            if (!res.isSuccessful) {
                val detail = runCatching {
                    (json.parseToJsonElement(plain).jsonObject)["error"]?.jsonPrimitive?.content
                }.getOrNull()
                throw ApiException(res.code, detail ?: "HTTP ${res.code}")
            }
            // 发起时带了加密头且服务端同样以加密应答，才解密
            if (res.header("x-enc") == "v1" && encKey != null) plain else text
        }
    }

    /** 解密失败统一转成 ApiException，避免裸 crypto 异常冒泡到界面。 */
    private fun decryptWithGuard(encKey: String, payload: String): String =
        runCatching { decryptBody(encKey, payload) }.getOrElse {
            throw ApiException(0, "解密响应失败：${it.message}")
        }

    /** execute 只有 Request 可用；从 Authorization 旁路找不回 Connection，改为请求时挂在 tag 上。 */
    private fun connectionKeyFor(request: Request): String? = request.tag(EncKeyTag::class.java)?.value

    class EncKeyTag(val value: String)

    private suspend fun getBody(connection: Connection, path: String): JsonObject =
        json.parseToJsonElement(execute(request(connection, "GET", path))).jsonObject

    private suspend fun getBytes(connection: Connection, path: String): ByteArray = withContext(Dispatchers.IO) {
        http.newCall(request(connection, "GET", path)).execute().use { res ->
            val bytes = res.body?.bytes() ?: ByteArray(0)
            if (!res.isSuccessful) {
                val detail = runCatching {
                    (json.parseToJsonElement(bytes.decodeToString()).jsonObject)["error"]?.jsonPrimitive?.content
                }.getOrNull()
                throw ApiException(res.code, detail ?: "HTTP ${res.code}")
            }
            bytes
        }
    }

    private suspend fun send(connection: Connection, method: String, path: String, body: JsonObject? = null): JsonObject =
        json.parseToJsonElement(execute(request(connection, method, path, body))).jsonObject

    private fun <T> parseList(obj: JsonObject, field: String, deserializer: kotlinx.serialization.KSerializer<T>): List<T> {
        val array = obj[field]?.jsonArray ?: return emptyList()
        return array.map { json.decodeFromJsonElement(deserializer, it.jsonObject) }
    }

    // ---- lifecycle ----

    suspend fun health(connection: Connection): Health =
        json.decodeFromJsonElement(Health.serializer(), getBody(connection, "/health"))

    suspend fun session(connection: Connection): Session =
        json.decodeFromJsonElement(Session.serializer(), getBody(connection, "/session"))

    /** Every session the token can see, so the App can show what the Telegram side runs. */
    suspend fun peers(connection: Connection): List<Peer> =
        parseList(getBody(connection, "/peers"), "peers", Peer.serializer())

    /** Adopts another session's engine, model and working directory for this App. */
    suspend fun followPeer(connection: Connection, scope: String): String {
        val res = send(connection, "POST", "/peers/follow", buildJsonObject { put("scope", scope) })
        return res["message"]?.jsonPrimitive?.content ?: "已跟随对端设置"
    }

    suspend fun status(connection: Connection): Status =
        json.decodeFromJsonElement(Status.serializer(), getBody(connection, "/status"))

    /** Session and pairing details (mirrors Telegram's `/id` and `/api`). */
    suspend fun info(connection: Connection): ServerInfo =
        json.decodeFromJsonElement(ServerInfo.serializer(), getBody(connection, "/info"))

    /** Telegram's `/help`, `/help full` and `/help cc`, served from one shared copy. */
    suspend fun help(connection: Connection): HelpView =
        json.decodeFromJsonElement(HelpView.serializer(), getBody(connection, "/help"))

    // ---- chat ----

    suspend fun submitTask(
        connection: Connection,
        text: String,
        attachments: List<PendingAttachment> = emptyList(),
        engine: String? = null,
        model: String? = null,
    ): Task {
        val body = buildJsonObject {
            put("text", text)
            // Per-task overrides: the session default stays untouched.
            engine?.takeIf { it.isNotBlank() }?.let { put("engine", it) }
            model?.takeIf { it.isNotBlank() }?.let { put("model", it) }
            if (attachments.isNotEmpty()) {
                put(
                    "attachments",
                    buildJsonArray {
                        attachments.forEach { att ->
                            add(buildJsonObject {
                                put("name", att.name)
                                put("mime", att.mime)
                                put("data", att.base64)
                            })
                        }
                    },
                )
            }
        }
        val res = send(connection, "POST", "/task", body)
        val task = res["task"]?.jsonObject ?: throw ApiException(500, "响应缺少 task 字段")
        return json.decodeFromJsonElement(Task.serializer(), task)
    }

    suspend fun task(connection: Connection, id: String): Task {
        val res = getBody(connection, "/task/$id")
        val task = res["task"]?.jsonObject ?: throw ApiException(500, "响应缺少 task 字段")
        return json.decodeFromJsonElement(Task.serializer(), task)
    }

    /**
     * Streams task snapshots from the SSE endpoint until the terminal state.
     * Returns normally on done/failed/cancelled; throws when the stream cannot
     * be established or closes early, so the caller can fall back to polling.
     */
    suspend fun streamTask(connection: Connection, id: String, onEvent: (Task) -> Unit): Unit =
        withContext(Dispatchers.IO) {
            val call = http.newCall(request(connection, "GET", "/task/$id/events"))
            call.execute().use { res ->
                if (!res.isSuccessful) throw ApiException(res.code, res.body?.string()?.take(200) ?: "HTTP ${res.code}")
                val source = res.body?.source() ?: throw ApiException(500, "空的事件流")
                while (true) {
                    // Heartbeats arrive as ": ping" comments; data frames as "data: {json}"
                    val line = source.readUtf8Line() ?: throw java.io.IOException("事件流提前关闭")
                    if (!line.startsWith("data: ")) continue
                    val payload = line.removePrefix("data: ")
                    val obj = json.parseToJsonElement(payload).jsonObject
                    val task = obj["task"]?.jsonObject?.let { json.decodeFromJsonElement(Task.serializer(), it) }
                        ?: throw java.io.IOException("事件缺少 task 字段")
                    onEvent(task)
                    if (!task.isRunning) return@withContext
                }
            }
        }

    suspend fun stopTasks(connection: Connection): List<String> {
        val res = send(connection, "POST", "/stop")
        return res["stopped"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
    }

    suspend fun newSession(connection: Connection) {
        send(connection, "POST", "/new")
    }

    /** Stops one task: a queued entry is dropped, a running one is aborted. */
    suspend fun stopTask(connection: Connection, id: String): Task {
        val res = send(connection, "POST", "/task/$id/stop")
        val task = res["task"]?.jsonObject ?: throw ApiException(500, "响应缺少 task 字段")
        return json.decodeFromJsonElement(Task.serializer(), task)
    }

    /**
     * Re-runs a finished task on the server, which replays the stored prompt with
     * its attachments and model pin — the twin of Telegram's `/retry`.
     */
    suspend fun retryTask(connection: Connection, id: String): Task {
        val res = send(connection, "POST", "/task/$id/retry")
        val task = res["task"]?.jsonObject ?: throw ApiException(500, "响应缺少 task 字段")
        return json.decodeFromJsonElement(Task.serializer(), task)
    }

    /** Tasks queued or running for the app session, oldest first. */
    suspend fun queue(connection: Connection): List<Task> {
        val res = getBody(connection, "/queue")
        return parseList(res, "tasks", Task.serializer())
    }

    /**
     * Recent task records, newest first — including the settled ones `/queue` drops, which is
     * what lets the queue screen re-run any of them instead of only the last message.
     */
    suspend fun tasks(connection: Connection, limit: Int = 20): List<Task> {
        val res = getBody(connection, "/tasks?limit=$limit")
        return parseList(res, "tasks", Task.serializer())
    }

    /** Telegram's 「清空排队」: cancels queued tasks only and returns their ids. */
    suspend fun clearQueue(connection: Connection): List<String> {
        val res = send(connection, "POST", "/queue/clear")
        return res["cleared"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
    }

    /** Raw bytes of one reply media item; same auth and SSRF guards as Telegram delivery. */
    suspend fun taskMedia(connection: Connection, taskId: String, index: Int): ByteArray =
        getBytes(connection, "/task/$taskId/media/$index")

    // ---- work dir and timezone ----

    suspend fun dir(connection: Connection): DirInfo =
        json.decodeFromJsonElement(DirInfo.serializer(), getBody(connection, "/dir"))

    /**
     * One level of the server's directory tree. Typing an absolute path is the awkward part
     * of setting a working directory from a phone, so the picker walks it instead.
     */
    suspend fun dirBrowse(connection: Connection, path: String): DirListing =
        json.decodeFromJsonElement(
            DirListing.serializer(),
            getBody(connection, "/dir/browse?path=" + Uri.encode(path)),
        )

    private suspend fun dirAction(connection: Connection, body: JsonObject): DirInfo {
        val res = send(connection, "POST", "/dir", body)
        val dir = res["dir"]?.jsonObject ?: throw ApiException(500, "响应缺少 dir 字段")
        return json.decodeFromJsonElement(DirInfo.serializer(), dir)
    }

    suspend fun setDir(connection: Connection, dir: String): DirInfo =
        dirAction(connection, buildJsonObject { put("dir", dir) })

    suspend fun resetDir(connection: Connection): DirInfo =
        dirAction(connection, buildJsonObject { put("reset", true) })

    suspend fun timezone(connection: Connection): String =
        getBody(connection, "/timezone")["timezone"]?.jsonPrimitive?.content ?: ""

    /** Returns the server's confirmation message; the new zone is available via timezone(). */
    suspend fun setTimezone(connection: Connection, zone: String): String {
        val res = send(connection, "POST", "/timezone", buildJsonObject { put("timezone", zone) })
        return res["message"]?.jsonPrimitive?.content ?: "时区已更新"
    }

    // ---- engines and models ----

    suspend fun agents(connection: Connection): List<AgentInfo> {
        val res = getBody(connection, "/agents")
        return parseList(res, "agents", AgentInfo.serializer())
    }

    suspend fun switchAgent(connection: Connection, engine: String): EngineSwitch {
        val res = send(connection, "POST", "/agent", buildJsonObject { put("engine", engine) })
        return json.decodeFromJsonElement(EngineSwitch.serializer(), res)
    }

    /** Switchable models for an engine; defaults to the session engine like `/model`. */
    suspend fun models(connection: Connection, engine: String? = null): ModelChoices {
        val query = engine?.takeIf { it.isNotBlank() }?.let { "/models?engine=" + Uri.encode(it) } ?: "/models"
        // The server nests the list under { models: { engine, models: [...], modelHint } }
        val view = getBody(connection, query)["models"]?.jsonObject ?: return ModelChoices()
        return json.decodeFromJsonElement(ModelChoices.serializer(), view)
    }

    /** Install/update/uninstall an Agent CLI; may run for several minutes. */
    suspend fun agentAction(connection: Connection, engine: String, action: String): AgentActionResult {
        val request = request(connection, "POST", "/agents/$engine/$action")
        val text = execute(request, longHttp)
        return json.decodeFromJsonElement(AgentActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    // ---- access ----

    suspend fun access(connection: Connection): AccessInfo =
        json.decodeFromJsonElement(AccessInfo.serializer(), getBody(connection, "/access"))

    suspend fun addAccess(connection: Connection, id: String): AccessResult {
        val res = send(connection, "POST", "/access", buildJsonObject { put("id", id) })
        return json.decodeFromJsonElement(AccessResult.serializer(), res)
    }

    suspend fun removeAccess(connection: Connection, id: String): AccessResult {
        val res = send(connection, "DELETE", "/access/$id")
        return json.decodeFromJsonElement(AccessResult.serializer(), res)
    }

    // ---- aliases ----

    suspend fun aliases(connection: Connection): List<AliasEntry> =
        parseList(getBody(connection, "/aliases"), "aliases", AliasEntry.serializer())

    suspend fun addAlias(connection: Connection, name: String, expansion: String): String {
        val res = send(connection, "POST", "/aliases", buildJsonObject {
            put("name", name)
            put("expansion", expansion)
        })
        return res["message"]?.jsonPrimitive?.content ?: "已创建快捷指令"
    }

    suspend fun deleteAlias(connection: Connection, name: String) {
        send(connection, "DELETE", "/aliases/$name")
    }

    // ---- proxies ----

    suspend fun proxies(connection: Connection): ProxyList =
        json.decodeFromJsonElement(ProxyList.serializer(), getBody(connection, "/proxy"))

    suspend fun addProxy(connection: Connection, url: String, name: String?): ProxyActionResult {
        val body = buildJsonObject {
            put("url", url)
            name?.takeIf { it.isNotBlank() }?.let { put("name", it) }
        }
        val res = send(connection, "POST", "/proxy", body)
        return json.decodeFromJsonElement(ProxyActionResult.serializer(), res)
    }

    suspend fun useProxy(connection: Connection, id: Int): ProxyActionResult {
        val res = send(connection, "POST", "/proxy/$id/use")
        return json.decodeFromJsonElement(ProxyActionResult.serializer(), res)
    }

    suspend fun testProxy(connection: Connection, id: Int): ProxyTestResult {
        val res = send(connection, "POST", "/proxy/$id/test")
        return json.decodeFromJsonElement(ProxyTestResult.serializer(), res)
    }

    suspend fun disableProxy(connection: Connection): String {
        val res = send(connection, "POST", "/proxy/off")
        return res["message"]?.jsonPrimitive?.content ?: "已停用代理"
    }

    suspend fun removeProxy(connection: Connection, id: Int): String {
        val res = send(connection, "DELETE", "/proxy/$id")
        return res["message"]?.jsonPrimitive?.content ?: "已删除代理"
    }

    // ---- ops ----

    suspend fun diagnostics(connection: Connection): Diagnostics {
        val res = getBody(connection, "/ops/diag")
        val diag = res["diagnostics"]?.jsonObject ?: throw ApiException(500, "响应缺少 diagnostics 字段")
        return json.decodeFromJsonElement(Diagnostics.serializer(), diag)
    }

    suspend fun opsService(connection: Connection): ServiceStatus {
        val service = getBody(connection, "/ops/service")["service"]?.jsonObject
            ?: throw ApiException(500, "响应缺少 service 字段")
        return json.decodeFromJsonElement(ServiceStatus.serializer(), service)
    }

    /** `path` is the server's action id, e.g. `check`, `update`, `restart`, `service/start`. */
    suspend fun runOps(connection: Connection, path: String): OpsResult {
        val text = execute(request(connection, "POST", "/ops/$path"), longHttp)
        val result = json.parseToJsonElement(text).jsonObject["result"]?.jsonObject
            ?: throw ApiException(500, "响应缺少 result 字段")
        return json.decodeFromJsonElement(OpsResult.serializer(), result)
    }

    /** 干跑检查更新：GET /ops/check-update，只列出落后提交，不改服务器工作区。 */
    suspend fun checkUpdate(connection: Connection): OpsResult {
        val text = execute(request(connection, "GET", "/ops/check-update"), longHttp)
        val result = json.parseToJsonElement(text).jsonObject["result"]?.jsonObject
            ?: throw ApiException(500, "响应缺少 result 字段")
        return json.decodeFromJsonElement(OpsResult.serializer(), result)
    }

    suspend fun logs(connection: Connection, source: String, lines: Int): LogTail {
        val res = getBody(connection, "/ops/logs?source=$source&lines=$lines")
        return json.decodeFromJsonElement(LogTail.serializer(), res)
    }

    suspend fun customModels(connection: Connection): CustomModels =
        json.decodeFromJsonElement(CustomModels.serializer(), getBody(connection, "/models/custom"))

    suspend fun addCustomModel(
        connection: Connection,
        key: String,
        providerID: String,
        modelID: String,
        label: String?,
        attachment: Boolean? = null,
        contextWindow: Int? = null,
        outputLimit: Int? = null,
    ): CustomModelResult {
        val body = buildJsonObject {
            put("key", key)
            put("providerID", providerID)
            put("modelID", modelID)
            label?.takeIf { it.isNotBlank() }?.let { put("label", it) }
            attachment?.let { put("attachment", it) }
            contextWindow?.let { put("contextWindow", it) }
            outputLimit?.let { put("outputLimit", it) }
        }
        val res = send(connection, "POST", "/models/custom", body)
        return json.decodeFromJsonElement(CustomModelResult.serializer(), res)
    }

    suspend fun removeCustomModel(connection: Connection, key: String, force: Boolean): String {
        val res = send(connection, "DELETE", "/models/custom/$key" + if (force) "?force=1" else "")
        return res["message"]?.jsonPrimitive?.content ?: "已删除模型"
    }

    /** Mirrors `/cc model assign`: bind an agent (or `self`) to a model shorthand. */
    suspend fun assignAgent(connection: Connection, agent: String, model: String): AgentAssignment {
        val body = buildJsonObject {
            put("agent", agent)
            put("model", model)
        }
        val res = send(connection, "POST", "/models/assign", body)
        return json.decodeFromJsonElement(AgentAssignment.serializer(), res)
    }

    // ---- cc-switch ----

    /** Lists providers and runs `--version`; each cc-switch call may take up to 20s. */
    suspend fun ccStatus(connection: Connection): CcStatus {
        val text = execute(request(connection, "GET", "/cc"), longHttp)
        return json.decodeFromJsonElement(CcStatus.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    suspend fun ccUse(connection: Connection, id: String): CcActionResult {
        val res = send(connection, "POST", "/cc/use", buildJsonObject { put("id", id) })
        return json.decodeFromJsonElement(CcActionResult.serializer(), res)
    }

    /** Omitting [id] tests the current provider, mirroring `/cc test`. */
    suspend fun ccTest(connection: Connection, id: String?): CcTestResult {
        val body = buildJsonObject { id?.takeIf { it.isNotBlank() }?.let { put("id", it) } }
        val text = execute(request(connection, "POST", "/cc/test", body), longHttp)
        return json.decodeFromJsonElement(CcTestResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    /** `/cc stream <id>` and `/cc models <id>` — both talk to the provider, so they are slow. */
    private suspend fun ccProviderText(connection: Connection, kind: String, id: String): CcText {
        val path = "/cc/$kind?id=" + Uri.encode(id)
        val text = execute(request(connection, "GET", path), longHttp)
        return json.decodeFromJsonElement(CcText.serializer(), json.parseToJsonElement(text))
    }

    suspend fun ccStream(connection: Connection, id: String): CcText = ccProviderText(connection, "stream", id)

    suspend fun ccProviderModels(connection: Connection, id: String): CcText = ccProviderText(connection, "models", id)

    suspend fun ccProxy(connection: Connection): String = ccTextResource(connection, "/cc/proxy")

    suspend fun ccMcp(connection: Connection): String = ccTextResource(connection, "/cc/mcp")

    suspend fun ccPrompts(connection: Connection): String = ccTextResource(connection, "/cc/prompts")

    /** Read-only cc-switch views offered by the server, with their target prompts. */
    suspend fun ccViews(connection: Connection): List<CcViewSpec> {
        val text = execute(request(connection, "GET", "/cc/views"), longHttp)
        return parseList(json.parseToJsonElement(text).jsonObject, "views", CcViewSpec.serializer())
    }

    /** One view from [ccViews]; [target] is the id/keyword the view asks for. */
    suspend fun ccView(connection: Connection, name: String, target: String? = null): String {
        val suffix = target?.takeIf { it.isNotBlank() }?.let { "&target=" + Uri.encode(it) } ?: ""
        val text = execute(request(connection, "GET", "/cc/view?name=${Uri.encode(name)}$suffix"), longHttp)
        return json.parseToJsonElement(text).jsonObject["text"]?.jsonPrimitive?.content.orEmpty()
    }

    /** `env check`/`env tools` shell out to cc-switch, so this shares the long client. */
    suspend fun ccEnv(connection: Connection, mode: String): CcText {
        val text = execute(request(connection, "GET", "/cc/env?mode=$mode"), longHttp)
        return json.decodeFromJsonElement(CcText.serializer(), json.parseToJsonElement(text))
    }

    private suspend fun ccTextResource(connection: Connection, path: String): String {
        val text = execute(request(connection, "GET", path), longHttp)
        return json.parseToJsonElement(text).jsonObject["text"]?.jsonPrimitive?.content.orEmpty()
    }

    suspend fun ccSyncMcp(connection: Connection): CcActionResult {
        val text = execute(request(connection, "POST", "/cc/mcp/sync"), longHttp)
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    suspend fun ccActivatePrompt(connection: Connection, id: String): CcActionResult {
        val text = execute(
            request(connection, "POST", "/cc/prompts/activate", buildJsonObject { put("id", id) }),
            longHttp,
        )
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    suspend fun ccDeactivatePrompt(connection: Connection): CcActionResult {
        val text = execute(request(connection, "POST", "/cc/prompts/deactivate"), longHttp)
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    /** `/cc mcp import <json>` — paste a full mcpServers block. */
    suspend fun ccImportMcp(connection: Connection, raw: String): CcActionResult {
        val body = buildJsonObject { put("json", raw) }
        val text = execute(request(connection, "POST", "/cc/mcp/import", body), longHttp)
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    /** `/cc prompt new <name>` — creates a prompt file from the given body. */
    suspend fun ccCreatePrompt(connection: Connection, name: String, content: String): CcActionResult {
        val body = buildJsonObject {
            put("name", name)
            put("content", content)
        }
        val text = execute(request(connection, "POST", "/cc/prompts/create", body), longHttp)
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    /** `/cc sessions search <关键词>`: cc-switch scans its session index, so this is slow. */
    suspend fun ccSessionsSearch(connection: Connection, query: String): CcText {
        val path = "/cc/sessions?q=" + Uri.encode(query)
        val text = execute(request(connection, "GET", path), longHttp)
        return json.decodeFromJsonElement(CcText.serializer(), json.parseToJsonElement(text))
    }

    /** `/cc deeplink <ccswitch://…>`: the caller confirms first, so `confirm` replays that tap. */
    suspend fun ccDeeplink(connection: Connection, url: String): CcActionResult {
        val body = buildJsonObject {
            put("url", url)
            put("confirm", true)
        }
        val text = execute(request(connection, "POST", "/cc/deeplink", body), longHttp)
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    /** `/cc quota <id>`: read-only usage, never the credit-burning `--reset`. */
    suspend fun ccQuota(connection: Connection, id: String): CcText = ccProviderText(connection, "quota", id)

    /** Values the create-form offers; cc-switch owns them, so the app never hardcodes them. */
    suspend fun ccProviderMeta(connection: Connection): CcProviderMeta =
        json.decodeFromJsonElement(CcProviderMeta.serializer(), getBody(connection, "/cc/providers"))

    /** `/cc provider add …`: the key goes out but the server masks it in every reply. */
    suspend fun ccAddProvider(connection: Connection, draft: CcProviderDraft): CcActionResult {
        val body = buildJsonObject {
            put("name", draft.name)
            draft.id?.let { put("id", it) }
            draft.template?.let { put("template", it) }
            draft.baseUrl?.let { put("baseUrl", it) }
            draft.apiKey?.let { put("apiKey", it) }
            draft.model?.let { put("model", it) }
            draft.apiFormat?.let { put("apiFormat", it) }
            draft.config?.let { put("config", it) }
        }
        val text = execute(request(connection, "POST", "/cc/providers", body), longHttp)
        return json.decodeFromJsonElement(CcActionResult.serializer(), json.parseToJsonElement(text).jsonObject)
    }

    /** Mutating cc-switch commands the server allows; drives the app's danger zone. */
    suspend fun ccExecCommands(connection: Connection): List<CcExecCommand> {
        val text = execute(request(connection, "GET", "/cc/exec"), longHttp)
        return parseList(json.parseToJsonElement(text).jsonObject, "commands", CcExecCommand.serializer())
    }

    suspend fun ccExec(connection: Connection, name: String, arg: String?, confirm: Boolean): CcExecResult {
        val body = buildJsonObject {
            put("name", name)
            arg?.takeIf { it.isNotBlank() }?.let { put("arg", it) }
            if (confirm) put("confirm", true)
        }
        val text = execute(request(connection, "POST", "/cc/exec", body), longHttp)
        return json.decodeFromJsonElement(CcExecResult.serializer(), json.parseToJsonElement(text))
    }

    /**
     * Telegram's `/cc run <argv>`: one non-interactive cc-switch command as the words the
     * server's guard accepts. `confirm` answers the guard's own request for confirmation.
     */
    suspend fun ccRun(connection: Connection, args: List<String>, confirm: Boolean): CcRunResult {
        val body = buildJsonObject {
            putJsonArray("args") { args.forEach { put(it) } }
            if (confirm) put("confirm", true)
        }
        val text = execute(request(connection, "POST", "/cc/run", body), longHttp)
        return json.decodeFromJsonElement(CcRunResult.serializer(), json.parseToJsonElement(text))
    }

    /** Both Hermes memory blobs plus cc-switch's limits summary, in one read. */
    suspend fun hermes(connection: Connection): HermesMemory =
        json.decodeFromJsonElement(HermesMemory.serializer(), getBody(connection, "/cc/hermes"))

    /**
     * `set` and `clear` overwrite the blob and `enable`/`disable` decide whether Hermes loads
     * it, so the first two only post once the screen has confirmed. The reply carries the
     * stored text, which is what the editor shows again.
     */
    suspend fun hermesAction(
        connection: Connection,
        kind: String,
        action: String,
        content: String? = null,
        confirm: Boolean = false,
    ): HermesResult {
        val body = buildJsonObject {
            put("kind", kind)
            put("action", action)
            content?.let { put("content", it) }
            if (confirm) put("confirm", true)
        }
        val text = execute(request(connection, "POST", "/cc/hermes", body), longHttp)
        return json.decodeFromJsonElement(HermesResult.serializer(), json.parseToJsonElement(text))
    }

    // ---- env config ----

    suspend fun config(connection: Connection): ConfigView =
        json.decodeFromJsonElement(ConfigView.serializer(), getBody(connection, "/config"))

    suspend fun setConfig(connection: Connection, key: String, value: String): ConfigResult {
        val res = send(connection, "PUT", "/config/$key", buildJsonObject { put("value", value) })
        return json.decodeFromJsonElement(ConfigResult.serializer(), res)
    }

    suspend fun unsetConfig(connection: Connection, key: String): ConfigResult {
        val res = send(connection, "DELETE", "/config/$key")
        return json.decodeFromJsonElement(ConfigResult.serializer(), res)
    }

    /**
     * [reset] is the button's meaning: drop the session's own pick whatever the word spells,
     * so an engine that lists a model named `default` cannot hijack the recovery action.
     */
    suspend fun setModel(connection: Connection, model: String, reset: Boolean = false): String {
        val res = send(connection, "POST", "/model", buildJsonObject {
            put("model", model)
            if (reset) put("reset", true)
        })
        return res["message"]?.jsonPrimitive?.content ?: "已切换"
    }

    // ---- history and usage ----

    /** Entries plus the total stored on the server, so the app can show "N / 共 M". */
    /** Fetches the history export document (markdown or json) as raw text. */
    suspend fun exportHistory(connection: Connection, format: String = "markdown"): String =
        withContext(Dispatchers.IO) {
            http.newCall(request(connection, "GET", "/export?format=$format")).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw ApiException(res.code, text.take(200).ifEmpty { "HTTP ${res.code}" })
                text
            }
        }

    suspend fun history(connection: Connection, limit: Int = 20): Pair<List<HistoryEntry>, Int> {
        val res = getBody(connection, "/history?limit=$limit")
        val entries = parseList(res, "history", HistoryEntry.serializer())
        return entries to (res["total"]?.jsonPrimitive?.content?.toIntOrNull() ?: entries.size)
    }

    suspend fun clearHistory(connection: Connection) {
        send(connection, "DELETE", "/history")
    }

    /** Downloads the gzipped data backup produced by GET /ops/backup. */
    suspend fun backupData(connection: Connection): ByteArray =
        withContext(Dispatchers.IO) {
            http.newCall(request(connection, "GET", "/ops/backup")).execute().use { res ->
                val bytes = res.body?.bytes() ?: ByteArray(0)
                if (!res.isSuccessful) {
                    throw ApiException(res.code, bytes.decodeToString().take(200).ifEmpty { "HTTP ${res.code}" })
                }
                bytes
            }
        }

    suspend fun usage(connection: Connection): Pair<Usage, List<UsageTrendDay>> {
        val res = getBody(connection, "/usage")
        val summary = res["usage"]?.jsonObject?.let { json.decodeFromJsonElement(Usage.serializer(), it) } ?: Usage()
        val trend = parseList(res, "trend", UsageTrendDay.serializer())
        return summary to trend
    }

    suspend fun usageReport(connection: Connection): DailyReport =
        json.decodeFromJsonElement(DailyReport.serializer(), getBody(connection, "/usage/report"))

    // ---- reminders ----

    suspend fun reminders(connection: Connection): List<Reminder> {
        val res = getBody(connection, "/reminders")
        return parseList(res, "reminders", Reminder.serializer())
    }

    suspend fun addReminder(connection: Connection, text: String): Reminder {
        val res = send(connection, "POST", "/reminders", buildJsonObject { put("text", text) })
        val reminder = res["reminder"]?.jsonObject ?: throw ApiException(500, "响应缺少 reminder 字段")
        return json.decodeFromJsonElement(Reminder.serializer(), reminder)
    }

    /** Postpones a pending one-shot reminder; the server returns the row with the new time. */
    suspend fun snoozeReminder(connection: Connection, id: Long, minutes: Int): Reminder {
        val res = send(connection, "POST", "/reminders/$id/snooze", buildJsonObject { put("minutes", minutes) })
        val reminder = res["reminder"]?.jsonObject ?: throw ApiException(500, "响应缺少 reminder 字段")
        return json.decodeFromJsonElement(Reminder.serializer(), reminder)
    }

    suspend fun deleteReminder(connection: Connection, id: Long) {
        send(connection, "DELETE", "/reminders/$id")
    }

    // ---- schedules ----

    suspend fun schedules(connection: Connection): List<Schedule> {
        val res = getBody(connection, "/schedules")
        return parseList(res, "schedules", Schedule.serializer())
    }

    suspend fun addSchedule(connection: Connection, text: String): Schedule {
        val res = send(connection, "POST", "/schedules", buildJsonObject { put("text", text) })
        val schedule = res["schedule"]?.jsonObject ?: throw ApiException(500, "响应缺少 schedule 字段")
        return json.decodeFromJsonElement(Schedule.serializer(), schedule)
    }

    suspend fun pauseSchedule(connection: Connection, id: Long, pause: Boolean): Schedule {
        val res = send(connection, "POST", "/schedules/$id/${if (pause) "pause" else "resume"}")
        val schedule = res["schedule"]?.jsonObject ?: throw ApiException(500, "响应缺少 schedule 字段")
        return json.decodeFromJsonElement(Schedule.serializer(), schedule)
    }

    suspend fun deleteSchedule(connection: Connection, id: Long) {
        send(connection, "DELETE", "/schedules/$id")
    }

    /** Telegram's 「▶️ 运行」: executes now without touching dueAt or repeat. */
    suspend fun runSchedule(connection: Connection, id: Long): Schedule {
        val res = send(connection, "POST", "/schedules/$id/run")
        val schedule = res["schedule"]?.jsonObject ?: throw ApiException(500, "响应缺少 schedule 字段")
        return json.decodeFromJsonElement(Schedule.serializer(), schedule)
    }
}

/** Parse helpers shared with the settings screen. */
object ApiFormat {
    /** Normalizes user input like "1.2.3.4:3080" or "agent-bot.example.com" to a full base URL. */
    fun normalizeBaseUrl(raw: String): String {
        var value = raw.trim()
        if (value.isEmpty()) return value
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://$value"
        return value.trimEnd('/')
    }

    fun epochMsToUtcString(ms: Long): String =
        java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.CHINA)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            .format(java.util.Date(ms)) + " UTC"

    fun epochMsToLocalString(ms: Long): String =
        java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(ms))
}
