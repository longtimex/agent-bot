import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_FILE = path.resolve(__dirname, "../data/email/session.json");
const CHROME_PATH = "/data/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

export async function getLatestEmails(limit = 5) {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Email session not found at: ${SESSION_FILE}`);
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true
  });

  const context = await browser.newContext({
    storageState: SESSION_FILE
  });

  const page = await context.newPage();

  try {
    await page.goto("https://outlook.live.com/mail/0/inbox", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    // Click refresh/sync if button exists
    const syncBtn = await page.$("button[id*=\"SyncButton\"], button[aria-label*=\"同步\"]");
    if (syncBtn) {
      await syncBtn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    const items = await page.$$eval("div[role=\"listbox\"] div[role=\"option\"]", (els, max) => {
      return els.slice(0, max).map(e => e.innerText.replace(/\n+/g, " ").trim());
    }, limit);

    return items;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === __filename) {
  getLatestEmails(5)
    .then(items => {
      console.log(JSON.stringify(items, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error("Error checking inbox:", err.message);
      process.exit(1);
    });
}
