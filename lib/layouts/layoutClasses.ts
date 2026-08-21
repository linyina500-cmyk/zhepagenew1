import type { LayoutStyleKey } from "./layoutTypes";

export function layoutClassName(layoutStyle: LayoutStyleKey) {
  return `layout-${layoutStyle}`;
}
