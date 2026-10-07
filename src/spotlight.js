// Bento hover light: keeps the hovered tile's --mx / --my at the pointer position.
// Kept out of popup.js so the popup logic (and its tests) stay free of cosmetic handlers.
document.addEventListener("pointermove", (event) => {
  const tile = event.target.closest?.(".tile");
  if (!tile) return;
  const box = tile.getBoundingClientRect();
  tile.style.setProperty("--mx", `${event.clientX - box.left}px`);
  tile.style.setProperty("--my", `${event.clientY - box.top}px`);
}, { passive: true });
