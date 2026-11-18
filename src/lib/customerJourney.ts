import { ApiError, ERRORS, MEDIA_ORIGIN, STUDIO_API, postJson } from "./backend";
import type { Reward } from "./rewards";

type Link = {
  name: string;
  phone: string;
  reward: string | null;
  items: Reward[];
  next: "terms" | "spin" | "review" | "mirror" | "share";
  instagram_id: string;
  instagram_profile_saved?: boolean;
  poster: string | null;
};

export async function openCustomerLink(token: string): Promise<Link> {
  const response = await request(`${STUDIO_API}/customers/link/${encodeURIComponent(token)}/`);
  return response.json();
}

async function request(url: string, headers?: HeadersInit) {
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new ApiError(ERRORS.unreachable); });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.detail || ERRORS.server, response.status);
  }
  return response;
}

export const acceptTerms = (token: string, videoReview: boolean, instagram: string) =>
  postJson("/customers/terms/", {
    token, accept: true, video_review: videoReview, instagram_id: instagram,
  }, STUDIO_API);

export async function spinLinkedPrize(token: string) {
  const result = await postJson<{ reward: string }>("/customers/spin/", { token }, STUDIO_API);
  return result.reward;
}

export const sendReview = (token: string, rating: number, review: string) =>
  postJson("/customers/review/", { token, rating, review }, STUDIO_API);

export async function retrievePoster(path: string, token: string) {
  const response = await request(MEDIA_ORIGIN + path, { Authorization: `Bearer ${token}` });
  return response.blob();
}

export function saveLinkedPoster(token: string, phone: string, session: string, mirror: string, poster: Blob, selfie: Blob) {
  const body = new FormData();
  body.append("token", token);
  body.append("phone", phone);
  body.append("session", session);
  body.append("mirror", mirror);
  body.append("poster", poster, "poster.jpg");
  body.append("selfie", selfie, "selfie.jpg");
  return postJson("/customers/", body, STUDIO_API);
}

export const saveInstagramProfile = (token: string, handle: string) =>
  postJson<{ handle: string }>("/customers/profile/", { token, platform: "instagram", handle }, STUDIO_API);

export const recordShareEvent = (token: string, kind: string) =>
  postJson("/customers/event/", { token, kind }, STUDIO_API);

export type ShareProof = "whatsapp" | "more" | "instagram";

export function submitShareProof(token: string, platform: ShareProof, file: File) {
  const body = new FormData();
  body.append("token", token);
  body.append("screenshot", file);
  return postJson(`/customers/${platform}-proof/`, body, STUDIO_API);
}
