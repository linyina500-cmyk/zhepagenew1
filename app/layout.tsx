import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const imageUrl = new URL("/og-zhepage.png", base).href;
  return {
    title: "折页 · 长文贴图生成器",
    description: "导入文章链接、HTML 或富文本，保留原排版并自动生成适合小红书与公众号发布的高清贴图。",
    metadataBase: base,
    openGraph: {
      title: "折页 · 把长内容拆解成富文本图片",
      description: "保留 HTML 排版，自动分页，一键导出高清社交贴图。",
      images: [{ url: imageUrl, width: 1536, height: 1024, alt: "折页长文贴图生成器" }],
    },
    twitter: { card: "summary_large_image", images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
