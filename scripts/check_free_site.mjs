// 检查候选站点是否真的提供免费服务器：抓首页/定价页，看关键词与可访问性
import { execFileSync } from "child_process";

const hosts = process.argv.slice(2);
const NEEDLES = [
  "free", "free tier", "always free", "vps", "cloud server", "instance",
  "免费", "白嫖", "试用",
];

function fetch(url) {
  try {
    const out = execFileSync("curl", [
      "-sSL", "--compressed", "-m", "25", "-k",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "-w", "\n__HTTP__%{http_code}__FINAL__%{url_effective}",
      url,
    ], { maxBuffer: 6 * 1024 * 1024, encoding: "utf8" });
    const i = out.lastIndexOf("\n__HTTP__");
    const body = i < 0 ? out : out.slice(0, i);
    const meta = i < 0 ? "" : out.slice(i + 1);
    return { body, meta };
  } catch (e) {
    return { body: "", meta: `ERR ${e.message.slice(0, 80)}` };
  }
}

for (const host of hosts) {
  const url = host.startsWith("http") ? host : `https://${host}`;
  const { body, meta } = fetch(url);
  const title = (body.match(/<title[^>]*>([\s\S]{0,160}?)<\/title>/i) || [])[1] || "";
  const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const hits = NEEDLES.filter((n) => lower.includes(n));
  const freeCtx = [];
  for (const m of text.matchAll(/[^.]{0,90}\b(free tier|always free|免费|for free|free trial|100%\s*free)\b[^.]{0,90}/gi)) {
    freeCtx.push(m[0].trim());
    if (freeCtx.length >= 4) break;
  }
  console.log(`\n##### ${host}`);
  console.log(`  ${meta}`);
  console.log(`  title: ${title.trim().slice(0, 120)}`);
  console.log(`  bytes: ${body.length}  keywords: ${hits.join(", ")}`);
  for (const c of freeCtx) console.log(`   · ${c.slice(0, 180)}`);
}
