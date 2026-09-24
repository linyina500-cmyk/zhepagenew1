import type { RiskNote } from "./riskPage";
export type DraftPlatform = "xiaohongshu" | "wechat";
export type DraftContent = { title: string; body: string };
export type DraftImage = { id: string; name: string; blob: Blob; width: number; height: number; riskTemplate?: { svg: string } };
export type SyncReceipt = {
  accountId: string;
  platform: DraftPlatform;
  // Only provider-verified saves use "saved"; manual checks remain explicit.
  status: "saved" | "confirmed_by_user" | "needs_confirmation" | "failed";
  message: string;
  draftId?: string;
  jobId?: string;
  contentHash?: string;
  publicationAttempted?: true;
  url?: string;
};
export type LocalDraft = {
  schemaVersion: 1;
  id: string;
  updatedAt: string;
  sourceFormat: string;
  images: DraftImage[];
  risk?: { notes: Record<DraftPlatform, RiskNote> };
  content: Record<DraftPlatform, DraftContent>;
  selectedAccountIds: string[];
  receipts: SyncReceipt[];
};
export type ImageMetadata = { id?: string; name: string; width: number; height: number; size: number; mime: string };
export type DraftIssue = { severity: "error" | "warning"; code: string; message: string; imageId?: string };
