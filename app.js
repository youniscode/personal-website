// app.js — Express + EJS + Mongo + Markdown blog + Auth + Mail + SEO

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";

// Models
import Post from "./models/post.js";
import User from "./models/user.js";

// Markdown + sanitize
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import slugify from "slugify";

// Auth/session
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import MongoStore from "connect-mongo";

// Mail
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ESM dirname helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// 0) MongoDB connection
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
    // On Atlas/production we don't want autoIndex builds at runtime
    mongoose.set("autoIndex", false);
}

if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; DB features will not work.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) App + templating + static + body parsing
// ─────────────────────────────────────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site-wide locals available in all EJS templates
app.locals.site = {
    name: process.env.NAME || "Your Name",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Path helper for active nav highlighting
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Helpers: markdown→safe HTML, absUrl, summarize
// ─────────────────────────────────────────────────────────────────────────────
function mdToHtml(md = "") {
    const raw = marked(md, { mangle: false, headerIds: true });
    return sanitizeHtml(raw, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            "img",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "pre", "code"
        ]),
        allowedAttributes: {
            a: ["href", "name", "target", "rel"],
            img: ["src", "alt"],
            "*": ["id", "class"]
        },
        transformTags: {
            a: (_t, attrs) => ({
                tagName: "a",
                attribs: { ...attrs, target: "_blank", rel: "noopener" }
            })
        }
    });
}

function absUrl(req, pathStr = "/") {
    const base =
        process.env.BASE_URL?.replace(/\/+$/, "") ||
        `${req.protocol}://${req.get("host")}`;
    return `${base}${pathStr.startsWith("/") ? pathStr : `/${pathStr}`}`;
}

function summarize(htmlOrMd = "", n = 160) {
    const text = String(htmlOrMd).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// Default meta for all requests; each route can override
app.use((req, res, next) => {
    res.locals.meta = {
        title: app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: absUrl(req, "/img/share-default.jpg"),
        robots: "index,follow"
    };
    next();
});

// Expose absUrl to views when needed
app.locals.absUrl = (pathStr = "/") => pathStr;

// ─────────────────────────────────────────────────────────────────────────────
// 3) Sessions + Passport (local strategy)
// ─────────────────────────────────────────────────────────────────────────────
app.set("trust proxy", 1); // needed so secure cookies work behind Render proxy

app.use(
    session({
        secret: process.env.SESSION_SECRET || "change-me-please",
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax"
        },
        store: MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: 60 * 60 * 24 * 14 // 14 days
        })
    })
);

passport.use(
    new LocalStrategy(
        { usernameField: "email", passwordField: "password" },
        async (email, password, done) => {
            try {
                const user = await User.findOne({ email: email.toLowerCase().trim() });
                if (!user) return done(null, false, { message: "Invalid email or password." });
                const ok = await bcrypt.compare(password, user.passwordHash);
                if (!ok) return done(null, false, { message: "Invalid email or password." });
                return done(null, user);
            } catch (e) {
                return done(e);
            }
        }
    )
);
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id).lean();
        done(null, user);
    } catch (e) {
        done(e);
    }
});
app.use(passport.initialize());
app.use(passport.session());

// Make auth info available on ALL pages (so admin header shows everywhere)
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.isAdmin = !!req.user;
    next();
});

function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Mail transport (contact form)
// ─────────────────────────────────────────────────────────────────────────────
function buildTransport() {
    // Prefer explicit host/port if provided, else use service (gmail, etc.)
    if (process.env.MAIL_HOST) {
        return nodemailer.createTransport({
            host: process.env.MAIL_HOST,
            port: Number(process.env.MAIL_PORT || 587),
            secure: String(process.env.MAIL_SECURE || "").toLowerCase() === "true" || Number(process.env.MAIL_PORT) === 465,
            auth: process.env.MAIL_USER && process.env.MAIL_PASS ? {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            } : undefined,
            tls: { rejectUnauthorized: false }
        });
    }
    if (process.env.MAIL_SERVICE) {
        return nodemailer.createTransport({
            service: process.env.MAIL_SERVICE, // e.g. 'gmail'
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            },
            tls: { rejectUnauthorized: false }
        });
    }
    // Fallback: JSON transport (logs the message instead of sending)
    return nodemailer.createTransport({ jsonTransport: true });
}
const mailer = buildTransport();

// ─────────────────────────────────────────────────────────────────────────────
// 5) Core pages
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.render("home", { title: "Home" });
});

app.get("/about", (req, res) => {
    res.render("about", { title: "About" });
});

app.get("/projects", (req, res) => {
    res.render("projects", { title: "Projects" });
});

// Contact
// GET /contact
app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err || "",
        form: {
            name: req.query.name || "",
            email: req.query.email || "",
            message: req.query.message || ""
        }
    });
});

// POST /contact
app.post("/contact", async (req, res) => {
    const { name = "", email = "", message = "" } = req.body || {};
    if (!email || !message) {
        // Re-render with the form values so the user doesn't lose what they typed
        return res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Missing email or message",
            form: { name, email, message }
        });
    }

    try {
        const to =
            process.env.MAIL_TO || process.env.EMAIL || process.env.MAIL_USER;
        const from =
            process.env.MAIL_FROM ||
            (process.env.MAIL_USER
                ? `"${app.locals.site.name}" <${process.env.MAIL_USER}>`
                : undefined);

        await mailer.sendMail({
            to,
            from,
            subject: `New message from ${name || "your site"}`,
            text: `From: ${name || "Unknown"} <${email}>\n\n${message}`
        });

        res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Send failed",
            form: { name, email, message }
        });
    }
});


// Login / Logout
app.get("/login", (req, res) => {
    res.render("login", {
        title: "Login",
        error: req.query.err ? "Invalid email or password." : null,
    });
});
app.post(
    "/login",
    (req, res, next) => {
        req._nextUrl = req.query.next || "/blog";
        next();
    },
    passport.authenticate("local", { failureRedirect: "/login?err=1" }),
    (req, res) => res.redirect(req._nextUrl || "/blog")
);
app.post("/logout", (req, res, next) => {
    req.logout(err => {
        if (err) return next(err);
        res.redirect("/blog");
    });
});

// Change password (simple admin utility)
app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: null, ok: null });
});
app.post("/admin/change-password", ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).send("User not found");
        const ok = await bcrypt.compare(currentPassword || "", user.passwordHash || "");
        if (!ok) {
            return res.render("change-password", { title: "Change Password", error: "Current password is incorrect.", ok: null });
        }
        if (!newPassword || newPassword.length < 8) {
            return res.render("change-password", { title: "Change Password", error: "New password must be at least 8 characters.", ok: null });
        }
        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();
        res.render("change-password", { title: "Change Password", error: null, ok: "Password updated." });
    } catch (e) {
        console.error("change-password error", e);
        res.render("change-password", { title: "Change Password", error: "Something went wrong.", ok: null });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Blog (public + admin)
// ─────────────────────────────────────────────────────────────────────────────

// Blog list with pagination + search + tags
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit || "6", 10), 1), 24);
        const q = (req.query.q || "").trim();
        const tag = (req.query.tag || "").trim().toLowerCase();

        // Base query
        const query = {};
        // Only published to public; admins see all
        if (!req.user) query.published = true;

        if (q) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            query.$or = [{ title: rx }, { body: rx }];
        }
        if (tag) {
            query.tags = tag;
        }

        const total = await Post.countDocuments(query);
        const posts = await Post.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // Meta
        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: q
                ? `Search results for “${q}”.`
                : "Notes from my learning-in-public journey.",
            url: absUrl(req, req.originalUrl || "/blog"),
            canonical: absUrl(req, "/blog"),
            type: "website"
        };

        res.render("blog", {
            title: "Blog",
            posts,
            page,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            q,
            tag,
            isAdmin: !!req.user
        });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

// Single post
app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const query = { slug: req.params.slug };
        if (!req.user) query.published = true; // unpublished hidden from public

        const post = await Post.findOne(query).lean();
        if (!post) return res.status(404).send("Post not found");

        const html = post.bodyHtml || mdToHtml(post.body || "");
        const desc = summarize(html, 180);

        res.locals.meta = {
            ...res.locals.meta,
            title: `${post.title} • ${app.locals.site.name}`,
            description: desc,
            type: "article",
            url: absUrl(req, `/blog/${post.slug}`),
            canonical: absUrl(req, `/blog/${post.slug}`),
            image: post.coverImage || absUrl(req, "/img/share-default.jpg")
        };

        const shareUrl = absUrl(req, `/blog/${post.slug}`);

        res.render("post", {
            title: post.title,
            post,
            html,
            shareUrl,
            isAdmin: !!req.user
        });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// Admin: New post
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

// Admin: Create post
app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage, tags, published } = req.body || {};
        if (!title || !body) return res.status(400).send("Title and body are required.");

        const slug = slugify(title, { lower: true, strict: true });
        const existing = await Post.findOne({ slug }).lean();
        if (existing) return res.status(409).send("A post with this title already exists.");

        const html = mdToHtml(body);
        const tagArr = (tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null,
            tags: tagArr,
            published: String(published).toLowerCase() === "on" || String(published).toLowerCase() === "true"
        });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

// Admin: Edit form
app.get("/admin/blog/:slug/edit", ensureAuth, async (req, res) => {
    try {
        const post = await Post.findOne({ slug: req.params.slug }).lean();
        if (!post) return res.status(404).send("Post not found");
        res.render("edit-post", { title: `Edit: ${post.title}`, post });
    } catch (err) {
        console.error("💥 GET edit error:", err);
        res.status(500).send("Failed to load edit page.");
    }
});

// Admin: Update post
app.post("/admin/blog/:slug", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage, tags, published } = req.body || {};
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
        current.tags = (tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);
        current.published =
            String(published).toLowerCase() === "on" || String(published).toLowerCase() === "true";

        await current.save();
        res.redirect(`/blog/${current.slug}`);
    } catch (err) {
        console.error("💥 POST update error:", err);
        res.status(500).send("Failed to update post.");
    }
});

// Admin: Toggle publish quickly (optional utility)
app.post("/admin/blog/:slug/toggle", ensureAuth, async (req, res) => {
    try {
        const post = await Post.findOne({ slug: req.params.slug });
        if (!post) return res.status(404).send("Post not found");
        post.published = !post.published;
        await post.save();
        res.redirect(`/blog/${post.slug}`);
    } catch (e) {
        console.error("toggle publish error", e);
        res.status(500).send("Toggle failed.");
    }
});

// Admin: Delete post
app.post("/admin/blog/:slug/delete", ensureAuth, async (req, res) => {
    try {
        await Post.deleteOne({ slug: req.params.slug });
        res.redirect("/blog");
    } catch (err) {
        console.error("💥 delete error:", err);
        res.status(500).send("Failed to delete post.");
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) SEO: Sitemap + RSS
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const posts = await Post.find({ published: true }).sort({ createdAt: -1 }).lean();
        const postUrls = posts
            .map(
                (p) =>
                    `  <url><loc>${base}/blog/${p.slug}</loc><changefreq>weekly</changefreq><lastmod>${new Date(
                        p.updatedAt || p.createdAt
                    ).toISOString()}</lastmod></url>`
            )
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
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const posts = await Post.find({ published: true }).sort({ createdAt: -1 }).lean();

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
/* 8) Diagnostics + dev seed */
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
                    body: "My first post from the bootcamp project!\n\nThis site uses Node.js, Express, EJS, and MongoDB on Render.",
                    published: true,
                    tags: ["intro"]
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body: "Building while studying is the fastest way to learn. Next up: auth and polish.",
                    published: true,
                    tags: ["learning"]
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
// 9) Start server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});
