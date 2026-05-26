// UI for the game loop overlays: mode picker, word pick, drawing banner
// (mask + timer + round counter), round-end reveal, game-over podium.

import { MODE_OPTIONS, type GamePhase } from "./game";
import type { GameMode } from "./proto";

export interface GameUIHandlers {
  onStart: (mode: GameMode) => void;
  onPickWord: (index: number) => void;
  onRematch: () => void;
}

export interface GameUI {
  render(
    phase: GamePhase,
    you: number | null,
    playerName: (id: number) => string,
  ): void;
  /// Returns the current word/mask to render in the top banner. null if no
  /// game is running.
  bannerText(phase: GamePhase): string | null;
}

export function mountGameUI(root: HTMLElement, handlers: GameUIHandlers): GameUI {
  root.classList.add("game-overlay");
  root.innerHTML = "";

  function clear(): void {
    root.innerHTML = "";
    root.classList.remove("game-overlay--visible");
  }

  function visible(): void {
    root.classList.add("game-overlay--visible");
  }

  function renderLobby(): void {
    visible();
    const options = MODE_OPTIONS.map(
      (m) => `
      <button type="button" class="mode-card" data-mode="${m.id}">
        <span class="mode-label">${m.label}</span>
        <span class="mode-meta">${m.rounds} rounds · ${m.wordChoices} words</span>
      </button>`,
    ).join("");
    root.innerHTML = `
      <div class="overlay-card">
        <h2>Pick a mode</h2>
        <div class="mode-grid">${options}</div>
        <p class="overlay-hint">Game starts as soon as you pick. At least two players in the room.</p>
      </div>
    `;
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".mode-card")) {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode as GameMode;
        handlers.onStart(mode);
      });
    }
  }

  function renderChoosing(
    phase: Extract<GamePhase, { kind: "ChoosingWord" }>,
    you: number | null,
    nameOf: (id: number) => string,
  ): void {
    visible();
    if (phase.drawer === you && phase.myOptions) {
      const buttons = phase.myOptions
        .map(
          (w, i) =>
            `<button type="button" class="word-card" data-index="${i}">${escapeHtml(w)}</button>`,
        )
        .join("");
      root.innerHTML = `
        <div class="overlay-card">
          <h2>Pick a word</h2>
          <div class="word-grid">${buttons}</div>
          <p class="overlay-hint">Round ${phase.roundIndex + 1} of ${phase.totalRounds}</p>
        </div>
      `;
      for (const btn of root.querySelectorAll<HTMLButtonElement>(".word-card")) {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.index);
          handlers.onPickWord(idx);
        });
      }
    } else {
      root.innerHTML = `
        <div class="overlay-card">
          <h2>${escapeHtml(nameOf(phase.drawer))} is picking a word</h2>
          <p class="overlay-hint">Round ${phase.roundIndex + 1} of ${phase.totalRounds}</p>
        </div>
      `;
    }
  }

  function renderRoundEnd(
    phase: Extract<GamePhase, { kind: "RoundEnd" }>,
    nameOf: (id: number) => string,
  ): void {
    visible();
    const rows = phase.scores
      .map(
        ([id, score]) =>
          `<li><span>${escapeHtml(nameOf(id))}</span><span>${score}</span></li>`,
      )
      .join("");
    root.innerHTML = `
      <div class="overlay-card">
        <h2>The word was <em>${escapeHtml(phase.word)}</em></h2>
        <ul class="score-list">${rows}</ul>
      </div>
    `;
  }

  function renderGameOver(
    phase: Extract<GamePhase, { kind: "GameOver" }>,
    nameOf: (id: number) => string,
  ): void {
    visible();
    const top = phase.finalScores.slice(0, 3);
    const podium = top
      .map(
        ([id, score], i) =>
          `<li class="podium-row podium-${i + 1}">
             <span class="podium-rank">#${i + 1}</span>
             <span class="podium-name">${escapeHtml(nameOf(id))}</span>
             <span class="podium-score">${score}</span>
           </li>`,
      )
      .join("");
    root.innerHTML = `
      <div class="overlay-card">
        <h2>Game over</h2>
        <ul class="podium">${podium}</ul>
        <button type="button" class="rematch-btn">Play again</button>
      </div>
    `;
    root
      .querySelector<HTMLButtonElement>(".rematch-btn")
      ?.addEventListener("click", handlers.onRematch);
  }

  function render(
    phase: GamePhase,
    you: number | null,
    nameOf: (id: number) => string,
  ): void {
    // Only the kinds that need an overlay show up here. Drawing just hides
    // the overlay and lets the canvas + banner do the work.
    switch (phase.kind) {
      case "Lobby":
        renderLobby();
        break;
      case "ChoosingWord":
        renderChoosing(phase, you, nameOf);
        break;
      case "RoundEnd":
        renderRoundEnd(phase, nameOf);
        break;
      case "GameOver":
        renderGameOver(phase, nameOf);
        break;
      case "Drawing":
        clear();
        break;
    }
  }

  function bannerText(phase: GamePhase): string | null {
    switch (phase.kind) {
      case "Drawing":
        return phase.myWord ?? phase.mask;
      case "ChoosingWord":
        return null;
      default:
        return null;
    }
  }

  return { render, bannerText };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
