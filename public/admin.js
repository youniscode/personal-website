// admin.js – confirm helpers for destructive actions

document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-confirm]");
    if (!btn) return;
    const msg = btn.getAttribute("data-confirm") || "Are you sure?";
    if (!window.confirm(msg)) e.preventDefault();
});

document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-confirm]");
    if (!form) return;
    const msg = form.getAttribute("data-confirm") || "Are you sure?";
    if (!window.confirm(msg)) e.preventDefault();
});
