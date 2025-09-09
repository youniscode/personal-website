// app.js — Express + EJS + Mongo + Blog + Auth + Contact + SEO (+ RSS & Sitemap)

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import nodemailer from "nodemailer";

import Post from "./models/post.js";
import User from "./models/user.js";

// ─────────────────────────────────────────────────────────────────────────────
// 0) Env + app bootstrap
// ─────────────────────────────────────────────────────────────────────────────
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Views/static/body
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site locals (visible in all templates as "site")
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Track current path (for navbar active state)
app.use((req, res, next) => { res.locals.path = req.path; next(); });

// ─────────────────────────────────────────────────────────────────────────────
/** 1) Helpers (Markdown → safe HTML, abs URL, summarize, meta defaults) */
// ─────────────────────────────────────────────────────────────────────────────
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
            a: (_t, attrs) => ({ tagName: "a", attribs: { ...attrs, target: "_blank", rel: "noopener" } })
        }
    });
}

function absUrl(req, pathStr = "/") {
    const base = (process.env.BASE_URL && process.env.BASE_URL.trim())
        ? process.env.BASE_URL.replace(/\/+$/, "")
        : `${req.protocol}://${req.get("host")}`;
    return `${base}${pathStr.startsWith("/") ? pathStr : `/${pathStr}`}`;
}

function summarize(htmlOrMd = "", n = 160) {
    const text = String(htmlOrMd).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// Default SEO meta for every request (routes can override via res.locals.meta)
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

// ─────────────────────────────────────────────────────────────────────────────
// 2) Database
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
    // avoids auto-index building on production nodes (faster cold starts)
    mongoose.set("autoIndex", false);
}

if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch(err => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; DB-backed features will fail.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Sessions + Passport (email/password)
// ─────────────────────────────────────────────────────────────────────────────
app.set("trust proxy", 1); // important behind Render/any reverse proxy

app.use(
    session({
        secret: process.env.SESSION_SECRET || "change-me-please",
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax"
        },
        store: MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: 60 * 60 * 24 * 14
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
    try { done(null, await User.findById(id).lean()); }
    catch (e) { done(e); }
});

app.use(passport.initialize());
app.use(passport.session());

// expose admin flag on EVERY route/template
app.use((req, res, next) => { res.locals.isAdmin = !!req.user; next(); });

function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Mailer (contact form)
// ─────────────────────────────────────────────────────────────────────────────
function buildTransport() {
    const svc = (process.env.MAIL_SERVICE || "").toLowerCase();
    if (svc === "gmail") {
        return nodemailer.createTransport({
            service: "gmail",
            auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
        });
    }
    // host/port manual config
    const host = process.env.MAIL_HOST || "smtp.gmail.com";
    const port = Number(process.env.MAIL_PORT || 465);
    const secure = String(process.env.MAIL_SECURE || "true").toLowerCase() === "true";
    return nodemailer.createTransport({
        host, port, secure,
        auth: (process.env.MAIL_USER && process.env.MAIL_PASS) ? {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS
        } : undefined,
        tls: { rejectUnauthorized: !(String(process.env.MAIL_TLS_ALLOW_SELF_SIGNED || "false").toLowerCase() === "true") }
    });
}
const mailer = buildTransport();

// ─────────────────────────────────────────────────────────────────────────────
// 5) Core pages
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact
app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err ? decodeURIComponent(req.query.err) : "",
        form: {} // keep template happy
    });
});
app.post("/contact", async (req, res) => {
    const { name, email, message } = req.body;
    const mailTo = process.env.MAIL_TO || process.env.EMAIL || "admin@example.com";
    const from = process.env.MAIL_FROM || `${app.locals.site.name} <${process.env.MAIL_USER || "no-reply@example.com"}>`;

    if (!email || !message) {
        return res.redirect("/contact?err=" + encodeURIComponent("Email and message are required."));
    }
    try {
        await mailer.sendMail({
            to: mailTo,
            from,
            subject: `Contact form: ${name || "Visitor"}`,
            text: `From: ${name || "(no name)"} <${email}>\n\n${message}`,
            replyTo: email
        });
        return res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        return res.redirect("/contact?err=" + encodeURIComponent("Failed to send message."));
    }
});

// Login / Logout / Change password
app.get("/login", (req, res) => {
    res.render("login", {
        title: "Login",
        error: req.query.err ? "Invalid email or password." : null
    });
});
app.post(
    "/login",
    (req, _res, next) => { req._nextUrl = req.query.next || "/blog"; next(); },
    passport.authenticate("local", { failureRedirect: "/login?err=1" }),
    (req, res) => res.redirect(req._nextUrl || "/blog")
);
app.post("/logout", (req, res, next) => {
    req.logout(err => err ? next(err) : res.redirect("/blog"));
});

// Change password (GET form + POST submit)
app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: "", ok: "" });
});
app.post("/admin/change-password", ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        const user = await User.findById(req.user._id);
        if (!user) return res.render("change-password", { title: "Change Password", error: "User not found.", ok: "" });
        const ok = await bcrypt.compare(currentPassword || "", user.passwordHash);
        if (!ok) return res.render("change-password", { title: "Change Password", error: "Current password is incorrect.", ok: "" });
        if (!newPassword || newPassword.length < 8) {
            return res.render("change-password", { title: "Change Password", error: "New password must be at least 8 characters.", ok: "" });
        }
        if (newPassword !== confirmPassword) {
            return res.render("change-password", { title: "Change Password", error: "Passwords do not match.", ok: "" });
        }
        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();
        res.render("change-password", { title: "Change Password", error: "", ok: "Password updated successfully." });
    } catch (e) {
        console.error("change password error:", e);
        res.render("change-password", { title: "Change Password", error: "Failed to update password.", ok: "" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Blog (list + detail) with search, tags, pagination, published flag
// ─────────────────────────────────────────────────────────────────────────────
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const q = (req.query.q || "").trim();
        const tag = (req.query.tag || "").trim().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page || "1", 10));
        const limit = 5;
        const filter = {};

        // only published for visitors; admins see all
        if (!req.user) filter.published = true;

        if (q) {
            filter.$or = [
                { title: new RegExp(q, "i") },
                { body: new RegExp(q, "i") },
                { tags: new RegExp(q, "i") }
            ];
        }
        if (tag) {
            filter.tags = tag;
        }

        const total = await Post.countDocuments(filter);
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const posts = await Post.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // SEO meta for list
        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            type: "website",
            url: absUrl(req, req.originalUrl),
            canonical: absUrl(req, "/blog")
        };

        res.render("blog", {
            title: "Blog",
            posts,
            q,
            tag,
            page,
            totalPages
        });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const filter = { slug: req.params.slug };
        if (!req.user) filter.published = true;

        const post = await Post.findOne(filter).lean();
        if (!post) return res.status(404).send("Post not found");

        const html = post.bodyHtml || mdToHtml(post.body || "");
        const desc = summarize(html, 180);
        const shareUrl = absUrl(req, `/blog/${post.slug}`);

        res.locals.meta = {
            ...res.locals.meta,
            title: `${post.title} • ${app.locals.site.name}`,
            description: desc,
            type: "article",
            url: shareUrl,
            canonical: shareUrl,
            image: post.coverImage || absUrl(req, "/img/share-default.jpg")
        };

        res.render("post", { title: post.title, post, html, shareUrl });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Blog admin (new/edit/delete/publish) — protected
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
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
        const tagList = (tags || "")
            .split(",")
            .map(t => t.trim().toLowerCase())
            .filter(Boolean);

        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null,
            tags: tagList,
            published: String(published) === "true" || String(published) === "on"
        });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

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
        current.tags = (tags || "").split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
        current.published = String(published) === "true" || String(published) === "on";

        await current.save();
        res.redirect(`/blog/${current.slug}`);
    } catch (err) {
        console.error("💥 POST update error:", err);
        res.status(500).send("Failed to update post.");
    }
});

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
// 8) SEO endpoints — sitemap.xml + rss.xml  ✅
// ─────────────────────────────────────────────────────────────────────────────
// --- Sitemap ---------------------------------------------------------------
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = absUrl(req, "/");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"];

        const publishedQuery = { $or: [{ published: true }, { published: { $exists: false } }] };
        const posts = await Post.find(publishedQuery)
            .sort({ createdAt: -1 })
            .select("slug")
            .lean();

        res.type("application/xml");

        const urlNode = (loc) => `
  <url>
    <loc>${absUrl(req, loc)}</loc>
    <changefreq>weekly</changefreq>
  </url>`.trim();

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls.map(urlNode).join("\n")}
${posts.map((p) => urlNode(`/blog/${encodeURIComponent(p.slug)}`)).join("\n")}
</urlset>`;

        return res.send(xml);
    } catch (e) {
        console.error("sitemap error:", e);
        return res.status(500).send("Sitemap unavailable");
    }
});



// --- RSS feed --------------------------------------------------------------
app.get("/rss.xml", async (req, res) => {
    try {
        // include docs where published is true OR not present
        const publishedQuery = { $or: [{ published: true }, { published: { $exists: false } }] };

        const posts = await Post.find(publishedQuery)
            .sort({ createdAt: -1 })
            .select("title slug body bodyHtml createdAt coverImage")
            .lean();

        res.type("application/rss+xml");
        const siteTitle = `${app.locals.site.name} — Blog`;
        const siteDesc = app.locals.site.role || "";
        const siteLink = absUrl(req, "/");

        const items = posts.map((p) => {
            const link = absUrl(req, `/blog/${encodeURIComponent(p.slug)}`);
            const pub = new Date(p.createdAt || Date.now()).toUTCString();
            const desc = (p.bodyHtml || p.body || "").replace(/\n/g, " ");
            return `
  <item>
    <title><![CDATA[${p.title}]]></title>
    <link>${link}</link>
    <guid>${link}</guid>
    <pubDate>${pub}</pubDate>
    <description><![CDATA[${desc}]]></description>
  </item>`;
        }).join("");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[${siteTitle}]]></title>
  <link>${siteLink}</link>
  <description><![CDATA[${siteDesc}]]></description>${items ? "\n" + items + "\n" : "\n"}
</channel>
</rss>`;
        return res.send(xml);
    } catch (e) {
        console.error("rss error:", e);
        return res.status(500).send("RSS unavailable");
    }
});



// ─────────────────────────────────────────────────────────────────────────────
// 9) Diagnostics + health + 404
// ─────────────────────────────────────────────────────────────────────────────
app.get("/diag", (_req, res) => {
    const hasEnv = Boolean(process.env.MONGO_URI);
    const readyState = mongoose.connection?.readyState; // 0=down,1=up,2=connecting,3=disconnecting
    const host = mongoose.connection?.host;
    res.json({ hasEnv, readyState, host });
});
app.get("/health", (_req, res) => res.send("ok"));

app.use((_req, res) => res.status(404).send("Not Found"));

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
