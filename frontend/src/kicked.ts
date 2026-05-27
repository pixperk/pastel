// Full-screen takeover when the server closes the connection terminally
// (kicked, room closed, room full). The connection is already gone by the
// time this renders; we just inform the user.

import type { ByeReason } from "./proto";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function showFatalScreen(reason: ByeReason): void {
  const { heading, body } = copyFor(reason);
  document.body.innerHTML = `
    <main class="kicked">
      <section class="kicked-card">
        <h1>${escapeHtml(heading)}</h1>
        <p class="kicked-body">${escapeHtml(body)}</p>
        <div class="kicked-actions">
          <button type="button" class="kicked-primary" id="kickedHome">
            Back to home
          </button>
          <button type="button" class="kicked-secondary" id="kickedRejoin">
            Try the same room again
          </button>
        </div>
      </section>
    </main>
  `;
  document.getElementById("kickedHome")?.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("host");
    url.searchParams.delete("mode");
    window.location.href = url.toString();
  });
  document.getElementById("kickedRejoin")?.addEventListener("click", () => {
    window.location.reload();
  });
}

function copyFor(reason: ByeReason): { heading: string; body: string } {
  switch (reason) {
    case "Kicked":
      return {
        heading: "You were kicked from the room",
        body: "The host removed you. You can head back to the home screen, or try rejoining if it was a mistake.",
      };
    case "RoomFull":
      return {
        heading: "That room is full",
        body: "Rooms cap at 10 players. Create a new one or try again later.",
      };
    case "RoomClosed":
      return {
        heading: "Room closed",
        body: "The room is no longer accepting connections.",
      };
    case "BadFrame":
      return {
        heading: "Connection rejected",
        body: "The server didn't accept our handshake. This usually means the client is out of date. Try reloading.",
      };
    case "Reconnect":
      return {
        heading: "Disconnected",
        body: "You were dropped from the room. Reload to rejoin.",
      };
  }
}
