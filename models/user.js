// models/user.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
    {
        email: { type: String, required: true, trim: true, lowercase: true },
        passwordHash: { type: String, required: true },
    },
    { timestamps: true }
);

// single unique index (one source of truth)
userSchema.index({ email: 1 }, { unique: true, name: "email_1" });

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
