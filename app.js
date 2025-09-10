// app.js — Express + EJS + Mongo + Passport auth + Blog (search/tags/pagination + drafts) + Mail

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

import Post from "./models/post.js";
import User from "./models/user.js";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// ──────────────────────────────────────────────────────
// 1) Env + App boot
// ──────────────────────────────────────────────────────
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Views / static / forms
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site locals
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Active nav + default meta
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ──────────────────────────────────────────────────────
/** 2) Helpers */
// ──────────────────────────────────────────────────────
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
    const text = String(htmlOrMd).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// Default SEO meta for every request (route can override)
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

// ──────────────────────────────────────────────────────
// 3) MongoDB
// ──────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
}
if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️  MONGO_URI not set; DB features disabled.");
}

// ──────────────────────────────────────────────────────
// 4) Sessions + Passport (local)
// ──────────────────────────────────────────────────────
app.set("trust proxy", 1); // behind Render/Heroku proxies

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
                const user = await User.findOne({ email: (email || "").toLowerCase().trim() });
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

// Make admin flag/global
app.use((req, res, next) => {
    res.locals.isAdmin = !!req.user;
    next();
});

// Auth guard
function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ──────────────────────────────────────────────────────
// 5) Mailer (Gmail App Password recommended)
// ──────────────────────────────────────────────────────
function createTransportFromEnv() {
    const svc = (process.env.MAIL_SERVICE || "").toLowerCase();
    const opts = {};

    if (svc === "gmail") {
        // Gmail via App Password
        opts.service = "gmail";
        opts.auth = { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS };
    } else if (process.env.MAIL_HOST) {
        opts.host = process.env.MAIL_HOST;
        opts.port = Number(process.env.MAIL_PORT) || 587;
        opts.secure = String(process.env.MAIL_SECURE || "").toLowerCase() === "true" || opts.port === 465;
        opts.auth = { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS };
    } else {
        // Sensible fallback for local dev misconfig
        opts.host = "smtp.gmail.com";
        opts.port = 465;
        opts.secure = true;
        opts.auth = { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS };
    }

    if (process.env.DEV_SKIP_TLS_VERIFY === "true") {
        opts.tls = { rejectUnauthorized: false };
    }

    return nodemailer.createTransport(opts);
}
const mailer = createTransportFromEnv();

// ──────────────────────────────────────────────────────
// 6) Core pages
// ──────────────────────────────────────────────────────
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
app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err || "",
        form: { name: "", email: "", message: "" } // keep template happy
    });
});
app.post("/contact", async (req, res) => {
    const { name = "", email = "", message = "" } = req.body || {};
    if (!email || !message) {
        return res.redirect(`/contact?err=${encodeURIComponent("Email and message are required.")}`);
    }
    try {
        const to = process.env.MAIL_TO || process.env.MAIL_USER || process.env.EMAIL;
        await mailer.sendMail({
            from: process.env.MAIL_FROM || process.env.EMAIL || "no-reply@example.com",
            to,
            subject: `[Website] Message from ${name || email}`,
            text: message,
            html: `<p>${message.replace(/\n/g, "<br>")}</p><hr><p>From: ${name || "(no name)"} &lt;${email}&gt;</p>`
        });
        res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Message failed to send. Try again later.",
            form: { name, email, message }
        });
    }
});

// ──────────────────────────────────────────────────────
// 7) Blog (public): search + tags + pagination, drafts hidden for visitors
// ──────────────────────────────────────────────────────
app.get("/blog", async (req, res) => {
    try {
        const isAdmin = !!req.user;
        const PAGE_SIZE = 6;
        const page = Math.max(1, parseInt(req.query.page || "1", 10));
        const qRaw = (req.query.q || "").trim();
        const tag = (req.query.tag || "").trim().toLowerCase();

        const filter = isAdmin ? {} : { published: true };
        if (qRaw) {
            filter.$or = [
                { title: { $regex: qRaw, $options: "i" } },
                { body: { $regex: qRaw, $options: "i" } },
                { tags: { $regex: qRaw, $options: "i" } }
            ];
        }
        if (tag) filter.tags = tag;

        const total = await Post.countDocuments(filter);
        const posts = await Post.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE)
            .lean();

        // SEO
        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            url: absUrl(req, "/blog"),
            canonical: absUrl(req, "/blog"),
            type: "website"
        };

        res.render("blog", {
            title: "Blog",
            posts,
            q: qRaw,
            tag,
            page,
            totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            isAdmin
        });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

// Single post
// Single post (with prev/next)
app.get("/blog/:slug", async (req, res) => {
    try {
        const isAdmin = !!req.user;
        const post = await Post.findOne({ slug: req.params.slug }).lean();
        if (!post) return res.status(404).send("Post not found");

        // Hide drafts from non-admins
        if (post.published === false && !isAdmin) {
            return res.status(404).send("Post not found");
        }

        const html = post.bodyHtml || mdToHtml(post.body || "");
        const desc = summarize(html, 180);
        const shareUrl = absUrl(req, `/blog/${post.slug}`);

        // Build base filter for adjacent posts (respect draft visibility)
        const baseFilter = isAdmin ? {} : { published: true };

        // Find previous (newer than current) and next (older than current) by createdAt
        const prevDoc = await Post.find({
            ...baseFilter,
            createdAt: { $gt: post.createdAt }
        })
            .sort({ createdAt: 1 }) // the nearest newer one
            .limit(1)
            .lean();

        const nextDoc = await Post.find({
            ...baseFilter,
            createdAt: { $lt: post.createdAt }
        })
            .sort({ createdAt: -1 }) // the nearest older one
            .limit(1)
            .lean();

        const prev = prevDoc[0] || null;
        const next = nextDoc[0] || null;

        // SEO
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
            isAdmin,
            prev,
            next
        });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});


// ──────────────────────────────────────────────────────
// 8) Admin blog (new/edit/delete) with published + tags
// ──────────────────────────────────────────────────────

// New post form
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

// Create
app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");

        const tags = (req.body.tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        const published = req.body.published === "on";

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
            tags,
            published
        });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

// Edit form
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

// Update
app.post("/admin/blog/:slug", ensureAuth, async (req, res) => {
    try {
        const current = await Post.findOne({ slug: req.params.slug });
        if (!current) return res.status(404).send("Post not found");

        const { title, body, coverImage } = req.body;
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

        current.tags = (req.body.tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        current.published = req.body.published === "on";

        await current.save();
        res.redirect(`/blog/${current.slug}`);
    } catch (err) {
        console.error("💥 POST update error:", err);
        res.status(500).send("Failed to update post.");
    }
});

// Delete
app.post("/admin/blog/:slug/delete", ensureAuth, async (req, res) => {
    try {
        await Post.deleteOne({ slug: req.params.slug });
        res.redirect("/blog");
    } catch (err) {
        console.error("💥 delete error:", err);
        res.status(500).send("Failed to delete post.");
    }
});

// ──────────────────────────────────────────────────────
// 9) Auth routes (login/logout) + change-password
// ──────────────────────────────────────────────────────
app.get("/login", (req, res) => {
    res.render("login", {
        title: "Login",
        error: req.query.err ? "Invalid email or password." : null
    });
});
app.post(
    "/login",
    (req, _res, next) => {
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

// Change password (views/change-password.ejs)
app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: "", success: "" });
});
app.post("/admin/change-password", ensureAuth, async (req, res) => {
    const { currentPassword = "", newPassword = "", confirmPassword = "" } = req.body || {};
    const user = await User.findById(req.user._id);
    if (!user) return res.render("change-password", { title: "Change Password", error: "User not found.", success: "" });

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.render("change-password", { title: "Change Password", error: "Current password is incorrect.", success: "" });

    if (!newPassword || newPassword.length < 8) {
        return res.render("change-password", { title: "Change Password", error: "New password must be at least 8 characters.", success: "" });
    }
    if (newPassword !== confirmPassword) {
        return res.render("change-password", { title: "Change Password", error: "Passwords do not match.", success: "" });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.render("change-password", { title: "Change Password", error: "", success: "Password updated successfully." });
});

// ──────────────────────────────────────────────────────
/* 10) SEO: sitemap + rss */
// ──────────────────────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const posts = await Post.find({ published: true }).sort({ createdAt: -1 }).lean();
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

// ──────────────────────────────────────────────────────
// 11) Diagnostics + 404
// ──────────────────────────────────────────────────────
app.get("/diag", (_req, res) => {
    res.json({
        hasEnv: !!process.env.MONGO_URI,
        readyState: mongoose.connection?.readyState,
        host: mongoose.connection?.host
    });
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
                    bodyHtml: mdToHtml("My first post from the bootcamp project!\n\nThis site uses Node.js, Express, EJS, and MongoDB on Render."),
                    coverImage: "",
                    tags: ["intro"],
                    published: true
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body: "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel.",
                    bodyHtml: mdToHtml("Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel."),
                    coverImage: "",
                    tags: ["notes"],
                    published: true
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

// ──────────────────────────────────────────────────────
// 12) Start server
// ──────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});
