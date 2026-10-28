import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_FILE = path.resolve(__dirname, "../data/email/session.json");
const CHROME_PATH = "/data/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

export async function sendEmail({ to, subject, body }) {
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
    await page.goto("https://outlook.live.com/mail/0/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    // Discard any active compose if exists
    const discardBtn = await page.$("button[aria-label*=\"放弃\"], button[id*=\"discard\"]");
    if (discardBtn) {
      await discardBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      const confirmDiscard = await page.$("button:has-text(\"放弃\"), button:has-text(\"确定\")");
      if (confirmDiscard) await confirmDiscard.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // Press 'n' to compose new mail
    await page.keyboard.press("KeyN");
    await page.waitForTimeout(2500);

    // Fill recipient
    const toEl = await page.waitForSelector("div[aria-label*=\"收件人\"], div[aria-label*=\"To\"]", { timeout: 15000 });
    await toEl.click();
    await page.keyboard.type(to, { delay: 30 });
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);

    // Focus Subject via Tab
    await page.keyboard.press("Tab");
    await page.waitForTimeout(400);
    await page.keyboard.type(subject, { delay: 20 });
    await page.waitForTimeout(400);

    // Focus Body via Tab
    await page.keyboard.press("Tab");
    await page.waitForTimeout(400);
    await page.keyboard.type(body, { delay: 10 });
    await page.waitForTimeout(800);

    // Send via standard shortcut
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(5000);

    // Fallback: check if primary split button for send still exists
    const primarySend = await page.$("button[id*=\"splitButton\"][aria-label*=\"发送\"]");
    if (primarySend) {
      await primarySend.click().catch(() => {});
      await page.waitForTimeout(4000);
    }

    // Save back updated session cookies
    await context.storageState({ path: SESSION_FILE });
    return { success: true, message: `Email successfully sent to ${to}` };
  } finally {
    await browser.close();
  }
}

// CLI execution
if (process.argv[1] === __filename) {
  const [,, to, subject, body] = process.argv;
  if (!to || !subject || !body) {
    console.error("Usage: node send_mail.js <recipient> <subject> <body>");
    process.exit(1);
  }

  sendEmail({ to, subject, body })
    .then(res => {
      console.log(res.message);
      process.exit(0);
    })
    .catch(err => {
      console.error("Failed to send email:", err.message);
      process.exit(1);
    });
}
