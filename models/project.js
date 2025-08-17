import mongoose from "mongoose";
const projectSchema = new mongoose.Schema({
    name: String,
    description: String,
    link: String,
    tags: [String],
    createdAt: { type: Date, default: Date.now }
});
export default mongoose.model("Project", projectSchema);
