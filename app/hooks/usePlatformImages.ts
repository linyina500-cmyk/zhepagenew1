"use client";

import { useEffect, useState } from "react";
import { adaptDraftImages } from "../../lib/draftSync/adaptImages";
import { renderRiskPage, type RiskNote, type RiskAppearance } from "../../lib/draftSync/riskPage";
import type { DraftImage, DraftPlatform } from "../../lib/draftSync/types";

type BaseImages = { source: DraftImage[]; platform: DraftPlatform; images: DraftImage[] | null; error: string };
type Prepared = { base: DraftImage[]; note?: RiskNote; appearance?: RiskAppearance; images: DraftImage[] | null; error: string };
const message = (error: unknown) => error instanceof Error ? error.message : "图片准备失败，请重新生成图片后再试。";

export function usePlatformImages(source: DraftImage[] | undefined, platform: DraftPlatform, note?: RiskNote, appearance?: RiskAppearance): { images: DraftImage[] | null; preparing: boolean; error: string } {
  const [base, setBase] = useState<BaseImages | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return adaptDraftImages(source, platform, controller.signal);
    }).then((images) => {
      if (active && !controller.signal.aborted) setBase({ source, platform, images, error: "" });
    }, (error) => {
      if (active && !controller.signal.aborted) setBase({ source, platform, images: null, error: message(error) });
    });
    return () => { active = false; controller.abort(); };
  }, [source, platform]);

  const currentBase = base && base.source === source && base.platform === platform ? base : null;
  const baseImages = currentBase?.images;
  useEffect(() => {
    if (!baseImages) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      if (!note?.enabled) return [...baseImages];
      if (!appearance) throw new Error("风险提示样式尚未准备好，请重新生成图片。");
      const risk = await renderRiskPage(note, appearance, platform, controller.signal);
      controller.signal.throwIfAborted();
      return risk ? [...baseImages, risk] : [...baseImages];
    }).then((images) => {
      if (active && !controller.signal.aborted) setPrepared({ base: baseImages, note, appearance, images, error: "" });
    }, (error) => {
      if (active && !controller.signal.aborted) setPrepared({ base: baseImages, note, appearance, images: null, error: message(error) });
    });
    return () => { active = false; controller.abort(); };
  }, [baseImages, platform, note, appearance]);

  // Match during render, before the next effect runs: an older image set must
  // never stay actionable for even one render after its source or risk changes.
  if (!source) return { images: null, preparing: false, error: "" };
  if (currentBase?.error) return { images: null, preparing: false, error: currentBase.error };
  if (!baseImages || prepared?.base !== baseImages || prepared.note !== note || prepared.appearance !== appearance) return { images: null, preparing: true, error: "" };
  return { images: prepared.images, preparing: false, error: prepared.error };
}
