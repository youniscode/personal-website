// app.js — Personal site (Express + EJS + MongoDB + Passport + Nodemailer)

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

// Mail
import nodemailer from "nodemailer";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Env + app bootstrap
// ─────────────────────────────────────────────────────────────────────────────
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Views / static / body parsing
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site data for templates
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// active nav helper
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Helpers: Markdown → safe HTML, URLs, summary
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
            "h6"
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
    const text = String(htmlOrMd).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// default SEO meta
app.use((req, res, next) => {
    res.locals.meta = {
        title: res.locals.title || app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null
    };
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) MongoDB
// ─────────────────────────────────────────────────────────────────────────────
if (NODE_ENV === "production") {
    // Prevent index rebuilds on startup
    mongoose.set("autoIndex", false);
}

if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch(err => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️ MONGO_URI not set; DB features will be disabled.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Sessions + Passport (local strategy)
// ─────────────────────────────────────────────────────────────────────────────
const sessionSecret = process.env.SESSION_SECRET || "change-me-please";

app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
            secure: NODE_ENV === "production",
            sameSite: "lax"
        },
        store: process.env.MONGO_URI
            ? MongoStore.create({
                mongoUrl: process.env.MONGO_URI,
                ttl: 60 * 60 * 24 * 14 // 14 days
            })
            : undefined
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

// expose isAdmin to templates
app.use((req, res, next) => {
    res.locals.isAdmin = !!req.user;
    next();
});

function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Mail transport (contact form)
// ─────────────────────────────────────────────────────────────────────────────
function makeTransport() {
    // Prefer MAIL_SERVICE (like "gmail") with MAIL_USER/MAIL_PASS
    if (process.env.MAIL_SERVICE && process.env.MAIL_USER && process.env.MAIL_PASS) {
        return nodemailer.createTransport({
            service: process.env.MAIL_SERVICE,
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            }
        });
    }

    // Fallback to manual host/port
    if (process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS) {
        const secure =
            String(process.env.MAIL_SECURE || "").toLowerCase() === "true" ||
            Number(process.env.MAIL_PORT) === 465;

        const tls =
            process.env.MAIL_ALLOW_SELF_SIGNED === "1"
                ? { rejectUnauthorized: false }
                : undefined;

        return nodemailer.createTransport({
            host: process.env.MAIL_HOST,
            port: Number(process.env.MAIL_PORT) || (secure ? 465 : 587),
            secure,
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            },
            tls
        });
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Core pages
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact
app.get("/contact", (req, res) => {
    res.render("contact", {
        title: "Contact",
        sent: req.query.sent === "1",
        err: req.query.err || null,
        form: { name: "", email: "", message: "" }
    });
});

app.post("/contact", async (req, res) => {
    const transporter = makeTransport();

    if (!transporter) {
        // Mail not configured on server
        return res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Email is not configured on the server.",
            form: {
                name: req.body.name || "",
                email: req.body.email || "",
                message: req.body.message || ""
            }
        });
    }

    try {
        const name = (req.body.name || "").trim();
        const fromEmail = (req.body.email || "").trim();
        const message = (req.body.message || "").trim();
        if (!fromEmail || !message) {
            return res.render("contact", {
                title: "Contact",
                sent: false,
                err: "Please provide your email and a message.",
                form: { name, email: fromEmail, message }
            });
        }

        const to = process.env.MAIL_TO || process.env.MAIL_USER;
        await transporter.sendMail({
            from: process.env.MAIL_FROM || fromEmail,
            replyTo: fromEmail,
            to,
            subject: `New message from ${name || "Contact form"}`,
            text: message,
            html: `<p>${message.replace(/\n/g, "<br>")}</p>`
        });

        res.redirect("/contact?sent=1");
    } catch (e) {
        console.error("📮 contact error:", e);
        res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Could not send your message. Try again later.",
            form: {
                name: req.body.name || "",
                email: req.body.email || "",
                message: req.body.message || ""
            }
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Auth pages (login / logout / change password)
// ─────────────────────────────────────────────────────────────────────────────
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
    req.logout(err => {
        if (err) return next(err);
        res.redirect("/blog");
    });
});

// Change password
app.get("/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { error: null, success: null });
});
// alias for old link
app.get("/admin/change-password", (req, res) => res.redirect("/change-password"));

app.post("/change-password", ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.status(400).render("change-password", {
                error: "Please fill in all fields.",
                success: null
            });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).render("change-password", {
                error: "New passwords do not match.",
                success: null
            });
        }

        const user = await User.findById(req.user._id);
        const ok = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!ok) {
            return res.status(400).render("change-password", {
                error: "Current password is incorrect.",
                success: null
            });
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();

        return res.render("change-password", {
            error: null,
            success: "Password updated successfully."
        });
    } catch (e) {
        console.error("change-password error:", e);
        return res.status(500).render("change-password", {
            error: "Something went wrong. Please try again.",
            success: null
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Blog: list (with search + tags + pagination) & post page
// ─────────────────────────────────────────────────────────────────────────────
// Blog list with search + tag + status + pagination
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.size || "5", 10), 1), 20);
        const q = (req.query.q || "").trim();
        const tag = (req.query.tag || "").trim();
        const status = (req.query.status || "").trim(); // ← NEW

        const filter = {};

        // Status filtering rules:
        // - status=published → only published
        // - status=draft     → only drafts (admin-only meaningful, but we allow if someone hits the URL)
        // - status empty     → show all to admin; hide drafts from public
        if (status === "published") {
            filter.published = true;
        } else if (status === "draft") {
            filter.published = false;
        } else {
            if (!req.user) filter.published = { $ne: false }; // hide drafts from public
            // if admin and no status → show everything
        }

        if (q) {
            filter.$or = [
                { title: { $regex: q, $options: "i" } },
                { body: { $regex: q, $options: "i" } }
            ];
        }

        if (tag) {
            filter.tags = tag;
        }

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
            canonical: absUrl(req, "/blog"),
        };

        res.render("blog", {
            title: "Blog",
            posts,
            page,
            totalPages,
            q,
            tag,
            status,           // ← NEW: send it to the view
            isAdmin: !!req.user
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
// 9) Blog admin (create / edit / delete) — protected
//     Supports: coverImage, tags (comma/space-separated), published toggle
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/blog/new", ensureAuth, (_req, res) => {
    res.render("new-post", { title: "New Post" });
});

function parseTags(input = "") {
    return (input || "")
        .split(/[,\n ]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

app.post("/admin/blog", ensureAuth, async (req, res) => {
    try {
        const { title, body, coverImage, tags, published } = req.body;
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
            tags: parseTags(tags),
            published: published === "on"
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
        current.tags = parseTags(tags);
        current.published = published === "on";

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
// 10) SEO + diagnostics
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map(u => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");

        const posts = await Post.find({ published: { $ne: false } }).sort({ createdAt: -1 }).lean();
        const postUrls = posts
            .map(p => `  <url><loc>${base}/blog/${p.slug}</loc><changefreq>weekly</changefreq></url>`)
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
            .map(p => {
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

// Diagnostics / seed / health
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
                    tags: ["intro"],
                    published: true
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body:
                        "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel.",
                    tags: ["learning", "fullstack"],
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
app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
});
