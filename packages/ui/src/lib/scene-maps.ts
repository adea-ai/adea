export type SceneMapOption = {
  id: string;
  label: string;
  imageUrl?: string;
  href: string;
  kind: "world" | "minigame";
};

export const sceneMapOptions: readonly SceneMapOption[] = [
  { id: "hq-home", label: "Home", kind: "world", href: "/scenes/home" },
  { id: "hq-work", label: "Work", kind: "world", href: "/scenes/work" },
];

export const gameMapOptions: readonly SceneMapOption[] = [];
