import type { ReactNode } from "react";
import { IphoneBanner } from "./IphoneBanner";

export function Festive({
  children,
  banner = false,
}: {
  children: ReactNode;
  banner?: boolean;
}) {
  return (
    <div className="phone-gate">
      <div className="phone-bg" aria-hidden="true">
        <div className="phone-glow" />
        <div className="phone-mandala" />
        <div className="deepam-lamps">
          {Array.from({ length: 5 }, (_, index) => (
            <span className="deepam-lamp" key={index} />
          ))}
        </div>
      </div>
      {banner && <IphoneBanner />}
      {children}
    </div>
  );
}
