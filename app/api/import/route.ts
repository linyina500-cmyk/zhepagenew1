import { NextResponse } from "next/server";

const MAX_HTML_BYTES = 6 * 1024 * 1024;

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":") || host === "0.0.0.0" || host === "127.0.0.1") return false;
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchPublicHtml(initialUrl: string) {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("无效跳转");
      const nextUrl = new URL(location, currentUrl).href;
      if (!isPublicHttpUrl(nextUrl)) throw new Error("不安全跳转");
      currentUrl = nextUrl;
      continue;
    }
    return { response, finalUrl: currentUrl };
  }
  throw new Error("跳转次数过多");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    if (!body.url || !isPublicHttpUrl(body.url)) return NextResponse.json({ error: "请输入有效的公开文章地址" }, { status: 400 });

    const { response, finalUrl } = await fetchPublicHtml(body.url);
    if (!response.ok) return NextResponse.json({ error: `文章站点返回 ${response.status}` }, { status: 502 });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return NextResponse.json({ error: "这个地址不是可识别的网页文章" }, { status: 415 });
    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) return NextResponse.json({ error: "文章内容过大，请改用 HTML 粘贴" }, { status: 413 });
    return NextResponse.json({ html, finalUrl });
  } catch {
    return NextResponse.json({ error: "暂时无法读取该文章，请尝试粘贴 HTML" }, { status: 502 });
  }
}
