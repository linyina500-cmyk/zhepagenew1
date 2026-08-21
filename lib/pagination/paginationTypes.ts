export type PageUtilizationStatus = "sparse" | "balanced" | "full";

export type PaginationResult = {
  pages: string[];
  usage: number[];
};

export function utilizationStatus(value: number): PageUtilizationStatus {
  if (value < 0.6) return "sparse";
  if (value > 0.96) return "full";
  return "balanced";
}
