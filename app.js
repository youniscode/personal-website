// app.js — Express + EJS + Mongo + Markdown blog + Auth + Mail + SEO
// -----------------------------------------------------------------------------

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import MongoStore from "connect-mongo";
import nodemailer from "nodemailer";

import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

import Post from "./models/post.js";
import User from "./models/user.js";

// -----------------------------------------------------------------------------
// 1) Load env + basic app setup
// -----------------------------------------------------------------------------
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

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

// Make `path` and user flags available to views
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// -----------------------------------------------------------------------------
// 2) Helpers
// -----------------------------------------------------------------------------
function mdToHtml(md = "") {
    const raw = marked(md, { mangle: false, headerIds: true });
    return sanitizeHtml(raw, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "h3", "h4", "h5", "h6"]),
        allowedAttributes: {
            a: ["href", "name", "target", "rel"],
            img: ["src", "alt"],
            "*": ["id", "class"]
        },
        transformTags: {
            a: (_tag, attrs) => ({
                tagName: "a",
                attribs: { ...attrs, target: "_blank", rel: "noopener" }
            })
        }
    });
}

function absUrl(req, pathStr = "/") {
    const base = process.env.BASE_URL?.replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`;
    return `${base}${pathStr.startsWith("/") ? pathStr : `/${pathStr}`}`;
}

function summarize(htmlOrMd = "", n = 160) {
    const text = String(htmlOrMd).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function readingMinutesFromHtmlOrMd(input = "") {
    const text = String(input).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const words = text ? text.split(/\s+/).length : 0;
    return Math.max(1, Math.round(words / 200));
}

// Default SEO meta baseline
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

// -----------------------------------------------------------------------------
// 3) MongoDB
// -----------------------------------------------------------------------------
if (process.env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
}

if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; DB features disabled.");
}

// -----------------------------------------------------------------------------
// 4) Sessions + Passport (local strategy)
// -----------------------------------------------------------------------------
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

// Admin flags visible everywhere
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.isAdmin = !!req.user;
    next();
});

function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// -----------------------------------------------------------------------------
// 5) Mailer
// -----------------------------------------------------------------------------
const DEV_SKIP_TLS = String(process.env.DEV_SKIP_TLS_VERIFY || "").toLowerCase() === "true";

function makeTransport() {
    // Prefer MAIL_SERVICE=gmail path
    if (process.env.MAIL_SERVICE && process.env.MAIL_USER && process.env.MAIL_PASS) {
        return nodemailer.createTransport({
            service: process.env.MAIL_SERVICE,
            auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
            tls: DEV_SKIP_TLS ? { rejectUnauthorized: false } : undefined
        });
    }
    // or host/port config
    if (process.env.MAIL_HOST) {
        return nodemailer.createTransport({
            host: process.env.MAIL_HOST,
            port: Number(process.env.MAIL_PORT || 587),
            secure: String(process.env.MAIL_SECURE || "").toLowerCase() === "true" || Number(process.env.MAIL_PORT) === 465,
            auth: (process.env.MAIL_USER && process.env.MAIL_PASS)
                ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
                : undefined,
            tls: DEV_SKIP_TLS ? { rejectUnauthorized: false } : undefined
        });
    }
    // last resort (local dev relay)
    return nodemailer.createTransport({ jsonTransport: true });
}

const mailer = makeTransport();

// -----------------------------------------------------------------------------
// 6) Core pages
// -----------------------------------------------------------------------------
app.get("/", (req, res) => {
    res.render("home", { title: "Home" });
});

// UPDATED ABOUT: passes `posts` safely
app.get("/about", async (req, res) => {
    try {
        let posts = [];
        if (mongoose.connection.readyState) {
            const filter = !req.user ? { published: true } : {};
            const rows = await Post.find(filter).sort({ createdAt: -1 }).limit(3).lean();
            posts = rows.map((p) => {
                const html = p.bodyHtml || mdToHtml(p.body || "");
                return { ...p, readingMinutes: readingMinutesFromHtmlOrMd(html) };
            });
        }
        res.render("about", { title: "About", posts });
    } catch (e) {
        console.error("💥 /about error:", e);
        res.render("about", { title: "About", posts: [] });
    }
});

app.get("/projects", (req, res) => {
    res.render("projects", { title: "Projects" });
});

// Projects list
app.get("/projects", (req, res) => {
    res.render("projects");
});

// Project detail: Flight Briefing & Route Kit
app.get("/projects/flight-briefing", (req, res) => {
    res.locals.meta = {
        ...res.locals.meta,
        title: `Flight Briefing & Route Kit • ${app.locals.site.name}`,
        description:
            "Plan routes, summarize METAR/TAF and NOTAMs, and export a printable route kit.",
        url: absUrl(req, "/projects/flight-briefing"),
        canonical: absUrl(req, "/projects/flight-briefing"),
        type: "website",
        image: absUrl(req, "/img/projects/flight-briefing-thumb.png"),
    };

    res.render("project-flight-briefing", {
        title: "Flight Briefing & Route Kit",
        project: {
            // Enable the blue button when you have a live URL:
            demoUrl: null, // e.g. "https://flight-briefing.onrender.com"

            // Your real GitHub repo URL:
            sourceUrl: "https://github.com/youniscode/flight-briefing-kit",

            // 'in-progress' | 'prototype' | 'coming-soon'
            status: "in-progress",
        },
    });
});




// About page
app.get("/about", (req, res) => {
    res.render("about");
});


// Contact
app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err || "",
        form: {} // keep template happy on first load
    });
});

app.post("/contact", async (req, res) => {
    const { name, email, message } = req.body;
    const fallbackTo = process.env.MAIL_TO || process.env.EMAIL || process.env.MAIL_USER;
    if (!email || !message) {
        return res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Email and message are required.",
            form: { name, email, message }
        });
    }
    try {
        await mailer.sendMail({
            to: fallbackTo,
            from: process.env.MAIL_FROM || fallbackTo,
            subject: `Portfolio contact from ${name || "Visitor"}`,
            replyTo: email,
            text: message
        });
        res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Send failed. Please try again later.",
            form: { name, email, message }
        });
    }
});

// -----------------------------------------------------------------------------
// 7) Blog: list, detail (with prev/next), admin CRUD, search, tags, pagination
// -----------------------------------------------------------------------------

// Blog list
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const page = Math.max(1, parseInt(req.query.page || "1", 10));
        const pageSize = 6;
        const q = (req.query.q || "").trim();
        const tag = (req.query.tag || "").trim().toLowerCase();

        const filter = {};
        if (!req.user) filter.published = true;
        if (q) {
            filter.$or = [
                { title: { $regex: q, $options: "i" } },
                { body: { $regex: q, $options: "i" } }
            ];
        }
        if (tag) filter.tags = tag;

        const total = await Post.countDocuments(filter);
        const posts = await Post.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .lean();

        const viewPosts = posts.map((p) => {
            const html = p.bodyHtml || mdToHtml(p.body || "");
            return {
                ...p,
                readingMinutes: readingMinutesFromHtmlOrMd(html)
            };
        });

        // SEO for list page
        res.locals.meta = {
            ...res.locals.meta,
            title: q ? `Search “${q}” • ${app.locals.site.name}` : `Blog • ${app.locals.site.name}`,
            description: q ? `Search results for “${q}” on the blog.` : "Notes from my learning-in-public journey.",
            url: absUrl(req, req.originalUrl),
            canonical: absUrl(req, "/blog"),
            type: "website"
        };

        res.render("blog", {
            title: "Blog",
            posts: viewPosts,
            page,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            q,
            tag,
            isAdmin: !!req.user
        });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

// Single post (with prev/next)
app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const filterBase = !req.user ? { published: true } : {};
        const post = await Post.findOne({ ...filterBase, slug: req.params.slug }).lean();
        if (!post) return res.status(404).send("Post not found");

        const html = post.bodyHtml || mdToHtml(post.body || "");
        const desc = summarize(html, 180);
        const shareUrl = absUrl(req, `/blog/${post.slug}`);

        // prev/next by date
        const prev = await Post.findOne({
            ...filterBase,
            createdAt: { $lt: post.createdAt }
        })
            .sort({ createdAt: -1 })
            .select("title slug")
            .lean();

        const next = await Post.findOne({
            ...filterBase,
            createdAt: { $gt: post.createdAt }
        })
            .sort({ createdAt: 1 })
            .select("title slug")
            .lean();

        res.locals.meta = {
            ...res.locals.meta,
            title: `${post.title} • ${app.locals.site.name}`,
            description: desc,
            type: "article",
            url: shareUrl,
            canonical: shareUrl,
            image: post.coverImage || absUrl(req, "/img/share-default.jpg")
        };

        res.render("post", {
            title: post.title,
            post,
            html,
            shareUrl,
            prev,
            next,
            isAdmin: !!req.user
        });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// Admin: create
app.get("/admin/blog/new", ensureAuth, (req, res) => {
    res.render("new-post", { title: "New Post" });
});

app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage, tags, published } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");
        const slug = slugify(title, { lower: true, strict: true });

        const existing = await Post.findOne({ slug }).lean();
        if (existing) return res.status(409).send("A post with this title already exists.");

        const html = mdToHtml(body);
        const tagsArr = (tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null,
            tags: tagsArr,
            published: String(published) === "on" || published === true
        });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

// Admin: edit form
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

// Admin: update
app.post("/admin/blog/:slug", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage, tags, published } = req.body;
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
        current.published = String(published) === "on" || published === true;

        await current.save();
        res.redirect(`/blog/${current.slug}`);
    } catch (err) {
        console.error("💥 POST update error:", err);
        res.status(500).send("Failed to update post.");
    }
});

// Admin: delete
app.post("/admin/blog/:slug/delete", ensureAuth, async (req, res) => {
    try {
        await Post.deleteOne({ slug: req.params.slug });
        res.redirect("/blog");
    } catch (err) {
        console.error("💥 delete error:", err);
        res.status(500).send("Failed to delete post.");
    }
});

// -----------------------------------------------------------------------------
// 8) Auth pages
// -----------------------------------------------------------------------------
app.get("/login", (req, res) => {
    res.render("login", {
        title: "Login",
        error: req.query.err ? "Invalid email or password." : null
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
    req.logout((err) => {
        if (err) return next(err);
        res.redirect("/blog");
    });
});

// Change password
app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: "" });
});

app.post("/admin/change-password", ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        const user = await User.findById(req.user._id);
        if (!user) return res.status(400).send("User not found");

        const ok = await bcrypt.compare(currentPassword || "", user.passwordHash);
        if (!ok) {
            return res.render("change-password", { title: "Change Password", error: "Current password is incorrect." });
        }
        if (!newPassword || newPassword.length < 8) {
            return res.render("change-password", { title: "Change Password", error: "New password must be at least 8 characters." });
        }
        if (newPassword !== confirmPassword) {
            return res.render("change-password", { title: "Change Password", error: "Passwords do not match." });
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();
        res.redirect("/blog");
    } catch (e) {
        console.error("💥 change-password error:", e);
        res.render("change-password", { title: "Change Password", error: "Something went wrong. Try again." });
    }
});

// -----------------------------------------------------------------------------
// 9) SEO endpoints
// -----------------------------------------------------------------------------
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const filter = !req.user ? { published: true } : {};
        const posts = await Post.find(filter).sort({ createdAt: -1 }).lean();
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
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const filter = !req.user ? { published: true } : {};
        const posts = await Post.find(filter).sort({ createdAt: -1 }).lean();

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

// -----------------------------------------------------------------------------
// 10) Diagnostics + 404 + start
// -----------------------------------------------------------------------------
app.get("/diag", (_req, res) => {
    const readyState = mongoose.connection?.readyState;
    const host = mongoose.connection?.host;
    res.json({ readyState, host });
});

app.get("/health", (_req, res) => res.send("ok"));
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
