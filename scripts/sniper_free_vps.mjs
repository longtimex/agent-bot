import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, "../.env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const API_BASE = "https://cloud.ascsonoway.com";
const CREDENTIALS = {
  email: process.env.SNIPER_EMAIL?.trim(),
  password: process.env.SNIPER_PASSWORD
};

if (!CREDENTIALS.email || !CREDENTIALS.password) {
  console.error("缺少 SNIPER_EMAIL / SNIPER_PASSWORD 环境变量，请在 .env 中配置。");
  process.exit(1);
}

const LOG_FILE = path.resolve(__dirname, "../data/sniper.log");
const STATE_FILE = path.resolve(__dirname, "../data/claimed_server.json");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

let cachedToken = null;

async function getToken() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CREDENTIALS)
    });
    const data = await res.json();
    if (data.token) {
      cachedToken = data.token;
      return cachedToken;
    }
    log(`Login failed: ${JSON.stringify(data)}`);
  } catch (e) {
    log(`Login request error: ${e.message}`);
  }
  return null;
}

async function requestCheckout(token) {
  const payload = {
    product: "Micro Instances",
    plan: "i5 3470 Micro Free",
    os: "Ubuntu 24.04 LTS",
    billing: "month",
    addons: [],
    promoCode: ""
  };

  const res = await fetch(`${API_BASE}/api/create-checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function main() {
  log("🚀 ASCS Cloud 免费服务器蹲点狙击守护进程已启动");
  log(`账号: ${CREDENTIALS.email}`);

  while (true) {
    try {
      if (!cachedToken) {
        log("正在获取登录授权 Token...");
        cachedToken = await getToken();
        if (!cachedToken) {
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
        log("授权 Token 获取成功");
      }

      const result = await requestCheckout(cachedToken);

      if (result.status === 200) {
        log(`🎉 恭喜！免费服务器抢购成功！`);
        log(`返回数据: ${JSON.stringify(result.data)}`);
        fs.writeFileSync(STATE_FILE, JSON.stringify(result.data, null, 2));
        break;
      }

      if (result.status === 401) {
        log("Token 已过期或失效，重新登录...");
        cachedToken = null;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const { data } = result;
      if (data && data.restockAt) {
        const restockTime = new Date(data.restockAt).getTime();
        const now = Date.now();
        const diffMs = restockTime - now;

        if (diffMs > 60000) {
          // 距离补货还有超过 1 分钟，每 5 分钟探测一次心跳
          const waitSec = Math.min(Math.floor((diffMs - 30000) / 1000), 300);
          log(`[库存锁定中] 官方预计补货时间: ${data.restockAt} (剩余约 ${(diffMs / 3600000).toFixed(2)} 小时)。等待 ${waitSec} 秒后再次探测...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        } else if (diffMs > 0) {
          log(`⚡ 距离补货不足 60 秒！进入毫秒级等待 (${diffMs}ms)...`);
          await new Promise(r => setTimeout(r, Math.max(diffMs, 100)));
        } else {
          // 已到补货时间或时间已过，高频重试
          log(`🔥 已到达补货时间！正在高频抢购重试中...`);
          await new Promise(r => setTimeout(r, 1000));
        }
      } else {
        log(`未返回 restockAt，状态码: ${result.status}，详情: ${JSON.stringify(data)}。15 秒后重试...`);
        await new Promise(r => setTimeout(r, 15000));
      }
    } catch (e) {
      log(`循环发生异常: ${e.message}，10 秒后恢复...`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

main();
