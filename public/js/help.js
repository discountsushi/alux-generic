// The "?" button pops up a short explanation. HELP holds the words (keyed by the button's
// data-help), and initHelp() wires one shared popover for the page.

export const HELP = {
  'light.pods':
    'Your Adaptalux pods, driven from this computer over Bluetooth instead of the phone app. <b>Set-up</b> finds them (Scan) and makes an arm per port. <b>Connect</b> takes them from the phone app until you disconnect; the pods’ own buttons still work. Each arm has a slider and On; <b>All on / off</b> cover every arm; a <b>look</b> saves every arm’s level under a name; <b>Rave</b> is a random light show.',
};

let pop = null;

function place(btn) {
  const r = btn.getBoundingClientRect();
  const w = Math.min(330, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
  const h = pop.offsetHeight;
  pop.style.top = `${r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : r.bottom + 8}px`;
}

function hide() {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  pop.dataset.for = '';
}

function show(btn) {
  pop.innerHTML = HELP[btn.dataset.help] || 'No help for this yet.';
  pop.dataset.for = btn.dataset.help;
  pop.hidden = false;
  place(btn);
}

export function initHelp() {
  pop = Object.assign(document.createElement('div'), { className: 'help-pop', hidden: true });
  pop.setAttribute('role', 'tooltip');
  document.body.append(pop);
  // Capture phase, so a "?" inside a label or a clickable card head doesn't trigger it too.
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest('.help-q');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        if (!pop.hidden && pop.dataset.for === btn.dataset.help) hide();
        else show(btn);
      } else if (!e.target.closest('.help-pop')) hide();
    },
    true,
  );
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
}
