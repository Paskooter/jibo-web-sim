// Minimal tab strip wired by data-* attributes. No framework.

export function installTabs(tabsEl, panelsEl) {
  const buttons = Array.from(tabsEl.querySelectorAll('button[role="tab"]'));
  const panels = Array.from(panelsEl.querySelectorAll('.panel'));

  function selectTab(name) {
    for (const b of buttons) {
      b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    }
    for (const p of panels) {
      p.hidden = p.dataset.panel !== name;
    }
  }

  for (const b of buttons) {
    b.addEventListener('click', () => selectTab(b.dataset.tab));
  }

  // Seed each empty panel with a placeholder so it isn't visually blank.
  for (const p of panels) {
    if (p.childElementCount === 0) {
      p.textContent = `${p.dataset.panel} — not implemented yet (M0)`;
    }
  }

  const initial = buttons.find(b => b.getAttribute('aria-selected') === 'true') || buttons[0];
  if (initial) selectTab(initial.dataset.tab);
}
