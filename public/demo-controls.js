const toggle = document.getElementById('demo-controls-toggle');
const menu = document.getElementById('demo-controls-menu');
const dialog = document.getElementById('reset-dialog');
const confirm = document.getElementById('reset-confirm');
const cancel = document.getElementById('reset-cancel');
const error = document.getElementById('reset-error');
let resetting = false;

function closeMenu() {
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}
toggle.addEventListener('click', () => {
  menu.hidden = !menu.hidden;
  toggle.setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) document.getElementById('reset-simulation').focus();
});
document.addEventListener('click', event => {
  if (!event.target.closest('.sidebar-bottom')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !menu.hidden) { closeMenu(); toggle.focus(); }
});
document.getElementById('reset-simulation').addEventListener('click', () => {
  closeMenu();
  error.hidden = true;
  dialog.showModal();
  cancel.focus();
});
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (resetting) event.preventDefault(); });
dialog.addEventListener('close', () => toggle.focus());
confirm.addEventListener('click', async () => {
  if (resetting) return;
  resetting = true;
  confirm.disabled = cancel.disabled = true;
  confirm.textContent = 'Resetting…';
  dialog.setAttribute('aria-busy', 'true');
  error.hidden = true;
  try {
    const response = await fetch('/api/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Reset failed. Please try again.');
    window.location.reload();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    resetting = false;
    confirm.disabled = cancel.disabled = false;
    confirm.textContent = 'Reset simulation';
    dialog.removeAttribute('aria-busy');
  }
});
