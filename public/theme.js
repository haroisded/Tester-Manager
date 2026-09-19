// Light / dark: follows the device until the viewer picks one with a [data-theme-toggle] button.
// Loaded in <head> so the right theme is set before the first paint.
(() => {
  const root = document.documentElement;
  const device = matchMedia('(prefers-color-scheme: dark)');
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch {}
  root.dataset.theme = saved || (device.matches ? 'dark' : 'light');
  device.addEventListener('change', e => { if (!saved) root.dataset.theme = e.matches ? 'dark' : 'light'; });
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    saved = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = saved;
    try { localStorage.setItem('theme', saved); } catch {}
  });
})();
