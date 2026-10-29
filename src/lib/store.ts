import { create } from "zustand";
import { DEFAULT_TEMPLATE_ID } from "../templates";
export type Step =
  "welcome" | "selfie" | "selfieReview" | "product" | "edit" | "result";
export type Adjustment = { x: number; y: number; zoom: number };
export type Photo = {
  id: string;
  image: HTMLImageElement;
  blob: Blob;
  url: string;
  adjust: Adjustment;
  label: string;
};
export type Layout = "card" | "spotlight" | "gallery";
export const initialAdjustment = (): Adjustment => ({ x: 0, y: 0, zoom: 1 });
export const MAX_PRODUCTS = 5;
interface State {
  step: Step;
  template: string;
  selfie: Photo | null;
  products: Photo[];
  logo: Photo | null;
  layout: Layout;
  savedPoster: Blob | null;
  setSavedPoster: (poster: Blob | null) => void;
  setStep: (step: Step) => void;
  setTemplate: (id: string) => void;
  setSelfie: (p: Photo | null) => void;
  addProduct: (p: Photo) => void;
  removeProduct: (id: string) => void;
  updatePhoto: (id: string, a: Partial<Adjustment>) => void;
  setLabel: (id: string, label: string) => void;
  setLogo: (p: Photo | null) => void;
  setLayout: (l: Layout) => void;
  reset: () => void;
}
function release(p: Photo | null) {
  if (p) URL.revokeObjectURL(p.url);
}
export const useStudio = create<State>((set, get) => ({
  step: "selfie",
  template: DEFAULT_TEMPLATE_ID,
  selfie: null,
  products: [],
  logo: null,
  layout: "card",
  savedPoster: null,
  setSavedPoster: (savedPoster) => set({ savedPoster }),
  setStep: (step) => set({ step }),
  setTemplate: (template) => set({ template, savedPoster: null }),
  setSelfie: (p) => {
    release(get().selfie);
    set({ selfie: p, savedPoster: null });
  },
  addProduct: (p) => {
    if (get().products.length < MAX_PRODUCTS)
      set({ products: [...get().products, p], savedPoster: null });
    else release(p);
  },
  removeProduct: (id) => {
    release(get().products.find((p) => p.id === id) ?? null);
    set({
      products: get().products.filter((p) => p.id !== id),
      savedPoster: null,
    });
  },
  updatePhoto: (id, a) =>
    set((s) => ({
      savedPoster: null,
      selfie:
        s.selfie?.id === id
          ? { ...s.selfie, adjust: { ...s.selfie.adjust, ...a } }
          : s.selfie,
      products: s.products.map((p) =>
        p.id === id ? { ...p, adjust: { ...p.adjust, ...a } } : p,
      ),
    })),
  setLabel: (id, label) =>
    set((s) => ({
      savedPoster: null,
      products: s.products.map((p) =>
        p.id === id ? { ...p, label: label.slice(0, 36) } : p,
      ),
    })),
  setLogo: (p) => {
    release(get().logo);
    set({ logo: p });
  },
  setLayout: (layout) => set({ layout, savedPoster: null }),
  reset: () => {
    release(get().selfie);
    get().products.forEach(release);
    set({
      selfie: null,
      products: [],
      savedPoster: null,
      step: "selfie",
      layout: "card",
    });
  },
}));
