import express from "express";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// Load environment vars
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// View engine + static + body parsing
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site-wide data (single source of truth for your name, role, etc.)
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Make current path available to templates (for active nav state)
app.use((req, res, next) => {
    res.locals.path = req.path; // e.g., "/projects"
    next();
});

// Routes
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact (GET shows optional success alert)
app.get("/contact", (req, res) => {
    res.render("contact", { title: "Contact", sent: req.query.sent === "1" });
});

// Contact (POST -> log for now, then redirect with ?sent=1)
app.post("/contact", (req, res) => {
    const { email, message } = req.body;
    if (!email || !message) {
        return res.status(400).send("Email and message are required.");
    }
    console.log("📩 Contact form:", { email, message });
    res.redirect("/contact?sent=1");
});

// 404
app.use((req, res) => res.status(404).send("Not Found"));

// Start server
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});
