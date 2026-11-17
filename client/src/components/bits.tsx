import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { joinUrl as venueJoinUrl, type VenueContext } from "@bargames/sdk/client";
import type { GuessLogEntry, RoomView, SlotView, TeamView } from "@crowdsays/shared";

/** Re-renders every `ms` while mounted (countdowns). */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Seconds left until a server time, given the clock skew. */
export function secondsLeft(at: number | null, now: number, skew: number): number | null {
  return at === null ? null : Math.max(0, Math.ceil((at - (now + skew)) / 1000));
}

export function Countdown({ at, skew, className = "" }: { at: number | null; skew: number; className?: string }) {
  const now = useNow();
  const s = secondsLeft(at, now, skew);
  if (s === null) return null;
  return <span className={`countdown ${s <= 5 ? "countdown-low" : ""} ${className}`}>{s}</span>;
}

export function QrCode({ text, size = 160 }: { text: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: size * 2 })
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [text, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt={`QR code for ${text}`} /> : null;
}

/**
 * A room's join link (and QR code): on a Bar Games box it's on the venue's public address;
 * standalone it's this origin plus the path prefix.
 */
export const joinUrl = (code: string, venue: VenueContext | null = null) => venueJoinUrl(venue, `/join/${code}`);

export function teamStyle(t: TeamView | undefined): React.CSSProperties {
  return t ? ({ "--team": t.color } as React.CSSProperties) : {};
}

/** The answer board: hidden slots show their rank; revealed ones the answer and its count. */
export function Board({ view, size = "md" }: { view: RoomView; size?: "md" | "tv" }) {
  const slots = view.board;
  const half = Math.ceil(slots.length / 2);
  const cols = slots.length > 4 ? [slots.slice(0, half), slots.slice(half)] : [slots];
  return (
    <div className={`board board-${size}`} data-cols={cols.length}>
      {cols.map((col, i) => (
        <div className="board-col" key={i}>
          {col.map((s) => (
            <Slot key={s.rank} slot={s} team={s.by === null ? undefined : view.teams[s.by]} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Slot({ slot, team }: { slot: SlotView; team?: TeamView }) {
  const open = slot.revealed;
  const peek = !open && slot.label !== null; // a runner's view of a hidden answer
  return (
    <div className={`slot ${open ? "slot-open" : "slot-hidden"} ${peek ? "slot-peek" : ""}`} style={teamStyle(team)}>
      <span className="slot-rank">{slot.rank}</span>
      {open || peek ? (
        <>
          <span className="slot-label">{slot.label}</span>
          <span className="slot-count">{slot.count}</span>
        </>
      ) : (
        <span className="slot-label" />
      )}
    </div>
  );
}

export function Strikes({ n, max }: { n: number; max: number }) {
  return (
    <div className="strikes" aria-label={`${n} of ${max} strikes`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`strike ${i < n ? "strike-on" : ""}`}>
          ✕
        </span>
      ))}
    </div>
  );
}

/** Team scores, with whose turn it is. */
export function Scores({ view, compact = false }: { view: RoomView; compact?: boolean }) {
  const guessing = view.phase === "guess" ? view.turn?.guessing : undefined;
  return (
    <div className={`scores ${compact ? "scores-compact" : ""}`}>
      {view.teams.map((t) => (
        <div
          key={t.index}
          className={`score ${guessing === t.index ? "score-active" : ""} ${view.winners.includes(t.index) ? "score-winner" : ""}`}
          style={teamStyle(t)}
        >
          <span className="score-name">{t.name}</span>
          <span className="score-points">{t.score}</span>
        </div>
      ))}
    </div>
  );
}

/** Turn line: "Blue Team is guessing · bank 12", or the steal. */
export function TurnLine({ view }: { view: RoomView }) {
  const t = view.turn;
  if (!t || view.phase !== "guess") return null;
  const team = view.teams[t.guessing];
  return (
    <div className="turn-line" style={teamStyle(team)}>
      <span className="turn-team">{team?.name}</span>
      <span>{t.stealing ? "can steal with one guess!" : "is guessing"}</span>
      <span className="bank">Bank {t.bank}</span>
    </div>
  );
}

const RESULT_TEXT = { hit: "on the board", miss: "not there", repeat: "already up" } as const;

export function GuessLog({ view, max = 4 }: { view: RoomView; max?: number }) {
  const items: GuessLogEntry[] = view.log.slice(-max).reverse();
  if (!items.length) return null;
  return (
    <ul className="guess-log">
      {items.map((g) => (
        <li key={g.id} className={`guess-${g.result}`} style={teamStyle(view.teams[g.team])}>
          <span className="guess-text">{g.text === "✕" ? "Strike" : `“${g.text}”`}</span>
          <span className="muted small">
            {g.steal ? "steal · " : ""}
            {g.text === "✕" ? "from the host" : RESULT_TEXT[g.result]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Red Team wins the round: 23 points". */
export function RoundResult({ view }: { view: RoomView }) {
  const w = view.roundWinner === null ? undefined : view.teams[view.roundWinner];
  return (
    <div className="round-result" style={teamStyle(w)}>
      {w ? (
        <>
          <strong>{w.name}</strong> banks {view.roundPoints} point{view.roundPoints === 1 ? "" : "s"}
        </>
      ) : (
        "Nobody scores this round"
      )}
    </div>
  );
}

export function Winners({ view }: { view: RoomView }) {
  const names = view.winners.map((i) => view.teams[i]?.name).filter(Boolean);
  return (
    <div className="winners">
      {names.length === 0 ? "No points this game" : names.length === 1 ? `${names[0]} wins!` : `It's a tie: ${names.join(" & ")}`}
    </div>
  );
}
