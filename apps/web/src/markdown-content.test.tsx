import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownLoader, MarkdownContent } from "./markdown-content.js";

function Renderer() {
  return <p>Rendered markdown</p>;
}

describe("deferred markdown rendering", () => {
  it("loads on demand and shares the in-flight request and resolved renderer", async () => {
    let resolve!: (renderer: typeof Renderer) => void;
    const imported = new Promise<typeof Renderer>((done) => { resolve = done; });
    const importRenderer = vi.fn(() => imported);
    const loader = createMarkdownLoader(importRenderer);
    const onLoaded = vi.fn();
    const unsubscribe = loader.subscribe(onLoaded);
    expect(importRenderer).not.toHaveBeenCalled();
    expect(loader.current()).toBeNull();

    const first = loader.load();
    const second = loader.load();
    expect(second).toBe(first);
    expect(importRenderer).toHaveBeenCalledTimes(1);
    expect(onLoaded).not.toHaveBeenCalled();
    resolve(Renderer);
    await expect(first).resolves.toBe(Renderer);
    expect(loader.current()).toBe(Renderer);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    await expect(loader.load()).resolves.toBe(Renderer);
    expect(importRenderer).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("allows a failed chunk request to retry without retaining a rejected promise", async () => {
    const importRenderer = vi.fn()
      .mockRejectedValueOnce(new Error("temporarily offline"))
      .mockResolvedValueOnce(Renderer);
    const loader = createMarkdownLoader(importRenderer);
    const firstView = vi.fn();
    const secondView = vi.fn();
    const unmountedView = vi.fn();
    loader.subscribe(firstView);
    loader.subscribe(secondView);
    loader.subscribe(unmountedView)();
    await expect(loader.load()).rejects.toThrow("temporarily offline");
    expect(loader.current()).toBeNull();
    expect(firstView).not.toHaveBeenCalled();
    await expect(loader.load()).resolves.toBe(Renderer);
    expect(loader.current()).toBe(Renderer);
    expect(importRenderer).toHaveBeenCalledTimes(2);
    expect(firstView).toHaveBeenCalledTimes(1);
    expect(secondView).toHaveBeenCalledTimes(1);
    expect(unmountedView).not.toHaveBeenCalled();
  });

  it("keeps the complete source readable and HTML-escaped before the renderer loads", () => {
    const markup = renderToStaticMarkup(<MarkdownContent skipHtml>
      {"# Report\n\n<script>alert('unsafe')</script>\n\nFinal paragraph"}
    </MarkdownContent>);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("white-space:pre-wrap");
    expect(markup).toContain("# Report");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("Final paragraph");
    expect(markup).not.toContain("<script>");
  });
});
