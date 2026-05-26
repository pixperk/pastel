// Landing screen shown when the URL has no ?room param. Lets the host pick
// a name and a mode before generating a room code, or join an existing room
// by code.

import { MODE_OPTIONS } from "./game";
import { parseRoomCode, type GameMode } from "./proto";

const STORAGE_NAME = "pastel.name";
const STORAGE_MODE = "pastel.mode";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function randomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function showLanding(): void {
  const storedName = window.localStorage.getItem(STORAGE_NAME) ?? "";
  const storedMode =
    (window.localStorage.getItem(STORAGE_MODE) as GameMode | null) ?? "Standard";

  document.body.innerHTML = `
    <main class="landing">
      <section class="landing-card">
        <h1>pastel</h1>
        <p class="landing-tag">Draw with friends. No accounts.</p>

        <form class="landing-form" id="landingForm">
          <label class="field">
            <span class="field-label">Your name</span>
            <input id="landingName" type="text" maxlength="32" required
                   value="${escapeHtml(storedName)}" autocomplete="off"
                   placeholder="pick a name" />
          </label>

          <fieldset class="modes">
            <legend>Mode</legend>
            ${MODE_OPTIONS.map(
              (m) => `
              <label class="mode-pick ${m.id === storedMode ? "mode-pick--on" : ""}">
                <input type="radio" name="mode" value="${m.id}"
                       ${m.id === storedMode ? "checked" : ""} />
                <span class="mode-pick-label">${m.label}</span>
                <span class="mode-pick-meta">${m.rounds} rounds · ${m.wordChoices} words</span>
              </label>`,
            ).join("")}
          </fieldset>

          <button type="submit" class="landing-primary">Create new room</button>
        </form>

        <div class="landing-divider"><span>or</span></div>

        <form class="landing-join" id="landingJoin">
          <label class="field">
            <span class="field-label">Join with a code</span>
            <input id="landingCode" type="text" maxlength="6" minlength="6"
                   required pattern="[A-Za-z0-9]{6}" autocomplete="off"
                   placeholder="ABC234" style="text-transform: uppercase" />
          </label>
          <button type="submit" class="landing-secondary">Join</button>
        </form>
      </section>
    </main>
  `;

  const nameInput = document.getElementById("landingName") as HTMLInputElement;
  const codeInput = document.getElementById("landingCode") as HTMLInputElement;
  const createForm = document.getElementById("landingForm") as HTMLFormElement;
  const joinForm = document.getElementById("landingJoin") as HTMLFormElement;

  // Toggle the "selected" class on mode pills as the radio changes.
  for (const pill of document.querySelectorAll<HTMLLabelElement>(".mode-pick")) {
    pill.addEventListener("click", () => {
      for (const p of document.querySelectorAll<HTMLLabelElement>(".mode-pick")) {
        p.classList.remove("mode-pick--on");
      }
      pill.classList.add("mode-pick--on");
    });
  }

  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 32) || "anon";
    const mode =
      (new FormData(createForm).get("mode") as GameMode | null) ?? "Standard";
    window.localStorage.setItem(STORAGE_NAME, name);
    window.localStorage.setItem(STORAGE_MODE, mode);
    const code = randomCode();
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    url.searchParams.set("mode", mode);
    url.searchParams.set("host", "1");
    window.location.href = url.toString();
  });

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 32) || "anon";
    window.localStorage.setItem(STORAGE_NAME, name);
    const raw = codeInput.value.trim();
    let code: string;
    try {
      code = parseRoomCode(raw);
    } catch (err) {
      codeInput.setCustomValidity(`invalid room code: ${String(err)}`);
      codeInput.reportValidity();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.location.href = url.toString();
  });
}
