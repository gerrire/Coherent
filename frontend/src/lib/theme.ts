import { invoke, isTauri } from "@tauri-apps/api/core";
export type ThemeName = "purple" | "black" | "gray" | "white" | "navy" | "green";

export const themes: Array<{ id: ThemeName; label: string; color: string }> = [
  { id: "purple", label: "Фиолетовая", color: "#7739dc" },
  { id: "black", label: "Чёрная", color: "#24242b" },
  { id: "gray", label: "Серая", color: "#667080" },
  { id: "white", label: "Белая", color: "#eef1f5" },
  { id: "navy", label: "Тёмно-синяя", color: "#3159a5" },
  { id: "green", label: "Тёмно-зелёная", color: "#27735b" },
];

const storageKey = "coherent.theme";

export function loadTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(storageKey);
    return themes.find((theme) => theme.id === saved)?.id ?? "purple";
  } catch {
    return "purple";
  }
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(storageKey, theme); } catch { /* Private browsing can block storage. */ }
  if (isTauri() && !new URLSearchParams(location.search).has("window")) {
    void invoke("desktop_theme_set", { theme }).catch(() => undefined);
  }
}
