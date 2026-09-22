import type { LocalDraft } from "../draftSync/types";
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
/** Match the ordered original images and copy to the draft the user approved. */
export async function wechatContentHash(draft: LocalDraft): Promise<string> {
  const images = [];
  for (const image of draft.images) images.push(hex(await crypto.subtle.digest("SHA-256", await image.blob.arrayBuffer())));
  const content = { title: draft.content.wechat.title.trim(), body: draft.content.wechat.body.replace(/\r\n?/gu, "\n"), images };
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content))));
}
