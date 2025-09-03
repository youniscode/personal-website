// app.js — Personal site (Express + EJS + Mongo + Markdown + Auth + Mail)

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Auth deps
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import MongoStore from "connect-mongo";

// Mail
import nodemailer from "nodemailer";

// Models
import Post from "./models/post.js";
import User from "./models/user.js";

dotenv.config();

const app = express();
// Behind Render's proxy so secure cookies work
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Views / static / body parsing
// ─────────────────────────────────────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site locals (used by header/footer and meta helpers)
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || "",
};



// Markdown → safe HTML
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

// URL + summary helpers
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

// Default meta for every request (routes can override)
app.use((req, res, next) => {
    res.locals.meta = {
        title: app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null,
        robots: "index,follow",
    };
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MongoDB
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
    // avoid re-building indexes at startup
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
// Sessions + Passport (local strategy)
// ─────────────────────────────────────────────────────────────────────────────
// ───── Sessions + Passport (local strategy) ─────
const sessionSecret = process.env.SESSION_SECRET || "change-me-please";
app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax"
        },
        store: MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            ttl: 60 * 60 * 24 * 14 // 14 days
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
// Make current path + isAdmin available to all views
app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.isAdmin = !!req.user;
    next();
});

// Protect admin routes
function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mail transport helper (for contact form)
// ─────────────────────────────────────────────────────────────────────────────
function makeTransport() {
    const svc = (process.env.MAIL_SERVICE || "").toLowerCase().trim();
    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;

    if (svc === "gmail") {
        return nodemailer.createTransport({
            service: "gmail",
            auth: { user, pass },
            secure: true,
            tls: { rejectUnauthorized: false },
        });
    }

    // Custom SMTP
    const host = process.env.MAIL_HOST || "smtp.gmail.com";
    const port = Number(process.env.MAIL_PORT || 465);
    const secure = port === 465;
    return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
        tls: { rejectUnauthorized: false },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core pages
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.render("home", { title: "Home" });
});

app.get("/projects", (req, res) => {
    res.render("projects", { title: "Projects" });
});

app.get("/about", (req, res) => res.render("about", { title: "About" }));

app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err || null,
        form: { name: "", email: "", message: "" },
    });
});

app.post("/contact", async (req, res) => {
    const { name, email, message } = req.body;
    // quick validation
    if (!email || !message) {
        return res.status(400).render("contact", {
            title: "Contact",
            sent: false,
            err: "Please provide an email and a message.",
            form: { name: name || "", email: email || "", message: message || "" },
        });
    }

    try {
        const transporter = makeTransport();
        const to = process.env.MAIL_TO || process.env.EMAIL || process.env.MAIL_USER;
        const from = process.env.MAIL_FROM || `${app.locals.site.name} <${process.env.MAIL_USER || email}>`;

        await transporter.sendMail({
            from,
            to,
            subject: `Website contact from ${name || "Visitor"}`,
            replyTo: email,
            text: message,
            html: `<p><strong>From:</strong> ${name || "Visitor"} &lt;${email}&gt;</p><p>${message.replace(
                /\n/g,
                "<br/>"
            )}</p>`,
        });

        res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        res.status(500).render("contact", {
            title: "Contact",
            sent: false,
            err:
                process.env.NODE_ENV === "production"
                    ? "Could not send your message. Try again later."
                    : (e && e.message) || "Mail error",
            form: { name: name || "", email: email || "", message: message || "" },
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
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

// Change password (for logged-in admin)
app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: null, success: null });
});

app.post("/admin/change-password", ensureAuth, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    try {
        const user = await User.findById(req.user._id);
        if (!user) throw new Error("User not found");

        const ok = await bcrypt.compare(currentPassword || "", user.passwordHash);
        if (!ok) {
            return res.status(400).render("change-password", {
                title: "Change Password",
                error: "Current password is incorrect.",
                success: null,
            });
        }
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).render("change-password", {
                title: "Change Password",
                error: "New password must be at least 8 characters.",
                success: null,
            });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).render("change-password", {
                title: "Change Password",
                error: "Passwords do not match.",
                success: null,
            });
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();

        res.render("change-password", {
            title: "Change Password",
            error: null,
            success: "Password changed successfully.",
        });
    } catch (e) {
        console.error("change password error:", e);
        res.status(500).render("change-password", {
            title: "Change Password",
            error: "Something went wrong.",
            success: null,
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Blog (public + admin)
// ─────────────────────────────────────────────────────────────────────────────

// Build a public filter that also shows legacy posts without `published`
function publicPostFilter(base = {}) {
    return {
        ...base,
        $or: [{ published: { $exists: false } }, { published: true }],
    };
}

app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const pageSize = Math.max(parseInt(req.query.pageSize || "10", 10), 1);
        const q = (req.query.q || "").trim();
        const tag = (req.query.tag || "").trim().toLowerCase();

        // Search conditions
        const queryParts = [];
        if (q) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            queryParts.push({ $or: [{ title: rx }, { body: rx }] });
        }
        if (tag) {
            queryParts.push({ tags: tag });
        }
        const combined = queryParts.length ? { $and: queryParts } : {};

        // Admin can see all; public sees published OR missing
        const isAuthed = req.isAuthenticated && req.isAuthenticated();
        const filter = isAuthed ? combined : publicPostFilter(combined);

        const total = await Post.countDocuments(filter);
        const posts = await Post.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .lean();

        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            type: "website",
            url: absUrl(req, "/blog"),
            canonical: absUrl(req, "/blog"),
        };

        res.render("blog", {
            title: "Blog",
            posts,
            page,
            totalPages: Math.max(Math.ceil(total / pageSize), 1),
            q,
            tag,
            isAdmin: !!req.user,
        });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const isAuthed = req.isAuthenticated && req.isAuthenticated();
        const baseFilter = { slug: req.params.slug };
        const filter = isAuthed ? baseFilter : publicPostFilter(baseFilter);

        const post = await Post.findOne(filter).lean();
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
            image: post.coverImage || absUrl(req, "/img/blog/share-default.png"),
        };

        res.render("post", { title: post.title, post, html, isAdmin: !!req.user });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// New post (admin)
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        let { title, body, coverImage, tags, published } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");

        const slug = slugify(title, { lower: true, strict: true });
        const existing = await Post.findOne({ slug }).lean();
        if (existing) return res.status(409).send("A post with this title already exists.");

        const html = mdToHtml(body);
        const tagList = (tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null,
            tags: tagList,
            published: String(published) === "on" || String(published) === "true",
        });

        res.redirect(`/blog/${slug}`);
    } catch (err) {
        console.error("💥 create post error:", err);
        res.status(500).send("Failed to create post.");
    }
});

// Edit post (admin)
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
        let { title, body, coverImage, tags, published } = req.body;
        if (!title || !body) return res.status(400).send("Title and body are required.");

        const current = await Post.findOne({ slug: req.params.slug });
        if (!current) return res.status(404).send("Post not found");

        const newSlug = slugify(title, { lower: true, strict: true });
        if (newSlug !== current.slug) {
            const conflict = await Post.findOne({ slug: newSlug }).lean();
            if (conflict) return res.status(409).send("Another post already uses that title.");
        }

        const tagList = (tags || "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);

        current.title = title;
        current.slug = newSlug;
        current.body = body;
        current.bodyHtml = mdToHtml(body);
        current.coverImage = coverImage || null;
        current.tags = tagList;
        current.published = String(published) === "on" || String(published) === "true";

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
/** SEO: sitemap + RSS (public only) */
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const posts = await Post.find(publicPostFilter()).sort({ createdAt: -1 }).lean();
        const postUrls = posts
            .map(
                (p) =>
                    `  <url><loc>${base}/blog/${p.slug}</loc><changefreq>weekly</changefreq></url>`
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
        const posts = await Post.find(publicPostFilter()).sort({ createdAt: -1 }).lean();
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
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────
app.get("/diag", (_req, res) => {
    const hasEnv = Boolean(process.env.MONGO_URI);
    const readyState = mongoose.connection?.readyState;
    const host = mongoose.connection?.host;
    res.json({ hasEnv, readyState, host });
});

app.get("/health", (_req, res) => res.send("ok"));

// 404
app.use((_req, res) => res.status(404).send("Not Found"));

// Start server
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
