(() => {
  let preference = "system";
  try {
    const stored = localStorage.getItem("fileworker.appearance.v1");
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {}
  const dark = preference === "dark"
    || (preference === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const theme = dark ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = dark ? "#191b20" : "#e9edf1";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#191b20" : "#e9edf1");
})();
