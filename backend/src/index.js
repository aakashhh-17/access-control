import express from "express";
import cors from "cors";
import { pool } from "./db.js";
import { config } from "./config.js";
import { errorHandler } from "./middleware/errors.js";
import authRoutes from "./routes/auth.js";
import jobRoutes from "./routes/jobs.js";
import grantRoutes from "./routes/grants.js";
import delegationRoutes from "./routes/delegations.js";
import parserRoutes from "./routes/parser.js";

const app = express();

app.use(cors()); 
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) =>
  res.json({ ok: true, service: "NFPL Access Control API" }),
);
app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/", authRoutes); // /auth/login, /auth/demo-users, /me, /users
app.use("/jobs", jobRoutes);
app.use("/grants", grantRoutes);
app.use("/delegations", delegationRoutes);
app.use("/parser", parserRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

pool
  .query("SELECT NOW()")
  .then(() => console.log("Connected to Neon"))
  .catch((err) => console.error("DB connection failed:", err.message));

if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  app.listen(config.port, () =>
    console.log(
      `NFPL access-control API on :${config.port} (schema ${config.schema})`,
    ),
  );
}

export default app;
