import express from "express";
import * as dotenv from "dotenv";
import authRouter from "./routes/auth";
import jobsRouter from "./routes/jobs";
import invitesRouter from "./routes/invites";
import creditsRouter from "./routes/credits";
import { initQueue } from "./queue";
import { startReaper } from "./reaper";
import { startRetentionSweeper } from "./retention";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON requests
app.use(express.json());

// Mount routers
app.use("/api/auth", authRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/invites", invitesRouter);
app.use("/api/credits", creditsRouter);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date() });
});

// Initialize services and start server
async function startServer() {
  console.log("Starting backend server...");
  
  // Initialize RabbitMQ connection
  await initQueue();

  // Background maintenance: reclaim credits from jobs that will never finish,
  // and expire stored images past the retention window.
  startReaper();
  startRetentionSweeper();

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
