import { useEffect, useState, useSyncExternalStore } from "react";
import type { Options } from "react-markdown";

type MarkdownRenderer = typeof import("react-markdown")["default"];

export function createMarkdownLoader(importRenderer: () => Promise<MarkdownRenderer>) {
  let cachedRenderer: MarkdownRenderer | null = null;
  let rendererPromise: Promise<MarkdownRenderer> | null = null;
  const listeners = new Set<() => void>();
  return {
    current: () => cachedRenderer,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load() {
      if (!rendererPromise) {
        rendererPromise = importRenderer()
          .then((renderer) => {
            cachedRenderer = renderer;
            for (const listener of listeners) listener();
            return renderer;
          })
          .catch((error: unknown) => {
            rendererPromise = null;
            throw error;
          });
      }
      return rendererPromise;
    },
  };
}

const markdownLoader = createMarkdownLoader(() => import("react-markdown").then((module) => module.default));

// Reports and release notes share one deferred parser. A failed chunk request
// keeps the escaped source readable and can be retried without leaving the page.
export function MarkdownContent(props: Readonly<Options>) {
  const Renderer = useSyncExternalStore(markdownLoader.subscribe, markdownLoader.current, markdownLoader.current);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (Renderer) return;
    let active = true;
    void markdownLoader.load()
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [Renderer, attempt]);

  if (Renderer) return <Renderer {...props} />;
  return <div aria-busy={!failed}>
    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{props.children}</div>
    {failed && <p className="muted">正文排版暂时不可用，已显示原文。 <button className="secondary small" type="button" onClick={() => {
      setFailed(false);
      setAttempt((value) => value + 1);
    }}>重新加载排版</button></p>}
  </div>;
}
