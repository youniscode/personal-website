// models/post.js
import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true },
        slug: { type: String, required: true, unique: true, index: true },
        body: { type: String, required: true },
        bodyHtml: { type: String },          // sanitized HTML
        coverImage: { type: String, default: null },

        // NEW
        tags: { type: [String], default: [] }, // store lowercase tags
        published: { type: Boolean, default: true }
    },
    { timestamps: true }
);

// Normalize tags to lowercase on save
postSchema.pre("save", function (next) {
    if (Array.isArray(this.tags)) {
        this.tags = this.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    }
    next();
});

const Post = mongoose.models.Post || mongoose.model("Post", postSchema);
export default Post;
