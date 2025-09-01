// app.js — Personal site: Express + EJS + Mongo + Auth + Blog (tags/search/pagination) + Contact mail + SEO

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import slugify from "slugify";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import bcrypt from "bcrypt";

// Auth/session
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import MongoStore from "connect-mongo";

// Mail
import nodemailer from "nodemailer";

// Models
import Post from "./models/post.js";
import User from "./models/user.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Views / static ----------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// ---------- Site globals ----------
app.locals.site = {
    name: process.env.NAME || "YourName",
    role: process.env.ROLE || "",
    email: process.env.EMAIL || "",
    phone: process.env.PHONE || "",
    location: process.env.LOCATION || "",
    linkedin: process.env.LINKEDIN || "",
    cvUrl: process.env.CV_URL || ""
};

// active path for nav
app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
});

// ---------- Utils ----------
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

// ---------- Default SEO meta ----------
app.use((req, res, next) => {
    res.locals.meta = {
        title: app.locals.site.name,
        description: app.locals.site.role || "",
        type: "website",
        url: absUrl(req, req.path),
        canonical: absUrl(req, req.path),
        image: null
    };
    next();
});

// ---------- Mongo ----------
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

// ---------- Session + Passport ----------
const sessionSecret = process.env.SESSION_SECRET || "change-me-please";

app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
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
    try {
        const user = await User.findById(id).lean();
        done(null, user);
    } catch (e) {
        done(e);
    }
});

app.use(passport.initialize());
app.use(passport.session());

// expose admin flag
app.use((req, res, next) => {
    res.locals.isAdmin = !!req.user;
    next();
});

// auth guard
function ensureAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ---------- Mail transport ----------
let transporter = null;
(function setupMailer() {
    const hasService = !!process.env.MAIL_SERVICE;
    const hasHost = !!process.env.MAIL_HOST;
    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;

    if ((hasService || hasHost) && user && pass) {
        const options = hasService
            ? {
                service: process.env.MAIL_SERVICE,
                auth: { user, pass }
            }
            : {
                host: process.env.MAIL_HOST,
                port: Number(process.env.MAIL_PORT) || 465,
                secure: String(process.env.MAIL_SECURE || "true").toLowerCase() === "true",
                auth: { user, pass }
            };

        // allow local corporate MITM certs if needed
        if (process.env.MAIL_TLS_REJECT_UNAUTHORIZED === "0") {
            options.tls = { rejectUnauthorized: false };
        }

        transporter = nodemailer.createTransport(options);
    } else {
        console.log("📧 Mail transport disabled (missing env).");
    }
})();

// ---------- Core pages ----------
app.get("/", (req, res) => res.render("home", { title: "Home" }));
app.get("/about", (req, res) => res.render("about", { title: "About" }));
app.get("/projects", (req, res) => res.render("projects", { title: "Projects" }));

// Contact (GET shows form; POST sends)
app.get("/contact", (req, res) => {
    res.render("contact", { title: "Contact", sent: false, err: null, form: {} });
});

app.post("/contact", async (req, res) => {
    const { name = "", email = "", message = "" } = req.body || {};
    if (!email || !message) {
        return res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Please provide your email and a message.",
            form: { name, email, message }
        });
    }

    if (!transporter) {
        return res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Email is not configured on the server.",
            form: { name, email, message }
        });
    }

    try {
        const to = process.env.MAIL_TO || process.env.EMAIL || process.env.MAIL_USER;
        await transporter.sendMail({
            from: process.env.MAIL_FROM || process.env.MAIL_USER,
            to,
            subject: `Website contact from ${name || email}`,
            replyTo: email,
            text: message,
            html: `<p><strong>From:</strong> ${name || "(no name)"} &lt;${email}&gt;</p><p>${message.replace(
                /\n/g,
                "<br>"
            )}</p>`
        });

        res.render("contact", {
            title: "Contact",
            sent: true,
            err: null,
            form: {}
        });
    } catch (e) {
        console.error("📮 contact error:", e);
        res.render("contact", {
            title: "Contact",
            sent: false,
            err: "Could not send your message. Try again later.",
            form: { name, email, message }
        });
    }
});

// ---------- Auth ----------
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

// Change password (admin)
app.get("/admin/change-password", ensureAuth, (req, res) => {
    res.render("change-password", { title: "Change Password", error: null, ok: null });
});

app.post("/admin/change-password", ensureAuth, async (req, res) => {
    const { currentPassword = "", newPassword = "", confirmPassword = "" } = req.body || {};
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.render("change-password", { title: "Change Password", error: "User not found.", ok: null });

        const ok = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!ok) return res.render("change-password", { title: "Change Password", error: "Current password is incorrect.", ok: null });

        if (!newPassword || newPassword.length < 8) {
            return res.render("change-password", { title: "Change Password", error: "New password must be at least 8 characters.", ok: null });
        }
        if (newPassword !== confirmPassword) {
            return res.render("change-password", { title: "Change Password", error: "Passwords do not match.", ok: null });
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();
        res.render("change-password", { title: "Change Password", error: null, ok: "Password updated successfully." });
    } catch (e) {
        console.error("change-password error:", e);
        res.render("change-password", { title: "Change Password", error: "Unexpected error.", ok: null });
    }
});

// ---------- Blog (public) ----------
app.get("/blog", async (req, res) => {
    try {
        const q = req.query.q || "";
        const tag = req.query.tag || "";
        const page = Math.max(1, parseInt(req.query.page)) || 1;
        const limit = 5;

        // IMPORTANT: show documents where published === true OR field doesn't exist (old posts)
        const baseFilter = { $or: [{ published: true }, { published: { $exists: false } }] };

        const filter = {
            $and: [
                baseFilter,
                q
                    ? {
                        $or: [
                            { title: new RegExp(q, "i") },
                            { body: new RegExp(q, "i") }
                        ]
                    }
                    : {},
                tag ? { tags: tag.toLowerCase() } : {}
            ]
        };

        const total = await Post.countDocuments(filter);
        const posts = await Post.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // SEO
        res.locals.meta = {
            ...res.locals.meta,
            title: `Blog • ${app.locals.site.name}`,
            description: "Notes from my learning-in-public journey.",
            url: absUrl(req, "/blog"),
            canonical: absUrl(req, "/blog")
        };

        res.render("blog", {
            title: "Blog",
            posts,
            q,
            tag,
            page,
            totalPages: Math.max(1, Math.ceil(total / limit))
        });
    } catch (err) {
        console.error("💥 /blog error:", err);
        res.status(500).send("Blog failed: " + (err?.message || "unknown"));
    }
});

app.get("/blog/:slug", async (req, res) => {
    try {
        const post = await Post.findOne({
            slug: req.params.slug,
            $or: [{ published: true }, { published: { $exists: false } }]
        }).lean();

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
            image: post.coverImage || absUrl(req, "/img/blog/share-default.png")
        };

        res.render("post", { title: post.title, post, html });
    } catch (err) {
        console.error("💥 /blog/:slug error:", err);
        res.status(500).send("Post failed: " + (err?.message || "unknown"));
    }
});

// ---------- Blog admin (protected) ----------
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

        const tagArr = (tags || "")
            .split(",")
            .map(t => t.trim().toLowerCase())
            .filter(Boolean);

        const html = mdToHtml(body);
        await Post.create({
            title,
            slug,
            body,
            bodyHtml: html,
            coverImage: coverImage || null,
            tags: tagArr,
            published: published === "on" || published === true
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

        const tagArr = (tags || "")
            .split(",")
            .map(t => t.trim().toLowerCase())
            .filter(Boolean);

        current.title = title;
        current.slug = newSlug;
        current.body = body;
        current.bodyHtml = mdToHtml(body);
        current.coverImage = coverImage || null;
        current.tags = tagArr;
        current.published = published === "on" || published === true;

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

// ---------- SEO helpers ----------
app.get("/sitemap.xml", async (req, res) => {
    try {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
        const staticUrls = ["/", "/projects", "/about", "/contact", "/blog"]
            .map(u => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
            .join("\n");
        const posts = await Post.find({
            $or: [{ published: true }, { published: { $exists: false } }]
        })
            .sort({ createdAt: -1 })
            .lean();

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
        const posts = await Post.find({
            $or: [{ published: true }, { published: { $exists: false } }]
        })
            .sort({ createdAt: -1 })
            .lean();

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

// ---------- Dev helpers ----------
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
                    tags: ["intro", "node"],
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

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
