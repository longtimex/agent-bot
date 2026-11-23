import type { AgentCliService } from "./agentCli.js"
import type { AgentModelCatalog } from "./agentModelCatalog.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import { findModel, resolveModelKey } from "./models.js"
import type { ProxyService } from "./proxy.js"
import type { SessionStore } from "./store.js"
import { resolveCliModelCallback } from "./telegramCliModelCallback.js"
import type { TelegramModelCommands } from "./telegramModelCommands.js"

/**
 * Button callbacks for the model and proxy panels, moved out of telegram.ts so the bridge stays
 * within its size budget. Behaviour is unchanged: each handler answers the button, then edits the
 * panel it came from. Returns false when the callback data belongs to another handler.
 */
export interface PanelCallbackDeps {
  store: SessionStore
  agents: AgentCliService
  agentModels: AgentModelCatalog
  proxies: ProxyService
  models: TelegramModelCommands
  running: (key: string) => boolean
  modelPanel: (key: string, refresh?: boolean) => Promise<Panel>
  proxyPanel: () => Panel
  editPanel: (panel: Panel) => Promise<void>
  sendText: (chatId: number, text: string) => Promise<unknown>
  offLoop: (chatId: number, label: string, run: () => Promise<void>) => void
}

export async function handlePanelCallback(
  d: PanelCallbackDeps,
  data: string,
  chatId: number,
  key: string,
  answer: (text?: string) => Promise<void>,
): Promise<boolean> {
  if (data.startsWith("proxy:")) {
    const rest = data.slice("proxy:".length)
    const [action, rawId] = rest.split(":", 2)
    const id = Number(rawId)

    if (action === "off") {
      d.proxies.disable()
      await answer("已停用代理")
      await d.editPanel(d.proxyPanel())
      return true
    }

    if (!Number.isInteger(id)) {
      await answer("代理编号无效")
      return true
    }

    if (action === "use") {
      try {
        const proxy = d.proxies.use(id)
        await answer(`已启用代理 #${proxy.id}`)
      } catch (err) {
        await answer(err instanceof Error ? err.message : "启用失败")
        return true
      }
      await d.editPanel(d.proxyPanel())
      return true
    }

    if (action === "del") {
      const removed = d.proxies.remove(id)
      await answer(removed ? `已删除代理 #${id}` : `代理 #${id} 不存在`)
      await d.editPanel(d.proxyPanel())
      return true
    }

    if (action === "test") {
      await answer("正在测试代理…")
      // A test can take up to 10s: it must not hold the update loop
      d.offLoop(chatId, "代理测试", async () => {
        const result = await d.proxies.test(id)
        const text = result.ok
          ? `✅ 代理 #${id} 连接正常（${result.latencyMs ?? 0}ms）`
          : `❌ 代理 #${id} 测试失败：${result.message}`
        await d.sendText(chatId, escapeMarkdown(text))
      })
      return true
    }
  }

  if (data === "model:refresh") {
    if (d.store.getEngine(key) === "opencode") {
      await answer("OpenCode 模型由服务端配置")
    } else {
      await answer("正在重新探测模型…")
    }
    await d.editPanel(await d.modelPanel(key, true))
    return true
  }

  if (data.startsWith("model:")) {
    if (d.store.getEngine(key) !== "opencode") {
      await answer("当前不是 OpenCode 引擎")
      await d.editPanel(await d.modelPanel(key))
      return true
    }
    // Deleting the session while it is generating would fail the running task
    if (d.running(key)) {
      await answer("任务执行中，请先发送 /stop")
      return true
    }
    if (data === "model:reset") {
      if (!(await d.models.clearOpenCodeModelSelection(key))) {
        await answer("本会话没有独立的模型选择")
        return true
      }
      await answer("已清除模型选择，之后由 OpenCode 自身配置决定")
      await d.editPanel(await d.modelPanel(key))
      return true
    }
    const targetKey = resolveModelKey(data.slice("model:".length))
    const target = findModel(targetKey)
    if (!target) {
      await answer("模型不存在")
      return true
    }
    const current = d.models.getCurrentModel(key)
    if (current?.providerID === target.providerID && current.modelID === target.modelID) {
      await answer("已经是当前模型")
      return true
    }
    await answer(`已切换至 ${target.label}`)
    await d.models.applyOpenCodeModel(key, target)
    await d.editPanel(await d.modelPanel(key))
    return true
  }

  if (data.startsWith("cmodelreset:")) {
    const engine = data.slice("cmodelreset:".length)
    const profile = d.agents.registry.get(engine)
    if (!profile || d.store.getEngine(key) !== engine) {
      await answer("引擎已切换，请重新打开模型面板")
      await d.editPanel(await d.modelPanel(key))
      return true
    }
    if (d.running(key)) {
      await answer("任务执行中，请先发送 /stop")
      return true
    }
    if (!d.models.clearCliModelSelection(key, engine)) {
      await answer("本会话没有独立的模型选择")
      return true
    }
    await answer("已清除模型选择，之后由 CLI 自身配置决定")
    await d.editPanel(await d.modelPanel(key))
    return true
  }

  if (data.startsWith("cmodel:") || data.startsWith("qmodel:")) {
    const { engine, model } = resolveCliModelCallback(data, {
      registry: d.agents.registry,
      catalog: d.agentModels,
    })

    if (d.store.getEngine(key) !== engine) {
      await answer("引擎已切换，请重新打开模型面板")
      await d.editPanel(await d.modelPanel(key))
      return true
    }
    if (!model) {
      await answer("模型不存在")
      return true
    }
    if (d.running(key)) {
      await answer("任务执行中，请先发送 /stop")
      return true
    }
    const current = d.store.getCliModel(key, engine)
    if (current === model) {
      await answer("已经是当前模型")
      return true
    }
    d.models.applyCliModel(key, engine, model)
    await answer(`已切换至 ${d.agentModels.label(engine, model)}`)
    await d.editPanel(await d.modelPanel(key))
    return true
  }
  return false
}
