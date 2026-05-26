import { DrawingSurface } from "./canvas";
import { parseRoomCode, type Player, type ServerMsg } from "./proto";
import { Conn, type ConnState } from "./ws";

const PALETTE = ["#e88b9c", "#f1ac81", "#e8d272", "#86c8a3", "#8aa4e0"];

function colorFor(id: number): string {
  return PALETTE[id % PALETTE.length];
}

function pickRoomCode(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("room");
  if (fromUrl) {
    return parseRoomCode(fromUrl);
  }
  const generated = randomCode();
  const url = new URL(window.location.href);
  url.searchParams.set("room", generated);
  window.history.replaceState({}, "", url.toString());
  return generated;
}

function randomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function pickName(): string {
  const stored = window.localStorage.getItem("pastel.name");
  if (stored) return stored;
  const name = window.prompt("Pick a name") ?? "anon";
  const trimmed = name.slice(0, 32) || "anon";
  window.localStorage.setItem("pastel.name", trimmed);
  return trimmed;
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLElement;
const playersEl = document.getElementById("players") as HTMLElement;

const room = pickRoomCode();
const name = pickName();
document.title = `pastel · ${room}`;

const surface = new DrawingSurface(canvas);

const players = new Map<number, Player>();

function renderPlayers(): void {
  const items = Array.from(players.values()).map((p) => {
    const color = colorFor(p.id);
    return `<li><span class="swatch" style="background:${color}"></span>${escapeHtml(p.name)}</li>`;
  });
  playersEl.innerHTML = `<h2>Room ${room}</h2><ul>${items.join("")}</ul>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

renderPlayers();

const wsUrl = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/${room}`;
})();

function handleMessage(msg: ServerMsg): void {
  switch (msg.kind) {
    case "Welcome":
      surface.setYouId(msg.you);
      players.clear();
      for (const p of msg.snapshot.players) players.set(p.id, p);
      players.set(msg.you, { id: msg.you, name });
      renderPlayers();
      surface.applySnapshot(msg);
      return;
    case "Presence":
      for (const p of msg.joined) players.set(p.id, p);
      for (const id of msg.left) players.delete(id);
      renderPlayers();
      return;
    case "Stroke":
      surface.handleStrokeMessage(msg.player, msg.stroke_id, msg.origin, msg.points, msg.finished);
      return;
    case "Resume":
      for (const e of msg.events) handleMessage(e);
      return;
    case "Bye":
      statusEl.textContent = `disconnected: ${msg.reason.toLowerCase()}`;
      return;
    case "Chat":
    case "Guess":
    case "Game":
    case "Ping":
      return;
  }
}

function handleState(s: ConnState): void {
  switch (s.kind) {
    case "connecting":
      statusEl.textContent = "connecting…";
      return;
    case "open":
      statusEl.textContent = `room ${room} · ${name}`;
      return;
    case "reconnecting":
      statusEl.textContent = `reconnecting (attempt ${s.attempt})…`;
      return;
    case "closed":
      statusEl.textContent = `disconnected: ${s.reason}`;
      return;
  }
}

const conn = new Conn({
  url: wsUrl,
  hello: () => ({ kind: "Hello", hello: { room, name, resume_from: null } }),
  onMessage: handleMessage,
  onState: handleState,
});

surface.attachSender((msg) => conn.send(msg));
