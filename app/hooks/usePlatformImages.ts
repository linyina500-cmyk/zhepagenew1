"use client";

import { useEffect, useState } from "react";
import { adaptDraftImages } from "../../lib/draftSync/adaptImages";
import { renderRiskPage, type RiskNote } from "../../lib/draftSync/riskPage";
import type { DraftImage, DraftPlatform } from "../../lib/draftSync/types";

type BaseImages = { source: DraftImage[]; platform: DraftPlatform; images: DraftImage[] | null; error: string };
type Prepared = { base: DraftImage[]; note: RiskNote; images: DraftImage[] | null; error: string };
const message = (error: unknown) => error instanceof Error ? error.message : "图片准备失败，请重新生成图片后再试。";

export function usePlatformImages(source: DraftImage[] | undefined, platform: DraftPlatform, note?: RiskNote, confirmed = false): { images: DraftImage[] | null; preparing: boolean; error: string } {
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
    if (!baseImages || !source || !note || !confirmed) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const last = source.at(-1);
      if (!last?.riskTemplate) throw new Error("这份图片没有可编辑的末页，请返回编辑器，用当前海报重新生成。");
      const lastPage = await renderRiskPage(note, last, controller.signal);
      controller.signal.throwIfAborted();
      const [adapted] = await adaptDraftImages([lastPage], platform, controller.signal);
      controller.signal.throwIfAborted();
      return [...baseImages.slice(0, -1), adapted];
    }).then((images) => {
      if (active && !controller.signal.aborted) setPrepared({ base: baseImages, note, images, error: "" });
    }, (error) => {
      if (active && !controller.signal.aborted) setPrepared({ base: baseImages, note, images: null, error: message(error) });
    });
    return () => { active = false; controller.abort(); };
  }, [baseImages, source, platform, note, confirmed]);

  // Before confirmation show original pages. Rendering the selected platform's
  // risk text starts only after approval, and replaces exactly the existing last page.
  if (!source) return { images: null, preparing: false, error: "" };
  if (currentBase?.error) return { images: null, preparing: false, error: currentBase.error };
  if (!baseImages) return { images: null, preparing: true, error: "" };
  if (!note || !confirmed) return { images: baseImages, preparing: false, error: "" };
  if (prepared?.base !== baseImages || prepared.note !== note) return { images: null, preparing: true, error: "" };
  return { images: prepared.images, preparing: false, error: prepared.error };
}
