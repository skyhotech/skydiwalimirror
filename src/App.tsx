import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { MotionConfig } from "motion/react";
import { useStudio } from "./lib/store";
import {
  initializePhotoStorage,
  subscribeStorage,
  storageStatus,
} from "./lib/persistence";
const CameraStudio = lazy(() => import("./components/CameraStudio"));
const Editor = lazy(() => import("./components/Editor"));
export default function App() {
  const step = useStudio((s) => s.step);
  const [hydrated, setHydrated] = useState(false);
  const saved = useStudio((s) => Boolean(s.selfie || s.products.length));
  const status = useSyncExternalStore(subscribeStorage, storageStatus);
  useEffect(() => {
    let active = true;
    void initializePhotoStorage().then(() => {
      if (active) setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!hydrated)
    return <div className="loading">Opening your saved studio…</div>;
  return (
    <MotionConfig reducedMotion="user">
      <main id="main" className="mobile-studio">
        <Suspense fallback={<div className="loading">Opening camera…</div>}>
          {["selfie", "selfieReview", "product"].includes(step) ? (
            <CameraStudio key={step === "product" ? "product" : "selfie"} />
          ) : (
            <Editor />
          )}
        </Suspense>
        <section className="local-photo-storage">
          <p role="status">{status}</p>
          {saved && (
            <button onClick={() => useStudio.getState().reset()}>
              Clear saved photos
            </button>
          )}
        </section>
      </main>
    </MotionConfig>
  );
}
