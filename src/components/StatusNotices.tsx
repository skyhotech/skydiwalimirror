import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CloudOff,
  CloudUpload,
  CircleCheck,
  TriangleAlert,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  ERRORS,
  getUploadState,
  subscribeUpload,
  type UploadState,
} from "../lib/backend";
/** Banner across the top whenever the device loses its connection. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(() => !navigator.onLine);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          className="offline-banner"
          role="alert"
          initial={{ y: -60 }}
          animate={{ y: 0 }}
          exit={{ y: -60 }}
        >
          <CloudOff size={16} aria-hidden="true" /> {ERRORS.offline} Your photos
          are kept on this device.
        </motion.div>
      )}
    </AnimatePresence>
  );
}
const UPLOAD_TEXT: Record<Exclude<UploadState, "idle">, string> = {
  saving: "Saving your poster to SKY…",
  saved: "Poster saved with SKY.",
  retrying:
    "Couldn't reach SKY. Your poster is kept on this device and will upload automatically.",
  failed:
    "Your poster couldn't be saved. Please show this screen to a SKY staff member.",
};
const UPLOAD_ICON = {
  saving: CloudUpload,
  saved: CircleCheck,
  retrying: CloudOff,
  failed: TriangleAlert,
};
/** One line saying whether this customer's poster reached the backend. */
export function UploadStatus() {
  const state = useSyncExternalStore(subscribeUpload, getUploadState);
  if (state === "idle") return null;
  const Icon = UPLOAD_ICON[state];
  return (
    <p className={`upload-status upload-${state}`} role="status">
      <Icon size={15} aria-hidden="true" /> {UPLOAD_TEXT[state]}
    </p>
  );
}
