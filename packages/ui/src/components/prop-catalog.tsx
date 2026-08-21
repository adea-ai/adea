"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Archive,
  Armchair,
  BedDouble,
  ChevronLeft,
  ChevronRight,
  Image,
  LampDesk,
  Leaf,
  PackageOpen,
  PanelTop,
  Sprout,
  Tv,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Card } from "./ui/card";
import { cn } from "../lib/utils";

export type PropCatalogItem = {
  id: string;
  label: string;
  assetUrl: string;
  category: string;
  /** Restrict placement to a floor or a wall surface. */
  placementSurface?: "floor" | "wall";
  /** Authored wall-mount height for wall-only props. */
  wallMountHeight?: number;
  /** Render the placement footprint as a circle instead of an AABB. */
  footprintShape?: "rectangle" | "circle";
  /** Small authored lift used to keep floor props off coplanar surfaces. */
  floorLift?: number;
  /** Allow other floor props to be placed on this surface. */
  allowItemsOnTop?: boolean;
  /** Allow this floor prop to be placed underneath existing furniture. */
  canOverlapFurniture?: boolean;
  /** Keep rugs from covering this floor decoration. */
  blocksRugOverlap?: boolean;
  /** Top surface height in authored units (tables, counters). */
  surfaceHeight?: number;
  /** Small item that stacks on surfaces with surfaceHeight. */
  placeableOnTop?: boolean;
  /** Yaw that presents the asset's authored front to the viewer. */
  frontYaw?: number;
  /** Legacy thumbnail/placement yaw used by callers that have not migrated. */
  defaultYaw?: number;
};

export type PropCatalogCategory = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Additional category ids that should also appear under this tab. */
  also?: readonly string[];
};

export const defaultPropCatalogCategories: readonly PropCatalogCategory[] = [
  { id: "seating", label: "Seating", icon: Armchair },
  { id: "tables", label: "Tables", icon: PanelTop },
  { id: "bedroom", label: "Bedroom", icon: BedDouble },
  { id: "storage", label: "Storage", icon: Archive },
  { id: "lighting", label: "Lighting", icon: LampDesk },
  { id: "electronics", label: "Electronics", icon: Tv },
  { id: "plants", label: "Plants", icon: Sprout },
  { id: "wall-decor", label: "Wall decor", icon: Image },
  { id: "drinks", label: "Food & Drinks", icon: Utensils, also: ["food"] },
  { id: "other", label: "Other", icon: PackageOpen },
];

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

// --- Thumbnail infrastructure ------------------------------------------------

// Shared singleton renderer + canvas for all thumbnails.
let thumbnailRenderer: THREE.WebGLRenderer | null = null;
let thumbnailRendererCanvas: HTMLCanvasElement | null = null;
// Shared singleton GLTFLoader so the browser can reuse connections and
// the loader can cache parsed resources internally. Exported so the
// room designer can reuse the same loader instance and avoid duplicate
// GLB fetches/parse work.
let sharedLoader: GLTFLoader | null = null;
export function getSharedLoader(): GLTFLoader {
  if (!sharedLoader) sharedLoader = new GLTFLoader();
  return sharedLoader;
}

// Cache of rendered thumbnail data URLs keyed by asset URL + yaw.
// Survives category switches and drawer re-opens so thumbnails only
// render once per session.
const thumbnailDataCache = new Map<string, string>();
// Track in-flight load+render promises so concurrent mounts share one.
const thumbnailPromiseCache = new Map<string, Promise<string>>();

function thumbnailCacheKey(item: PropCatalogItem): string {
  return `${item.assetUrl}|${item.frontYaw ?? item.defaultYaw ?? 0}`;
}

type ThumbnailRenderJob = {
  item: PropCatalogItem;
  source: THREE.Object3D;
};

function renderThumbnailToDataURL(job: ThumbnailRenderJob): string {
  if (!thumbnailRendererCanvas) thumbnailRendererCanvas = document.createElement("canvas");
  if (!thumbnailRenderer) {
    thumbnailRenderer = new THREE.WebGLRenderer({
      canvas: thumbnailRendererCanvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    thumbnailRenderer.setPixelRatio(1);
    thumbnailRenderer.setSize(96, 96, false);
    thumbnailRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(2, 4, 3);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  const model = job.source;
  model.rotation.y = job.item.frontYaw ?? job.item.defaultYaw ?? 0;
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.sub(center);
  const extent = Math.max(size.x, size.y, size.z, 0.25);
  camera.position.set(extent * 2.25, extent * 1.55, -extent * 2.25);
  camera.lookAt(0, Math.max(size.y * 0.12, 0), 0);
  scene.add(model);
  thumbnailRenderer.render(scene, camera);
  // JPEG is ~5x faster to encode than PNG and produces smaller data URLs,
  // which speeds up both the toDataURL call and the subsequent img.src load.
  const dataUrl = thumbnailRendererCanvas.toDataURL("image/jpeg", 0.85);
  scene.remove(model);
  disposeObject(model);
  return dataUrl;
}

/**
 * Yield to the event loop so the browser can process user input between
 * thumbnail renders. Without this, a queue of N renders executes as one
 * synchronous batch (microtask drain) and blocks the main thread.
 */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Sequential render queue. Each render waits for one animation frame before
 * executing, keeping the UI responsive even when many thumbnails are queued.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function scheduleRender(render: () => string): Promise<string> {
  const result = renderQueue.then(async () => {
    await nextFrame();
    return render();
  });
  renderQueue = result;
  return result;
}

/**
 * Load a GLB and render a thumbnail, returning a data URL.
 * Results are cached so repeated mounts (category switches, drawer re-opens)
 * skip the fetch + render entirely. Concurrent mounts for the same asset
 * share a single in-flight promise.
 *
 * GLB loads are concurrency-limited to avoid firing 50+ simultaneous HTTP
 * requests when a category with many items becomes visible. The render
 * queue (scheduleRender) already serializes the sync WebGL renders, but
 * the async GLB fetches were all fired at once.
 */
const MAX_CONCURRENT_THUMBNAIL_LOADS = 6;
let activeThumbnailLoads = 0;
const pendingThumbnailLoads: Array<() => void> = [];

function dequeueThumbnailLoad(): void {
  if (activeThumbnailLoads >= MAX_CONCURRENT_THUMBNAIL_LOADS) return;
  const next = pendingThumbnailLoads.shift();
  if (!next) return;
  activeThumbnailLoads++;
  next();
}

function getThumbnail(item: PropCatalogItem): Promise<string> {
  const key = thumbnailCacheKey(item);
  const cached = thumbnailDataCache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = thumbnailPromiseCache.get(key);
  if (existing) return existing;
  const promise = new Promise<string>((resolve, reject) => {
    const run = () => {
      getSharedLoader()
        .loadAsync(item.assetUrl)
        .then(({ scene: source }) => {
          activeThumbnailLoads--;
          dequeueThumbnailLoad();
          // The GLB parse is async, but the WebGL render + toDataURL is sync.
          // Schedule the sync part in an animation frame so it doesn't block.
          return scheduleRender(() => {
            const dataUrl = renderThumbnailToDataURL({ item, source });
            thumbnailDataCache.set(key, dataUrl);
            thumbnailPromiseCache.delete(key);
            return dataUrl;
          });
        })
        .then(resolve)
        .catch((error) => {
          activeThumbnailLoads--;
          dequeueThumbnailLoad();
          reject(error);
        });
    };
    pendingThumbnailLoads.push(run);
    dequeueThumbnailLoad();
  });
  thumbnailPromiseCache.set(key, promise);
  return promise;
}

const ModelThumbnail = memo(function ModelThumbnail({ item }: { item: PropCatalogItem }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // Use a rootMargin so items slightly below the fold start loading
    // before the user scrolls to them, making scroll feel instant.
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(Boolean(entry?.isIntersecting));
      },
      { rootMargin: "200px" },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    void getThumbnail(item)
      .then((dataUrl) => {
        if (cancelled) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const img = document.createElement("img");
        img.onload = () => {
          if (cancelled) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = dataUrl;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [item, visible]);

  return (
    <div
      ref={wrapperRef}
      className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted/60"
    >
      <canvas
        ref={canvasRef}
        width={96}
        height={96}
        className={cn("h-full w-full transition-opacity", failed ? "opacity-0" : "opacity-100")}
        aria-hidden="true"
      />
      {failed ? <Leaf className="size-7 text-muted-foreground" aria-hidden="true" /> : null}
      <span className="pointer-events-none absolute inset-x-1 bottom-1 truncate rounded bg-background/55 px-1.5 py-1 text-center text-[10px] font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {item.label}
      </span>
    </div>
  );
});

export type PropCatalogProps = {
  items: readonly PropCatalogItem[];
  selectedId?: string | null;
  categories?: readonly PropCatalogCategory[];
  className?: string;
  onItemPointerDown?: (item: PropCatalogItem, event: ReactPointerEvent<HTMLButtonElement>) => void;
};

export function PropCatalog({
  items,
  selectedId = null,
  categories = defaultPropCatalogCategories,
  className,
  onItemPointerDown,
}: PropCatalogProps) {
  const [activeCategory, setActiveCategory] = useState(categories[0]?.id ?? "seating");
  const [hoveredCategory, setHoveredCategory] = useState<{ id: string; left: number } | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const categoryBarRef = useRef<HTMLDivElement>(null);
  const visibleItems = useMemo(() => {
    const category = categories.find((c) => c.id === activeCategory);
    const ids = category?.also ? [activeCategory, ...category.also] : [activeCategory];
    const idSet = new Set(ids);
    return items.filter((item) => idSet.has(item.category));
  }, [activeCategory, categories, items]);

  const updateCategoryScroll = () => {
    const element = categoryScrollRef.current;
    if (!element) return;
    setCanScrollLeft(element.scrollLeft > 1);
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    setHoveredCategory(null);
  };

  useEffect(() => {
    updateCategoryScroll();
    const element = categoryScrollRef.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateCategoryScroll);
    observer?.observe(element);
    element.addEventListener("scroll", updateCategoryScroll, { passive: true });
    return () => {
      observer?.disconnect();
      element.removeEventListener("scroll", updateCategoryScroll);
    };
  }, [categories.length]);

  const scrollCategories = (direction: "left" | "right") => {
    const element = categoryScrollRef.current;
    if (!element) return;
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollTo({ left: direction === "left" ? 0 : maxScrollLeft, behavior: "auto" });
    // The left arrow becomes visible after the first rightward scroll, which
    // can reduce the viewport by one button width. Re-read the final extent
    // after that layout update so the last category is never stranded.
    if (direction === "right") {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const finalMaxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
          element.scrollTo({ left: finalMaxScrollLeft, behavior: "auto" });
        }),
      );
    }
  };

  const setCategoryHover = (id: string, target: HTMLElement) => {
    const bar = categoryBarRef.current;
    if (!bar) return;
    const targetRect = target.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    setHoveredCategory({ id, left: targetRect.left + targetRect.width / 2 - barRect.left });
  };

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)} aria-label="Prop catalog">
      <div
        ref={categoryBarRef}
        className="relative shrink-0 pb-1"
        role="tablist"
        aria-label="Prop categories"
      >
        {canScrollLeft ? (
          <span
            aria-hidden="true"
            className="absolute left-0 top-0 z-10 size-8 rounded-md bg-background"
          />
        ) : null}
        <button
          type="button"
          tabIndex={canScrollLeft ? 0 : -1}
          aria-hidden={!canScrollLeft}
          className={cn(
            "absolute left-0 top-0 z-20 flex size-8 items-center justify-center rounded-md bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground",
            !canScrollLeft ? "pointer-events-none invisible" : null,
          )}
          aria-label="Scroll categories left"
          onClick={() => scrollCategories("left")}
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        <div
          ref={categoryScrollRef}
          className="w-full overflow-x-auto overflow-y-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex min-w-max gap-1">
            {categories.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={activeCategory === id}
                className={cn(
                  "group/category relative flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/30 text-muted-foreground transition-colors hover:border-primary/70 hover:bg-accent/70 hover:text-accent-foreground",
                  activeCategory === id ? "border-primary bg-accent text-accent-foreground" : null,
                )}
                onClick={() => setActiveCategory(id)}
                onMouseEnter={(event) => setCategoryHover(id, event.currentTarget)}
                onMouseLeave={() => setHoveredCategory(null)}
                onFocus={(event) => setCategoryHover(id, event.currentTarget)}
                onBlur={() => setHoveredCategory(null)}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        {canScrollRight ? (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 z-10 size-8 rounded-md bg-background"
          />
        ) : null}
        <button
          type="button"
          tabIndex={canScrollRight ? 0 : -1}
          aria-hidden={!canScrollRight}
          className={cn(
            "absolute right-0 top-0 z-20 flex size-8 items-center justify-center rounded-md bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground",
            !canScrollRight ? "pointer-events-none invisible" : null,
          )}
          aria-label="Scroll categories right"
          onClick={() => scrollCategories("right")}
        >
          <ChevronRight className="size-5" aria-hidden="true" />
        </button>
        {hoveredCategory ? (
          <div
            className="pointer-events-none absolute top-full z-20 mt-1 rounded bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-md backdrop-blur-sm"
            style={{ left: hoveredCategory.left, transform: "translateX(-50%)" }}
          >
            {categories.find((category) => category.id === hoveredCategory.id)?.label}
          </div>
        ) : null}
      </div>
      {visibleItems.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1" role="tabpanel">
          <div className="grid grid-cols-3 gap-2">
            {visibleItems.map((item) => (
              <Card
                key={item.id}
                className={cn(
                  "group overflow-hidden border-border bg-card/60 p-1 transition-colors",
                  selectedId === item.id
                    ? "border-primary bg-accent/70"
                    : "hover:border-primary/50 hover:bg-accent/40",
                )}
              >
                <button
                  type="button"
                  aria-label={`Add ${item.label}`}
                  className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onItemPointerDown?.(item, event);
                  }}
                >
                  <ModelThumbnail item={item} />
                  <span className="sr-only">{item.label}</span>
                </button>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
          No props in this category yet.
        </p>
      )}
    </div>
  );
}
