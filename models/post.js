import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        slug: { type: String, required: true, unique: true },
        body: { type: String, required: true },
        bodyHtml: { type: String },
        coverImage: { type: String } // ✅ optional URL or /img/... path
    },
    { timestamps: true }
);

export default mongoose.model("Post", postSchema);
