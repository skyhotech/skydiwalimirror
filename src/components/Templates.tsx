import { ChevronLeft, ChevronRight } from "lucide-react";
import { templates } from "../templates";
import { useStudio } from "../lib/store";
export function Templates() {
  const { template, setTemplate } = useStudio();
  const index = Math.max(
    0,
    templates.findIndex((t) => t.id === template),
  );
  const change = (direction: number) =>
    setTemplate(
      templates[(index + direction + templates.length) % templates.length].id,
    );
  return (
    <section className="frame-slider" aria-label="Frame slider">
      <button
        className="icon-button"
        aria-label="Previous frame"
        onClick={() => change(-1)}
      >
        <ChevronLeft size={20} />
      </button>
      <div>
        <span>{templates[index].name}</span>
        <div className="frame-dots">
          {templates.map((t, i) => (
            <button
              key={t.id}
              aria-label={t.name}
              aria-pressed={i === index}
              onClick={() => setTemplate(t.id)}
            />
          ))}
        </div>
      </div>
      <button
        className="icon-button"
        aria-label="Next frame"
        onClick={() => change(1)}
      >
        <ChevronRight size={20} />
      </button>
    </section>
  );
}
