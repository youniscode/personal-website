import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "./models/post.js"; // blog model

// Load env once
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

// Site-wide data
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Active nav helper
app.use((req, res, next) => {
    res.locals.path = req.path; // e.g., "/projects", "/blog/slug"
    next();
});

// ---- MongoDB connection ----
if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI)
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; blog will be disabled.");
}

// ---- Routes ----
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact
app.get("/contact", (req, res) => {
    res.render("contact", { title: "Contact", sent: req.query.sent === "1" });
});
app.post("/contact", (req, res) => {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).send("Email and message are required.");
    console.log("📩 Contact form:", { email, message });
    res.redirect("/contact?sent=1");
});

// Blog
app.get("/blog", async (req, res) => {
    if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
    const posts = await Post.find().sort({ createdAt: -1 }).lean();
    res.render("blog", { title: "Blog", posts });
});

app.get("/blog/:slug", async (req, res) => {
    if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
    const post = await Post.findOne({ slug: req.params.slug }).lean();
    if (!post) return res.status(404).send("Post not found");
    res.render("post", { title: post.title, post });
});

// One-time seed route (hit once, then remove if you like)
app.get("/dev/seed", async (_req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
        const count = await Post.countDocuments();
        if (count === 0) {
            await Post.insertMany([
                {
                    title: "Hello World",
                    slug: "hello-world",
                    body:
                        "My first post from the bootcamp project!\n\nThis site uses Node.js, Express, EJS, and MongoDB on Render."
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body:
                        "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel."
                }
            ]);
        }
        res.send("Seeded (or already seeded).");
    } catch (e) {
        console.error(e);
        res.status(500).send("Seed error");
    }
});

// Health check (optional)
app.get("/health", (_req, res) => res.send("ok"));

// 404
app.use((_req, res) => res.status(404).send("Not Found"));

// Start server
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});
