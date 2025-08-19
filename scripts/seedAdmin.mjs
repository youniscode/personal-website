import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import User from "../models/user.js";  // 👈 we’ll create this model

const uri = process.env.MONGO_URI;
const email = process.env.ADMIN_SEED_EMAIL;
const pass = process.env.ADMIN_SEED_PASSWORD;

if (!uri || !email || !pass) {
    console.error("Missing MONGO_URI / ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD");
    process.exit(1);
}

await mongoose.connect(uri);
const exists = await User.findOne({ email });

if (exists) {
    console.log("Admin already exists:", email);
} else {
    const passwordHash = await bcrypt.hash(pass, 12);
    await User.create({ email, passwordHash });
    console.log("✅ Admin created:", email);
}

await mongoose.disconnect();
process.exit(0);
