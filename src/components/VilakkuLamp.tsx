import lamps from "../assets/brand/deepam-lamps.webp";

// Each pair places the flame base over a wick in the transparent artwork.
const wickPositions = [
  [12, 21],
  [28.3, 33],
  [50, 50.5],
  [71.8, 33],
  [88, 21],
];

export function VilakkuLamp() {
  return (
    <div className="vilakku-wrap" aria-hidden="true">
      <img src={lamps} alt="" width={640} height={330} />
      {wickPositions.map(([left, top], index) => (
        <span
          key={left}
          className="vilakku-flame"
          style={{
            left: `${left}%`,
            top: `${top}%`,
            animationDelay: `-${index * 0.31}s`,
          }}
        />
      ))}
    </div>
  );
}
