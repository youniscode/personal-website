// app.js — Express + EJS + Mongo + Markdown blog + Passport auth
// ------------------------------------------------------------------

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Post from "./models/post.js";       // Post schema should include { published: { type:Boolean, default:true } }
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

dotenv.config();

// ------------------------------------------------------------------
// App bootstrap
// ------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Views/static/body
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// Site-wide locals (available in all templates as "site")
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// Make current path available for active-nav styles
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ------------------------------------------------------------------
// Helpers: Markdown → Safe HTML, absolute URL, summarizer, default meta
// ------------------------------------------------------------------
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
            a: (_t, attrs) => ({
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

// Default meta (pages can override later)
app.use((req, res, next) => {
    res.locals.meta = {
        title: res.locals.title || app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null // html-start.ejs should fall back to /img/share-default.jpg
    };
    next();
});

// ------------------------------------------------------------------
// MongoDB (disable autoIndex in production to avoid index rebuilds)
// ------------------------------------------------------------------
if (process.env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
}

if (process.env.MONGO_URI) {
    mongoose
        .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("✅ MongoDB connected"))
        .catch((err) => console.error("❌ Mongo error:", err.message));
} else {
    console.warn("⚠️  MONGO_URI not set; blog will be disabled.");
}

// ------------------------------------------------------------------
// Sessions + Passport (local strategy)
// ------------------------------------------------------------------
const sessionSecret = process.env.SESSION_SECRET || "change-me-please";

// IMPORTANT: trust Render's proxy so 'secure' cookies work over HTTPS
if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 7,                 // 7 days
            secure: process.env.NODE_ENV === "production",   // HTTPS-only in prod
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

// Expose admin + flash (non-breaking defaults) to all views
app.use((req, res, next) => {
    res.locals.isAdmin = !!req.user;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
});

function setFlash(req, type, text) {
    req.session.flash = { type, text };
}

// Require login for admin routes
function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ------------------------------------------------------------------
// Core pages
// ------------------------------------------------------------------
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact (demo)
app.get("/contact", (req, res) =>
    res.render("contact", { title: "Contact", sent: req.query.sent === "1" })
);
app.post("/contact", (req, res) => {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).send("Email and message are required.");
    console.log("📩 Contact form:", { email, message });
    res.redirect("/contact?sent=1");
});

// ------------------------------------------------------------------
// Auth pages
// ------------------------------------------------------------------
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

// Admin landing (simple)
app.get("/admin", ensureAuth, (req, res) => {
    res.render("admin", { title: "Admin" });
});

// Change password
app.get("/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password" });
});
app.post("/change-password", ensureAuth, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    try {
        if (!currentPassword || !newPassword || !confirmPassword) {
            setFlash(req, "warning", "All fields are required.");
            return res.redirect("/change-password");
        }
        if (newPassword !== confirmPassword) {
            setFlash(req, "warning", "New passwords do not match.");
            return res.redirect("/change-password");
        }
        const user = await User.findById(req.user._id);
        const ok = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!ok) {
            setFlash(req, "danger", "Current password is incorrect.");
            return res.redirect("/change-password");
        }
        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();
        setFlash(req, "success", "Password updated.");
        res.redirect("/blog");
    } catch (e) {
        console.error("change-password error:", e);
        setFlash(req, "danger", "Something went wrong.");
        res.redirect("/change-password");
    }
});

// ------------------------------------------------------------------
// Blog (public + admin views)
// ------------------------------------------------------------------

// List posts
app.get("/blog", async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).send("DB not connected");

        const filter = req.user ? {} : { published: true };
        const posts = await Post.find(filter).sort({ createdAt: -1 }).lean();

        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            type: "website",
            url: absUrl(req, "/blog"),
            canonical: absUrl(req, "/blog")
        };

        res.render("blog", { title: "Blog", posts, isAdmin: !!req.user });
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
        if (!post.published && !req.user) return res.status(404).send("Post not found");

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

// Admin: New post
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

// Admin: Edit post
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

// ------------------------------------------------------------------
// SEO + diagnostics
// ------------------------------------------------------------------
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map(u => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");
        const posts = await Post.find({ published: true }).sort({ createdAt: -1 }).lean();
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
        const posts = await Post.find({ published: true }).sort({ createdAt: -1 }).lean();
        const items = posts.map(p => {
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
        }).join("\n");
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

// Quick diag + seed + health
app.get("/diag", (_req, res) => {
    const hasEnv = Boolean(process.env.MONGO_URI);
    const readyState = mongoose.connection?.readyState; // 0..3
    const host = mongoose.connection?.host;
    res.json({ hasEnv, readyState, host, nodeEnv: process.env.NODE_ENV });
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
                    published: true
                },
                {
                    title: "Learning Full-Stack",
                    slug: "learning-full-stack",
                    body: "Building while studying is the fastest way to learn. Next up: auth with Passport and an admin panel.",
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

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
