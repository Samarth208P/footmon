export default function RerollIcon({ size = 20, color = "currentColor", style = {}, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", shrink: 0, ...style }}
    >
      <path d="M21 12A9 9 0 0 0 6 5.3L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" />
      <path d="M16 16h5v5" />
    </svg>
  );
}
