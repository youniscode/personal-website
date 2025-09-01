// models/post.js
import mongoose from "mongoose";

const PostSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        slug: { type: String, required: true, unique: true, index: true },
        body: { type: String, required: true },
        bodyHtml: String,
        coverImage: String,
        tags: { type: [String], default: [] },

        // Default to published so legacy/new posts are visible unless explicitly unpublished
        published: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// Normalize tags to lowercase on save
PostSchema.pre("save", function (next) {
    if (Array.isArray(this.tags)) {
        this.tags = this.tags
            .map(t => String(t).trim().toLowerCase())
            .filter(Boolean);
    }
    next();
});

const Post = mongoose.models.Post || mongoose.model("Post", PostSchema);
export default Post;
