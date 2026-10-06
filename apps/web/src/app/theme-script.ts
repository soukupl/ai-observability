/** Runs before paint: `.dark` from localStorage('theme') = 'dark' | 'light', else prefers-color-scheme. */
export const themeScript = `(() => {
  try {
    const saved = localStorage.getItem('theme');
    const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  } catch {}
})();`;
