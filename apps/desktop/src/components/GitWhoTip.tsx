import { useWhoCard } from '../lib/git-who';

/** The card of who last changed the hovered item (lib/git-who.ts): drawn once for every list, beside the row. */
export function GitWhoTip() {
  const card = useWhoCard();
  if (!card) return null;
  return (
    <div
      role="tooltip"
      data-git-who
      className="fixed z-[80] max-w-xs rounded-md bg-fg text-bg px-2.5 py-1.5 text-xs shadow-md pointer-events-none"
      style={{ left: card.x + 8, top: card.y, transform: 'translateY(-50%)' }}
    >
      <div className="font-medium">{card.headline}</div>
      {card.lines.map((l) => (
        <div key={l} className="opacity-80 truncate">
          {l}
        </div>
      ))}
    </div>
  );
}
