import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Festive } from "./Festive";
import { VilakkuLamp } from "./VilakkuLamp";
import { ReviewForm } from "./ReviewForm";
import { TermsPage } from "./TermsPage";
import { SpinWheel } from "./SpinWheel";
import { ShareJourney } from "./ShareJourney";
import {
  openCustomerLink, retrievePoster, saveLinkedPoster, spinLinkedPrize,
} from "../lib/customerJourney";
import { getReward, setLinkedRewards, type Reward } from "../lib/rewards";
import { MEDIA_ORIGIN } from "../lib/backend";
import { initializePhotoStorage } from "../lib/persistence";
import { useStudio } from "../lib/store";

const CameraStudio = lazy(() => import("./CameraStudio"));
type Link = Awaited<ReturnType<typeof openCustomerLink>>;

export default function CustomerJourney({ token }: { token: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [phase, setPhase] = useState<Link["next"]>("terms");
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [posted, setPosted] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [uploadAttempt, setUploadAttempt] = useState(0);
  const opening = useRef<{ attempt: number; result: Promise<Link> } | null>(null);
  const poster = useStudio((state) => state.savedPoster);
  const selfie = useStudio((state) => state.selfie);
  const template = useStudio((state) => state.template);
  const step = useStudio((state) => state.step);

  useEffect(() => {
    let active = true;
    if (opening.current?.attempt !== attempt)
      opening.current = { attempt, result: openCustomerLink(token) };

    void opening.current.result.then(async (data) => {
      if (!active) return;
      await initializePhotoStorage(token);
      if (!active) return;
      const available = data.items.map((item) => ({
        ...item,
        image: item.image.startsWith("/")
          ? MEDIA_ORIGIN + item.image
          : item.image || getReward(item.id)?.image || "",
      }));
      setLinkedRewards(available);
      setRewards(available);
      const store = useStudio.getState();
      if (!store.savedPoster)
        store.products.forEach((photo) => store.removeProduct(photo.id));
      useStudio.setState({
        phone: data.phone,
        reward: data.reward,
        step: store.selfie ? "product" : "selfie",
      });
      const saved = data.poster ? await retrievePoster(data.poster, token) : null;
      if (!active) return;
      setPosted(saved);
      setPhase(data.next);
      setLink(data);
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [attempt, token]);

  useEffect(() => {
    if (!link || phase !== "mirror" || posted || !poster || !selfie) return;
    let active = true;
    void saveLinkedPoster(token, link.phone, selfie.id, template, poster, selfie.blob).then(() => {
      if (active) setPosted(poster);
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [link, phase, posted, poster, selfie, template, token, uploadAttempt]);

  const panel = (children: React.ReactNode) => (
    <main id="main" className="mobile-studio">
      <Festive>
        <div className="phone-shake"><VilakkuLamp />{children}</div>
      </Festive>
    </main>
  );

  if (!link || (poster && !posted && phase === "mirror")) {
    const saving = Boolean(link);
    return panel(
      <section className="phone-card">
        <h1 className="phone-title">{saving ? "Saving your poster" : "Opening your gift link"}</h1>
        {error && (
          <>
            <p role="alert">{error}</p>
            <button className="spin-button phone-continue" onClick={() => {
              setError("");
              if (saving) setUploadAttempt((n) => n + 1);
              else setAttempt((n) => n + 1);
            }}>Try again</button>
          </>
        )}
      </section>,
    );
  }

  if (posted)
    return panel(<ShareJourney token={token} poster={posted} handle={link.instagram_id} profileSaved={link.instagram_profile_saved} />);
  if (phase === "terms")
    return panel(<TermsPage token={token} onDone={() => setPhase(link.reward ? "review" : "spin")} />);
  if (phase === "spin")
    return panel(rewards.length ? (
      <SpinWheel rewards={rewards} getPrize={() => spinLinkedPrize(token)} onClaim={(reward) => {
        useStudio.getState().setReward(reward.id);
        setPhase("review");
      }} />
    ) : <section className="phone-card"><p role="alert">No gifts are available right now. Please ask SKY staff.</p></section>);
  if (phase === "review") return panel(<ReviewForm token={token} onDone={() => setPhase("mirror")} />);
  return (
    <main id="main" className="mobile-studio">
      <Suspense fallback={<div className="loading">Opening camera…</div>}>
        <CameraStudio key={step === "product" ? "product" : "selfie"} linked />
      </Suspense>
    </main>
  );
}
