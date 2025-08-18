// app.js
// ─────────────────────────────────────────────────────────────────────────────
// Personal Website (Express + EJS + MongoDB + Markdown blog with admin)
// - Views in /views (EJS)
// - Static assets in /public
// - Blog posts stored in MongoDB (models/post.js)
// - Admin routes protected by Basic Auth (env ADMIN_USER / ADMIN_PASS)
// - SEO meta (OG/Twitter), sitemap.xml, rss.xml
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "./models/post.js";
import basicAuth from "express-basic-auth";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Env + app bootstrap
// ─────────────────────────────────────────────────────────────────────────────
dotenv.config(); // Loads .env (NAME, ROLE, MONGO_URI, ADMIN_USER, ADMIN_PASS, BASE_URL, etc.)

const app = express();
const PORT = process.env.PORT || 3000;

// Proper __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Views, static files, and body parsing
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true })); // form-encoded bodies

// Global site data (available in all templates via 'site')
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Active nav helper for header highlighting
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Helpers (Markdown → Safe HTML, URL builder, summary text, default meta)
// ─────────────────────────────────────────────────────────────────────────────

// Convert Markdown to sanitized HTML
function mdToHtml(md = "") {
    const raw = marked(md, { mangle: false, headerIds: true });
    return sanitizeHtml(raw, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            "img", "h1", "h2", "h3", "h4", "h5", "h6"
        ]),
        allowedAttributes: {
            a: ["href", "name", "target", "rel"],
            img: ["src", "alt"],
            "*": ["id", "class"]
        },
        transformTags: {
            a: (tag, attrs) => ({
                tagName: "a",
                attribs: { ...attrs, target: "_blank", rel: "noopener" }
            })
        }
    });
}

// Build absolute URL from request and path
function absUrl(req, pathStr = "/") {
    const base =
        process.env.BASE_URL?.replace(/\/+$/, "") ||
        `${req.protocol}://${req.get("host")}`;
    return `${base}${pathStr.startsWith("/") ? pathStr : `/${pathStr}`}`;
}

// Strip HTML and shorten text for descriptions
function summarize(htmlOrMd = "", n = 160) {
    const text = String(htmlOrMd)
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// Default SEO meta for every page (templates can override via res.locals.meta)
app.use((req, res, next) => {
    res.locals.meta = {
        title: res.locals.title || app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null // fallback handled in html-start.ejs → /img/share-default.jpg
    };
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) MongoDB connection
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; blog will be disabled.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Admin auth (Basic Auth for /admin routes)
// ─────────────────────────────────────────────────────────────────────────────
const adminOnly = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true,
    unauthorizedResponse: "Unauthorized"
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Core pages
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact (demo: logs to console)
app.get("/contact", (req, res) =>
    res.render("contact", { title: "Contact", sent: req.query.sent === "1" })
);
app.post("/contact", (req, res) => {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).send("Email and message are required.");
    console.log("📩 Contact form:", { email, message });
    res.redirect("/contact?sent=1");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Blog (public routes)
// ─────────────────────────────────────────────────────────────────────────────

// Blog list
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const posts = await Post.find().sort({ createdAt: -1 }).lean();

        // SEO meta for list page
        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            type: "website",
            url: absUrl(req, "/blog"),
            canonical: absUrl(req, "/blog")
        };

        res.render("blog", { title: "Blog", posts });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

// Single post
app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const post = await Post.findOne({ slug: req.params.slug }).lean();
        if (!post) return res.status(404).send("Post not found");

        const html = post.bodyHtml || mdToHtml(post.body || "");
        const desc = summarize(html, 180);

        // Per-post meta (uses post.coverImage if present)
        res.locals.meta = {
            ...res.locals.meta,
            title: `${post.title} • ${app.locals.site.name}`,
            description: desc,
            type: "article",
            url: absUrl(req, `/blog/${post.slug}`),
            canonical: absUrl(req, `/blog/${post.slug}`),
            image: post.coverImage || absUrl(req, "/img/share-default.jpg")
        };

        res.render("post", { title: post.title, post, html });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Blog admin (create / edit / delete) — protected by Basic Auth
// ─────────────────────────────────────────────────────────────────────────────

// New post form
app.get("/admin/blog/new", adminOnly, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

// Create post
app.post("/admin/blog", adminOnly, async (req, res) => {
    try {
        const { title, body, coverImage } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");

        const slug = slugify(title, { lower: true, strict: true });

        // Avoid duplicates if title/slug already exists
        const existing = await Post.findOne({ slug }).lean();
        if (existing) return res.status(409).send("A post with this title already exists.");

        const html = mdToHtml(body);
        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null
        });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

// Edit form
app.get("/admin/blog/:slug/edit", adminOnly, async (req, res) => {
    try {
        const post = await Post.findOne({ slug: req.params.slug }).lean();
        if (!post) return res.status(404).send("Post not found");
        res.render("edit-post", { title: `Edit: ${post.title}`, post });
    } catch (err) {
        console.error("💥 GET edit error:", err);
        res.status(500).send("Failed to load edit page.");
    }
});

// Update post (also handles title change → slug change with collision check)
app.post("/admin/blog/:slug", adminOnly, async (req, res) => {
    try {
        const { title, body, coverImage } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");

        const current = await Post.findOne({ slug: req.params.slug });
        if (!current) return res.status(404).send("Post not found");

        const newSlug = slugify(title, { lower: true, strict: true });

        // If slug changed, ensure there is no conflict with another post
        if (newSlug !== current.slug) {
            const conflict = await Post.findOne({ slug: newSlug }).lean();
            if (conflict) return res.status(409).send("Another post already uses that title.");
        }

        current.title = title;
        current.slug = newSlug;
        current.body = body;
        current.bodyHtml = mdToHtml(body);
        current.coverImage = coverImage || null;

        await current.save();
        res.redirect(`/blog/${current.slug}`);
    } catch (err) {
        console.error("💥 POST update error:", err);
        res.status(500).send("Failed to update post.");
    }
});

// Delete post
app.post("/admin/blog/:slug/delete", adminOnly, async (req, res) => {
    try {
        await Post.deleteOne({ slug: req.params.slug });
        res.redirect("/blog");
    } catch (err) {
        console.error("💥 delete error:", err);
        res.status(500).send("Failed to delete post.");
    }
});

// ─────────────────────────────────────────────────────────────────────────────
/* 8) SEO endpoints: sitemap.xml + rss.xml
   - BASE_URL should be set in env for correct absolute links on Render
*/
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base =
            (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const posts = await Post.find().sort({ createdAt: -1 }).lean();
        const postUrls = posts
            .map((p) => `  <url><loc>${base}/blog/${p.slug}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${postUrls}
</urlset>`;
        res.type("application/xml").send(xml);
    } catch (e) {
        console.error("💥 sitemap error:", e);
        res.status(500).send("sitemap error");
    }
});

app.get("/rss.xml", async (req, res) => {
    try {
        const base =
            (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const posts = await Post.find().sort({ createdAt: -1 }).lean();

        const items = posts
            .map((p) => {
                const html = p.bodyHtml || mdToHtml(p.body || "");
                const desc = summarize(html, 200);
                return `
  <item>
    <title><![CDATA[${p.title}]]></title>
    <link>${base}/blog/${p.slug}</link>
    <guid>${base}/blog/${p.slug}</guid>
    <pubDate>${new Date(p.createdAt).toUTCString()}</pubDate>
    <description><![CDATA[${desc}]]></description>
  </item>`;
            })
            .join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[${app.locals.site.name} — Blog]]></title>
  <link>${base}</link>
  <description><![CDATA[${app.locals.site.role || ""}]]></description>
  ${items}
</channel>
</rss>`;
        res.type("application/rss+xml").send(xml);
    } catch (e) {
        console.error("💥 rss error:", e);
        res.status(500).send("rss error");
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) Diagnostics (TEMP) + health + 404
// ─────────────────────────────────────────────────────────────────────────────
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
                    body:
                        "My first post from the bootcamp project! This site uses Node.js, Express, EJS, and MongoDB."
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
        console.error("💥 /dev/seed error:", e);
        res.status(500).send("Seed error: " + e.message);
    }
});

app.get("/health", (_req, res) => res.send("ok"));
app.use((_req, res) => res.status(404).send("Not Found"));

// ─────────────────────────────────────────────────────────────────────────────
// 10) Start server (keep LAST)
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});

// Edit form
app.get("/admin/blog/:slug/edit", adminOnly, async (req, res) => {
    const post = await Post.findOne({ slug: req.params.slug }).lean();
    if (!post) return res.status(404).send("Post not found");
    res.render("edit-post", { title: `Edit: ${post.title}`, post });
});

// Update
app.post("/admin/blog/:slug", adminOnly, async (req, res) => {
    const { title, body, coverImage } = req.body;
    if (!title || !body) return res.status(400).send("Title and body are required.");
    const current = await Post.findOne({ slug: req.params.slug });
    if (!current) return res.status(404).send("Post not found");

    const newSlug = slugify(title, { lower: true, strict: true });
    if (newSlug !== current.slug) {
        const conflict = await Post.findOne({ slug: newSlug }).lean();
        if (conflict) return res.status(409).send("Another post already uses that title.");
    }

    current.title = title;
    current.slug = newSlug;
    current.body = body;
    current.bodyHtml = mdToHtml(body);
    current.coverImage = coverImage || null;
    await current.save();
    res.redirect(`/blog/${current.slug}`);
});

// Delete
app.post("/admin/blog/:slug/delete", adminOnly, async (req, res) => {
    await Post.deleteOne({ slug: req.params.slug });
    res.redirect("/blog");
});


// expose a hint when a valid Basic Auth header is present (very light-weight)
app.use((req, res, next) => {
    const auth = req.get('authorization') || '';
    res.locals.isAdmin = auth.startsWith('Basic ');
    next();
});
