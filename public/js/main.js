// main.js — site-wide niceties

// Auto-dismiss Bootstrap alerts after 4s
window.addEventListener("load", () => {
    document.querySelectorAll(".alert").forEach((el) => {
        setTimeout(() => {
            try {
                const alert = bootstrap.Alert.getOrCreateInstance(el);
                alert.close();
            } catch (_) { }
        }, 4000);
    });
});
