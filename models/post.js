// models/post.js
import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true },
        slug: { type: String, required: true, unique: true, index: true },
        body: { type: String, required: true },
        bodyHtml: { type: String, required: true },
        coverImage: { type: String, default: null },
        draft: { type: Boolean, default: false } // <-- NEW
    },
    { timestamps: true }
);

// Useful index for listing by date
postSchema.index({ createdAt: -1 });

const Post = mongoose.models.Post || mongoose.model("Post", postSchema);
export default Post;
