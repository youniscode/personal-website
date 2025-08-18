import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "./models/post.js"; // Mongoose model
import basicAuth from "express-basic-auth";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// ---------- Markdown -> safe HTML ----------
function mdToHtml(md = "") {
    const raw = marked(md, { mangle: false, headerIds: true });
    return sanitizeHtml(raw, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            "img", "h1", "h2", "h3", "h4", "h5", "h6"
        ]),
        allowedAttributes: {
            a: ["href", "name", "target", "rel"],
            img: ["src", "alt"],
            '*': ["id", "class"]
        },
        transformTags: {
            a: (tag, attrs) => ({
                tagName: "a",
                attribs: { ...attrs, target: "_blank", rel: "noopener" }
            })
        }
    });
}

// ---------- Load env once ----------
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- View engine + static + body parsing ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// ---------- Site-wide locals ----------
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Mark active nav path
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ---------- MongoDB connection ----------
if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; blog will be disabled.");
}

// ---------- Admin auth middleware (Basic Auth) ----------
const adminOnly = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true,           // browser shows login dialog
    unauthorizedResponse: "Unauthorized"
});

// ---------- Routes ----------
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// ---------- Blog ----------
app.get("/blog", async (_req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
        const posts = await Post.find().sort({ createdAt: -1 }).lean();
        return res.render("blog", { title: "Blog", posts });
    } catch (err) {
        console.error("💥 /blog error:", err);
        return res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
        const post = await Post.findOne({ slug: req.params.slug }).lean();
        if (!post) return res.status(404).send("Post not found");

        // Use precomputed HTML if present; otherwise convert on the fly
        const html = post.bodyHtml || mdToHtml(post.body || "");
        return res.render("post", { title: post.title, post, html });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        return res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// ---------- Admin: New Post ----------
app.get("/admin/blog/new", adminOnly, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

app.post("/admin/blog", adminOnly, async (req, res) => {
    try {
        const { title, body } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");
        const slug = slugify(title, { lower: true, strict: true });

        const existing = await Post.findOne({ slug }).lean();
        if (existing) return res.status(409).send("A post with this title already exists.");

        const html = mdToHtml(body);
        await Post.create({ title, slug, body, bodyHtml: html });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

// ---------- Contact ----------
app.get("/contact", (req, res) =>
    res.render("contact", { title: "Contact", sent: req.query.sent === "1" })
);
app.post("/contact", (req, res) => {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).send("Email and message are required.");
    console.log("📩 Contact form:", { email, message });
    res.redirect("/contact?sent=1");
});

// ---------- Diagnostics & Seed (TEMP; remove later) ----------
app.get("/diag", (_req, res) => {
    const hasEnv = Boolean(process.env.MONGO_URI);
    const readyState = mongoose.connection?.readyState; // 0=down,1=up,2=connecting,3=disconnecting
    const host = mongoose.connection?.host;
    res.json({ hasEnv, readyState, host });
});

app.get("/dev/seed", async (_req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
        const count = await Post.countDocuments();
        if (count === 0) {
            await Post.insertMany([
                {
                    title: "Hello World",
                    slug: "hello-world",
                    body: "My first post from the bootcamp project! This site uses Node.js, Express, EJS, and MongoDB."
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body: "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel."
                }
            ]);
        }
        res.send("Seeded (or already seeded).");
    } catch (e) {
        console.error("💥 /dev/seed error:", e);
        res.status(500).send("Seed error: " + e.message);
    }
});

// ---------- Health & 404 ----------
app.get("/health", (_req, res) => res.send("ok"));
app.use((_req, res) => res.status(404).send("Not Found"));

// ---------- Start server ----------
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});
