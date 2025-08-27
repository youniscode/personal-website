// app.js — Express + EJS + Mongo + Markdown blog + Passport auth + Mailer

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "./models/post.js";
import User from "./models/user.js";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Auth deps
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import MongoStore from "connect-mongo";

// Mailer
import nodemailer from "nodemailer";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Env + app bootstrap
// ─────────────────────────────────────────────────────────────────────────────
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, let MongoDB handle indexes (avoid auto-building)
if (process.env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
}

// Views/static/body
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true })); // for forms

// Global site data
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Active nav + user exposure
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Helpers (Markdown → Safe HTML, URL builder, summary text, default meta)
// ─────────────────────────────────────────────────────────────────────────────
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
            a: (_tag, attrs) => ({
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
    const text = String(htmlOrMd)
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// Default meta (overridable later)
app.use((req, res, next) => {
    res.locals.meta = {
        title: res.locals.title || app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null // fallback handled in html-start.ejs if desired
    };
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Nodemailer transport (Gmail App Password or generic SMTP)
// ─────────────────────────────────────────────────────────────────────────────
// DEV ONLY: relax TLS for antivirus HTTPS-intercepted networks
if (
    process.env.NODE_ENV !== "production" &&
    String(process.env.DEV_SKIP_TLS_VERIFY || "").toLowerCase() === "true"
) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("⚠️  TLS verification disabled for dev (NODE_TLS_REJECT_UNAUTHORIZED=0)");
}

let transporter = null;
const usingGmail =
    process.env.MAIL_SERVICE === "gmail" &&
    process.env.MAIL_USER &&
    process.env.MAIL_PASS;

if (usingGmail) {
    const relaxTls =
        process.env.NODE_ENV !== "production" &&
        String(process.env.DEV_SKIP_TLS_VERIFY || "").toLowerCase() === "true";

    transporter = nodemailer.createTransport({
        service: "gmail",
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
        tls: {
            minVersion: "TLSv1.2",
            servername: "smtp.gmail.com",
            rejectUnauthorized: !relaxTls
        }
    });
} else if (process.env.MAIL_HOST && process.env.MAIL_PORT) {
    const port = Number(process.env.MAIL_PORT);
    const secure =
        String(process.env.MAIL_SECURE || "").toLowerCase() === "true" || port === 465;

    const relaxTls =
        process.env.NODE_ENV !== "production" &&
        String(process.env.DEV_SKIP_TLS_VERIFY || "").toLowerCase() === "true";

    transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port,
        secure,
        auth:
            process.env.MAIL_USER && process.env.MAIL_PASS
                ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
                : undefined,
        tls: {
            minVersion: "TLSv1.2",
            rejectUnauthorized: !relaxTls
        }
    });
} else {
    transporter = null; // email disabled
}

if (transporter) {
    console.log("📧 Mail transport:", {
        service: process.env.MAIL_SERVICE || null,
        host: transporter.options.host || null,
        port: transporter.options.port || null,
        secure: !!transporter.options.secure,
        auth: transporter.options.auth ? "yes" : "no"
    });
} else {
    console.log("📧 Mail transport: disabled");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) MongoDB + Sessions + Passport (local strategy)
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; blog will be disabled.");
}

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

// Expose admin flag to views
app.use((req, res, next) => {
    res.locals.isAdmin = !!req.user;
    res.locals.user = req.user || null;
    next();
});

// Guard for admin routes
function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

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
        err: req.query.err ? decodeURIComponent(req.query.err) : null,
        form: {
            name: req.query.name || "",
            email: req.query.email || "",
            message: req.query.message || ""
        }
    });
});

app.post("/contact", async (req, res) => {
    try {
        const { name = "", email = "", message = "" } = req.body || {};
        if (!email || !message) {
            return res.redirect(
                `/contact?err=${encodeURIComponent("Email and message are required.")}&name=${encodeURIComponent(
                    name
                )}&email=${encodeURIComponent(email)}&message=${encodeURIComponent(message)}`
            );
        }
        if (!transporter) {
            return res.redirect(
                `/contact?err=${encodeURIComponent(
                    "Email is not configured on the server."
                )}&name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}&message=${encodeURIComponent(
                    message
                )}`
            );
        }

        const to = process.env.MAIL_TO || process.env.EMAIL || process.env.MAIL_USER;
        const from = process.env.MAIL_FROM || process.env.MAIL_USER;

        await transporter.sendMail({
            from,
            to,
            subject: `Website contact — ${name || "No name"}`,
            replyTo: email,
            text: message,
            html: `<p><strong>From:</strong> ${name || "(no name)"} &lt;${email}&gt;</p><p>${message
                .replace(/</g, "&lt;")
                .replace(/\n/g, "<br>")}</p>`
        });

        res.redirect("/contact?sent=1");
    } catch (err) {
        console.error("📮 contact error:", err);
        const q = new URLSearchParams({
            err: "Failed to send message. Please try again.",
            name: req.body?.name || "",
            email: req.body?.email || "",
            message: req.body?.message || ""
        }).toString();
        res.redirect(`/contact?${q}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Auth (login/logout) + change password
// ─────────────────────────────────────────────────────────────────────────────
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
    req.logout(err => {
        if (err) return next(err);
        res.redirect("/blog");
    });
});

app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: null, success: null });
});
app.post("/admin/change-password", ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        const user = await User.findById(req.user._id);
        if (!user) return res.status(401).send("Unauthorized");

        const ok = await bcrypt.compare(currentPassword || "", user.passwordHash);
        if (!ok) {
            return res.render("change-password", {
                title: "Change Password",
                error: "Current password is incorrect.",
                success: null
            });
        }
        if (!newPassword || newPassword.length < 8) {
            return res.render("change-password", {
                title: "Change Password",
                error: "New password must be at least 8 characters.",
                success: null
            });
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();
        res.render("change-password", {
            title: "Change Password",
            error: null,
            success: "Password updated successfully."
        });
    } catch (e) {
        console.error("⚠️ change-password error:", e);
        res.render("change-password", {
            title: "Change Password",
            error: "Something went wrong. Try again.",
            success: null
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Blog (public) — search + pagination + published filter
// ─────────────────────────────────────────────────────────────────────────────
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const q = (req.query.q || "").trim();
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const pageSize = 5;

        const filter = {};
        if (!req.user) filter.published = { $ne: false }; // show only published to public
        if (q) filter.title = { $regex: q, $options: "i" };

        const total = await Post.countDocuments(filter);
        const totalPages = Math.max(Math.ceil(total / pageSize), 1);

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
            canonical: absUrl(req, "/blog")
        };

        res.render("blog", { title: "Blog", posts, isAdmin: !!req.user, q, page, totalPages });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

app.get("/blog/:slug", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const filter = { slug: req.params.slug };
        if (!req.user) filter.published = { $ne: false };

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
            image: post.coverImage || absUrl(req, "/img/share-default.jpg")
        };

        res.render("post", { title: post.title, post, html, isAdmin: !!req.user });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Blog admin (create / edit / delete) — protected
//    supports coverImage + draft/publish (boolean "published")
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage } = req.body;
        const published = req.body.published === "on";

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
            published
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
        const published = req.body.published === "on";

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
        current.published = published;

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
// 9) SEO (sitemap + RSS) — only published posts for the public feeds
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const posts = await Post.find({ published: { $ne: false } })
            .sort({ createdAt: -1 })
            .lean();

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
        const posts = await Post.find({ published: { $ne: false } }).sort({ createdAt: -1 }).lean();

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
// 10) Diagnostics + health + 404
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
                    body: "My first post from the bootcamp project! This site uses Node.js, Express, EJS, and MongoDB.",
                    bodyHtml: mdToHtml("My first post from the bootcamp project! This site uses Node.js, Express, EJS, and MongoDB."),
                    coverImage: null,
                    published: true
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body: "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel.",
                    bodyHtml: mdToHtml("Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel."),
                    coverImage: null,
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

// ─────────────────────────────────────────────────────────────────────────────
// 11) Start server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
