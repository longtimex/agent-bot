import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_FILE = path.resolve(__dirname, "../data/x_account/session.json");
const CHROME_PATH = "/data/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

async function getBrowserAndContext() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`X session file not found: ${SESSION_FILE}`);
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  return { browser, context };
}

// 1. 发送推文 (Post a Tweet)
export async function postTweet(text) {
  const { browser, context } = await getBrowserAndContext();
  const page = await context.newPage();

  try {
    await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    // Find tweet editor textbox
    const editor = await page.waitForSelector("div[role=\"textbox\"][data-testid=\"tweetTextarea_0\"], div[contenteditable=\"true\"][role=\"textbox\"]", { timeout: 15000 });
    await editor.click();
    await page.waitForTimeout(500);

    // Type content
    await page.keyboard.type(text, { delay: 20 });
    await page.waitForTimeout(1000);

    // Click Post button
    const postBtn = await page.waitForSelector("button[data-testid=\"tweetButton\"], button[data-testid=\"tweetButtonInline\"]", { timeout: 10000 });
    await postBtn.click();
    await page.waitForTimeout(4000);

    // Save updated session state
    await context.storageState({ path: SESSION_FILE });
    return { success: true, message: "Tweet posted successfully!" };
  } finally {
    await browser.close();
  }
}

// 2. 查看个人资料与信息
export async function getProfileInfo() {
  const { browser, context } = await getBrowserAndContext();
  const page = await context.newPage();

  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    const title = await page.title();
    const handleEl = await page.$("div[data-testid=\"SideNav_AccountSwitcher_Button\"]");
    const accountText = handleEl ? await handleEl.innerText() : "@your_handle";

    return {
      title,
      account: accountText.replace(/\n+/g, " ")
    };
  } finally {
    await browser.close();
  }
}

// 3. 查看主页最新推文
export async function getTimeline(limit = 5) {
  const { browser, context } = await getBrowserAndContext();
  const page = await context.newPage();

  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);

    const tweets = await page.$$eval("article[data-testid=\"tweet\"]", (articles, max) => {
      return articles.slice(0, max).map(a => a.innerText.replace(/\n+/g, " ").trim());
    }, limit);

    return tweets;
  } finally {
    await browser.close();
  }
}

// CLI
if (process.argv[1] === __filename) {
  const action = process.argv[2] || "info";

  if (action === "post") {
    const text = process.argv[3];
    if (!text) {
      console.error("Please provide tweet text.");
      process.exit(1);
    }
    postTweet(text)
      .then(res => { console.log(res.message); process.exit(0); })
      .catch(err => { console.error("Error:", err.message); process.exit(1); });
  } else if (action === "timeline") {
    getTimeline(5)
      .then(res => { console.log(JSON.stringify(res, null, 2)); process.exit(0); })
      .catch(err => { console.error("Error:", err.message); process.exit(1); });
  } else {
    getProfileInfo()
      .then(res => { console.log(JSON.stringify(res, null, 2)); process.exit(0); })
      .catch(err => { console.error("Error:", err.message); process.exit(1); });
  }
}
