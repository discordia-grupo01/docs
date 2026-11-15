(function () {
  var root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("discordia-docs-theme", theme); } catch (e) {}
  }

  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
      if (document.getElementById("viewer")) location.reload();
    });
  }

  var app = document.getElementById("app");
  var openBtn = document.getElementById("nav-open");
  function setNav(open) {
    app.classList.toggle("nav-is-open", open);
    if (openBtn) openBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (openBtn) openBtn.addEventListener("click", function () { setNav(true); });
  var closeBtn = document.getElementById("nav-close");
  if (closeBtn) closeBtn.addEventListener("click", function () { setNav(false); });
  var scrim = document.getElementById("scrim");
  if (scrim) scrim.addEventListener("click", function () { setNav(false); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setNav(false);
  });
  var current = document.querySelector('.nav-sub a[aria-current="page"]');
  if (current && current.scrollIntoView) current.scrollIntoView({ block: "center" });
})();

function discordiaColors() {
  var dark = document.documentElement.getAttribute("data-theme") !== "light";
  return dark
    ? { bg: "#1e2d42", panel: "#1c293b", card: "#1a2e40", text: "#f5f2eb", muted: "#a8c6df", accent: "#2d7a8c", border: "rgba(168,198,223,0.18)", dark: true }
    : { bg: "#fbf7f0", panel: "#eae5d9", card: "#ede8dc", text: "#18181b", muted: "#245c6b", accent: "#245c6b", border: "rgba(36,92,107,0.22)", dark: false };
}

function initOpenApi(specUrl) {
  var c = discordiaColors();
  Redoc.init(
    specUrl,
    {
      hideDownloadButton: false,
      scrollYOffset: ".header",
      hideHostname: true,
      expandResponses: "200,201",
      theme: {
        colors: {
          primary: { main: c.accent },
          text: { primary: c.text, secondary: c.muted },
          http: { get: "#38a169", post: "#2d7a8c", put: "#f0b232", patch: "#a8c6df", delete: "#e05252" },
          border: { dark: c.border, light: c.border },
          responses: { success: { color: "#38a169" }, error: { color: "#e05252" } }
        },
        typography: {
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: "15px",
          headings: { fontFamily: "Outfit, Inter, sans-serif" },
          code: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: c.dark ? "#a9d8a0" : "#2e7531", backgroundColor: c.dark ? "#14212f" : "#f1ece1" }
        },
        sidebar: { backgroundColor: c.panel, textColor: c.text, activeTextColor: c.accent, groupItems: { textTransform: "none" } },
        rightPanel: {
          backgroundColor: c.dark ? "#0f1922" : "#245c6b",
          textColor: "#f5f2eb",
          servers: { overlay: { backgroundColor: c.dark ? "#14212f" : "#1d4e5a", textColor: "#f5f2eb" }, url: { backgroundColor: c.dark ? "#0b141c" : "#173f49" } }
        },
        codeBlock: { backgroundColor: c.dark ? "#0b141c" : "#173f49" },
        schema: { nestedBackground: c.card, typeNameColor: c.muted, typeTitleColor: c.text }
      }
    },
    document.getElementById("viewer")
  );
}

function initAsyncApi(specUrl) {
  var c = discordiaColors();
  document.getElementById("viewer").classList.add(c.dark ? "aui-dark" : "aui-light");
  fetch(specUrl)
    .then(function (r) { return r.text(); })
    .then(function (schema) {
      AsyncApiStandalone.render(
        { schema: schema, config: { show: { sidebar: true, info: true, servers: true, operations: true, messages: true, schemas: true, errors: false } } },
        document.getElementById("viewer")
      );
    });
}
