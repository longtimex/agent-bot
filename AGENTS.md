# Agent notes

You are running on an instabox sandbox, a Linux VM in the cloud. Nobody is at
its screen and it has no public address. Read ~/MACHINE.md for its ID, size,
what survives a stop, and the tools installed. Work in /data/workspace.

People watch this machine's desktop on the dashboard's Computer tab. While
it runs, browsers Playwright or Puppeteer launch from a new shell show there
(DISPLAY=:1, headed); INSTABOX_HEADLESS=1 keeps them headless.

## 共享账号与服务接口配置（脱敏模板 / Sanitized Template）

> 本文件是脱敏副本：所有真实账号、密码、授权令牌均已替换为占位符。
> 使用前请复制 `.env.example` 为 `.env`（权限 600），填入你自己的凭据。

### 1. 专属发信/收信邮箱 (Outlook)

- **邮箱地址**：`your-email@example.com`
- **登录密码**：`<YOUR_EMAIL_PASSWORD>`
- **密保辅助邮箱**：`your-backup@example.com`
- **会话持久化存储**：`data/email/session.json`
- **开箱即用命令行调用**：
  ```bash
  # 发送邮件
  send_email "收件人@example.com" "邮件主题" "邮件正文"

  # 查收最新邮件列表
  check_email
  ```
- **Node.js 模块引入**：
  ```javascript
  import { sendEmail } from './scripts/send_mail.js';
  import { getLatestEmails } from './scripts/check_inbox.js';
  ```

首次使用需先用 Playwright 登录邮箱并保存 `data/email/session.json`（脚本通过该
storageState 复用登录态，不在代码中保存密码）。

### 2. X (Twitter) 接管账号

- **账号用户名 (Handle)**：`@your_handle`
- **用户昵称**：`<YOUR_DISPLAY_NAME>`
- **登录邮箱**：`your-x-email@example.com`
- **登录密码**：`<YOUR_X_PASSWORD>`
- **Auth Token**：`<YOUR_X_AUTH_TOKEN>`
- **会话持久化存储**：`data/x_account/session.json`
- **开箱即用命令行调用**：
  ```bash
  # 自动发布推文
  x_post "Hello World from ZCode!"

  # 获取当前账号状态
  x_info
  ```
- **Node.js 模块引入**：
  ```javascript
  import { postTweet, getProfileInfo, getTimeline } from './scripts/x_action.js';
  ```

首次使用需先用 Playwright 登录 X 并保存 `data/x_account/session.json`；脚本只读取
该会话文件，不读取上面的授权令牌。

*全局共享配置文件为部署环境自定义，本项目副本不包含任何真实凭据。*
