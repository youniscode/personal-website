// app.js — Express + EJS + Mongo + Markdown blog + Passport auth + Mailer

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "./models/post.js";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Auth deps
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import MongoStore from "connect-mongo";
import User from "./models/user.js";

// Mail + rate limit
import nodemailer from "nodemailer";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Proper __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Mongo settings
// ─────────────────────────────────────────────────────────────────────────────

// Disable autoIndex in production to silence Atlas warnings & speed cold-starts
if (process.env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
}

// Connect
if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; blog will be disabled.");
}

// ─────────────────────────────────────────────────────────────────────────────
/** Views/static/body */
// ─────────────────────────────────────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site locals for templates
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || "",
};

// Active nav + safe default flash for alerts partial
app.use((req, res, next) => {
    res.locals.path = req.path;
    // keep alerts include safe even if nothing set
    res.locals.flash = res.locals.flash || null;
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: Markdown → safe HTML, absUrl, summarize, default meta
// ─────────────────────────────────────────────────────────────────────────────
function mdToHtml(md = "") {
    const raw = marked(md, { mangle: false, headerIds: true });
    return sanitizeHtml(raw, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            "img",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
        ]),
        allowedAttributes: {
            a: ["href", "name", "target", "rel"],
            img: ["src", "alt"],
            "*": ["id", "class"],
        },
        transformTags: {
            a: (_tag, attrs) => ({
                tagName: "a",
                attribs: { ...attrs, target: "_blank", rel: "noopener" },
            }),
        },
    });
}

function absUrl(req, pathStr = "/") {
    const base =
        process.env.BASE_URL?.replace(/\/+$/, "") ||
        `${req.protocol}://${req.get("host")}`;
    return `${base}${pathStr.startsWith("/") ? pathStr : `/${pathStr}`}`;
}

function summarize(htmlOrMd = "", n = 160) {
    const text = String(htmlOrMd)
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// Default meta
app.use((req, res, next) => {
    res.locals.meta = {
        title: res.locals.title || app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null, // templates may override; html-start may fallback to /img/share-default.jpg
    };
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions + Passport (local strategy)
// ─────────────────────────────────────────────────────────────────────────────
const sessionSecret = process.env.SESSION_SECRET || "change-me-please";

app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
        },
        store: MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: 60 * 60 * 24 * 14, // 14 days
        }),
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

// Expose admin flag to views
app.use((req, res, next) => {
    res.locals.isAdmin = !!req.user;
    next();
});

// Protect admin routes
function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mailer + rate limit (Contact)
// ─────────────────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
});

// ─────────────────────────────────────────────────────────────────────────────
// Core pages
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact (email sending)
app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err || null,
    });
});

app.post("/contact", contactLimiter, async (req, res) => {
    try {
        const { email, message, name, website } = req.body;

        // Honeypot field (hidden input named 'website') should be blank
        if (website && website.trim() !== "") {
            return res.redirect("/contact?sent=1"); // silently OK for bots
        }

        if (!email || !message) {
            return res.redirect("/contact?err=missing");
        }
        if (message.length > 5000) {
            return res.redirect("/contact?err=toolong");
        }

        const escaped = (s = "") =>
            s.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));

        const html = `
      <h2>New contact message</h2>
      <p><strong>From:</strong> ${name ? escaped(name) + " — " : ""}${escaped(email)}</p>
      <p><strong>Time:</strong> ${new Date().toUTCString()}</p>
      <hr/>
      <pre style="white-space:pre-wrap;font:inherit">${escaped(message)}</pre>
    `;

        await mailer.sendMail({
            from: process.env.MAIL_FROM,
            to: process.env.MAIL_TO || app.locals.site.email || "owner@example.com",
            subject: `Contact form: ${name || email}`,
            replyTo: email,
            html,
        });

        return res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        return res.redirect("/contact?err=send");
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth pages
// ─────────────────────────────────────────────────────────────────────────────
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
    req.logout((err) => {
        if (err) return next(err);
        res.redirect("/blog");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blog (public)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
        const posts = await Post.find().sort({ createdAt: -1 }).lean();

        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            type: "website",
            url: absUrl(req, "/blog"),
            canonical: absUrl(req, "/blog"),
        };

        res.render("blog", { title: "Blog", posts, isAdmin: !!req.user });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");
        const post = await Post.findOne({ slug: req.params.slug }).lean();
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
            image: post.coverImage || absUrl(req, "/img/share-default.jpg"),
        };

        res.render("post", { title: post.title, post, html, isAdmin: !!req.user });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Blog admin (protected)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");
        const slug = slugify(title, { lower: true, strict: true });
        const existing = await Post.findOne({ slug }).lean();
        if (existing) return res.status(409).send("A post with this title already exists.");
        const html = mdToHtml(body);
        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null,
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
// SEO + diagnostics
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

// Simple diagnostics
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
                        "My first post from the bootcamp project! This site uses Node.js, Express, EJS, and MongoDB.",
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body:
                        "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel.",
                },
            ]);
        }
        res.send("Seeded (or already seeded).");
    } catch (e) {
        console.error("💥 /dev/seed error:", e);
        res.status(500).send("Seed error: " + e.message);
    }
});

// Health & 404
app.get("/health", (_req, res) => res.send("ok"));
app.use((_req, res) => res.status(404).send("Not Found"));

// Start server
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
