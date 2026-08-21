const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function isPublicImageUrl(value: string) {
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

async function fetchPublicImage(initialUrl: string) {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetch(currentUrl, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("无效跳转");
      const nextUrl = new URL(location, currentUrl).href;
      if (!isPublicImageUrl(nextUrl)) throw new Error("不安全跳转");
      currentUrl = nextUrl;
      continue;
    }
    return response;
  }
  throw new Error("跳转次数过多");
}

export const onRequestGet = async (context: { request: Request }) => {
  const source = new URL(context.request.url).searchParams.get("url") || "";
  if (!isPublicImageUrl(source)) return json({ error: "无效图片地址" }, 400);
  try {
    const response = await fetchPublicImage(source);
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.startsWith("image/")) return json({ error: "图片读取失败" }, 502);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) return json({ error: "图片过大" }, 413);
    return new Response(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=604800",
      },
    });
  } catch {
    return json({ error: "图片读取失败" }, 502);
  }
};
