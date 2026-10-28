import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.resolve(__dirname, "../data/x_account/session.json");
const OUT_DIR = path.resolve(__dirname, "../data/free_server_scan");
const CHROME_PATH = "/data/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "free VPS",
      "免费 VPS",
      "免费 服务器 申请",
      "free cloud server",
      "免费 VPS 领取",
      "免费云服务器 长期",
      "免费 VPS 白嫖",
      "free VPS no credit card",
      "free tier VPS",
      "免费算力",
      "送 服务器 免费 一年",
      "free hosting VPS promo",
    ];

const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 8);

fs.mkdirSync(OUT_DIR, { recursive: true });

function hostOf(u) {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    const h = url.hostname.toLowerCase().replace(/^www\./, "");
    if (h === "x.com" || h === "twitter.com" || h === "t.co" || h.endsWith("t.co")) return "";
    if (h.includes("help.x.com") || h.includes("pic.twitter")) return "";
    return h;
  } catch {
    return "";
  }
}

// 从锚点里还原真实外链：t.co 的 href 没用，但锚文本显示真实域名
function pickExternal(handle) {
  const out = [];
  for (const a of handle.anchors) {
    const href = a.href;
    if (!href || href.startsWith("/")) continue;
    if (hostOf(href)) {
      out.push(href);
      continue;
    }
    if (/^https:\/\/t\.co\//i.test(href) && a.label) {
      const label = a.label.replace(/[….*]+$/, "");
      if (hostOf(label) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(label)) {
        out.push(/^https?:/i.test(label) ? label : `https://${label}`);
      }
    }
  }
  for (const c of handle.card) {
    if (c && hostOf(c)) out.push(c);
  }
  // 正文里裸写的 URL
  const m = handle.text.match(/\bhttps?:\/\/[^\s"'）)、，,]+/gi) || [];
  out.push(...m);
  return out.filter((u) => hostOf(u)).map((u) => u.replace(/[.,;]$/, ""));
}

async function scrapeQuery(page, query, seen) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
  console.log(`\n=== ${query} -> ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  if (await page.$("div[data-testid='errorBoundary'], [data-testid='snackbar']")) {
    const err = await page.textContent("body");
    console.log("  ! search blocked:", err.slice(0, 200));
  }

  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    const articles = await page.$$("article[data-testid='tweet']");
    for (const a of articles) {
      const handle = await a.evaluate((el) => {
        const userLink = el.querySelector('a[href^="/"][data-testid="User-Name"]');
        const timeLink = el.querySelector("time");
        const body = el.querySelector('[data-testid="tweetText"]');
        const tweetLink = Array.from(el.querySelectorAll('a[href*="/status/"]'))
          .map((x) => x.getAttribute("href"))
          .find((h) => h && /\/status\/\d+/.test(h));
        // links: keep href + visible text, because x.com rewrites外链为 t.co，
        // 而 t.co 锚文本显示真实域名
        const anchors = Array.from(el.querySelectorAll("a")).map((x) => ({
          href: x.getAttribute("href") || "",
          label: (x.textContent || "").trim(),
        }));
        const card = Array.from(
          el.querySelectorAll('[data-testid="card.wrapper"] a, [data-testid="card.meta"] a, a[href*="redirect"]')
        ).map((x) => x.getAttribute("href") || "");
        return {
          author: userLink ? userLink.innerText.replace(/\n+/g, " ").trim() : "",
          text: body ? body.textContent.trim() : el.innerText.replace(/\n+/g, "\n").trim(),
          timestamp: timeLink ? timeLink.getAttribute("datetime") : "",
          link: tweetLink || "",
          anchors,
          card,
        };
      });
      const key = handle.link || handle.text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.set(key, {
        query,
        author: handle.author,
        date: handle.timestamp,
        text: handle.text,
        tweetUrl: handle.link ? `https://x.com${handle.link}` : "",
        external: [...new Set(pickExternal(handle))],
        cards: [...new Set(handle.card.filter(Boolean))],
      });
    }
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(1800);
  }

  const rows = [...seen.values()].filter((r) => r.query === query);
  console.log(`  collected ${rows.length} tweets, ${rows.filter((r) => r.external.length).length} with external links`);
  await page.screenshot({ path: path.join(OUT_DIR, `shot_${slug(query)}.png`), fullPage: false });
  return rows;
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "_").slice(0, 30);
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/124.0.0.0",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  const who = await page.$("div[data-testid='AccountSwitcherUser'] , [data-testid='SideNav_AccountSwitcher_Button']");
  console.log("logged in as:", who ? (await who.innerText()).replace(/\n+/g, " ") : "(unknown)");
  if (!who) {
    await page.screenshot({ path: path.join(OUT_DIR, "not_logged_in.png") });
    throw new Error("session appears logged out — see data/free_server_scan/not_logged_in.png");
  }

  let all = [];
  const seen = new Map();
  for (const q of QUERIES) {
    try {
      all = all.concat(await scrapeQuery(page, q, seen));
    } catch (e) {
      console.log(`  query failed: ${e.message}`);
    }
  }

  await context.storageState({ path: SESSION_FILE });
  const outFile = path.join(OUT_DIR, `tweets_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.log(`\nTOTAL tweets: ${all.length}`);

  const links = new Map();
  for (const t of all) {
    for (const raw of t.external) {
      const host = hostOf(raw);
      if (!host) continue;
      const e = links.get(host) || { host, count: 0, sampleTexts: [], urls: new Set() };
      e.count++;
      e.urls.add(raw.slice(0, 140));
      if (e.sampleTexts.length < 3) e.sampleTexts.push(`${t.author}: ${t.text.slice(0, 200)}`);
      links.set(host, e);
    }
  }
  const ranked = [...links.values()].sort((a, b) => b.count - a.count);
  fs.writeFileSync(path.join(OUT_DIR, "domains.json"), JSON.stringify(ranked, null, 2));
  console.log(`\ndistinct external domains: ${ranked.length}`);
  for (const d of ranked.slice(0, 25)) {
    console.log(`- ${d.host}  x${d.count}`);
    console.log(`    ${d.urls ? [...d.urls].slice(0, 2).join(" | ") : ""}`);
  }
  console.log(`\njson: ${outFile}`);
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
