import { describe, expect, it, vi } from "vitest";

import { createSceneController } from "./scene-controller";

describe("createSceneController", () => {
  it("owns the Three.js lifecycle behind a small controller boundary", () => {
    const canvas = {} as HTMLCanvasElement;
    const container = {
      appendChild: vi.fn(),
      contains: vi.fn(() => true),
      removeChild: vi.fn(),
    } as unknown as HTMLElement;
    const renderer = {
      domElement: canvas,
      dispose: vi.fn(),
      render: vi.fn(),
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
    };
    const controller = createSceneController({
      canvasFactory: () => canvas,
      rendererFactory: () => renderer,
    });

    controller.mount(container);
    controller.resize(320, 180, 3);
    controller.render();

    expect(controller.getState()).toMatchObject({
      mounted: true,
      width: 320,
      height: 180,
      pixelRatio: 2,
    });
    expect(container.appendChild).toHaveBeenCalledWith(canvas);
    expect(renderer.setSize).toHaveBeenCalledWith(320, 180, false);
    expect(renderer.render).toHaveBeenCalledOnce();

    controller.dispose();

    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(container.removeChild).toHaveBeenCalledWith(canvas);
    expect(controller.getState().mounted).toBe(false);
  });
});
