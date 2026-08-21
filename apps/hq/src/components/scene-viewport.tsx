"use client";

import { useEffect, useRef } from "react";

import { createSceneController } from "@agent-hq/scene-runtime";

export function SceneViewport() {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const controller = createSceneController();
    controller.mount(viewport);

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;

      controller.resize(entry.contentRect.width, entry.contentRect.height, window.devicePixelRatio);
    });
    resizeObserver.observe(viewport);

    let animationFrame = 0;
    const renderFrame = () => {
      controller.render();
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    renderFrame();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controller.dispose();
    };
  }, []);

  return (
    <div
      ref={viewportRef}
      aria-label="Spatial workspace scene"
      className="scene-viewport"
      role="img"
    >
      <div className="scene-viewport__overlay" aria-hidden="true">
        <span className="scene-viewport__grid-label">LIVE SPATIAL VIEW</span>
        <span className="scene-viewport__coordinates">X 14.2 / Y 08.6 / Z 03.1</span>
      </div>
    </div>
  );
}
