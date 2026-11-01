export function setVisibleInterval(callback: () => void, delay: number): number {
  return window.setInterval(() => {
    if (document.visibilityState === "visible") callback();
  }, delay);
}
