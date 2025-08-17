import mongoose from "mongoose";
const postSchema = new mongoose.Schema({
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    body: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
export default mongoose.model("Post", postSchema);
