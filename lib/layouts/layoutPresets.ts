import type { LayoutPreset, LayoutStyleKey } from "./layoutTypes";

export const LAYOUT_STYLE_KEYS: LayoutStyleKey[] = [
  "xiaohongshu",
  "financeDeepRead",
  "dataIndex",
  "cleanNews",
  "keyCards",
];

export const LAYOUT_PRESETS: Record<LayoutStyleKey, LayoutPreset> = {
  xiaohongshu: {
    key: "xiaohongshu",
    name: "小红书",
    detail: "大字醒目，适合直接发图",
    coverLabel: "SOCIAL EDITORIAL / 01",
    coverBadge: "长文拆解",
    typeScale: 1,
    lineHeight: 1.72,
    bottomReserve: 0,
  },
  financeDeepRead: {
    key: "financeDeepRead",
    name: "财经深读",
    detail: "层级清晰，适合财经长文",
    recommended: true,
    coverLabel: "MARKET INSIGHT / 01",
    coverBadge: "产业逻辑 · 数据验证 · 核心方向",
    typeScale: 1.04,
    lineHeight: 1.78,
    bottomReserve: 0,
  },
  dataIndex: {
    key: "dataIndex",
    name: "数据索引",
    detail: "突出数字，适合逻辑梳理",
    coverLabel: "DATA INDEX / 2026",
    coverBadge: "关键数据 · 逻辑索引",
    typeScale: 1,
    lineHeight: 1.72,
    bottomReserve: 0,
  },
  cleanNews: {
    key: "cleanNews",
    name: "简洁资讯",
    detail: "少装饰，适合新闻观点",
    coverLabel: "NEWS BRIEF / 01",
    coverBadge: "事实 · 观点 · 判断",
    typeScale: 1.04,
    lineHeight: 1.84,
    bottomReserve: 20,
  },
  keyCards: {
    key: "keyCards",
    name: "重点卡片",
    detail: "模块明显，适合知识点拆解",
    coverLabel: "KEY TAKEAWAYS / 01",
    coverBadge: "3 个核心信号",
    typeScale: 1,
    lineHeight: 1.74,
    bottomReserve: 0,
  },
};
