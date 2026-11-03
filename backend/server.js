
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from environment variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Temporary video storage
const uploadDir = "/tmp/dimasclip-uploads";
const clipDir = path.join(uploadDir, "clips");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(clipDir, { recursive: true });

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json());

// Async error handler
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Database setup
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      project_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("DIMASCLIP PostgreSQL database connected.");
}

// Database helpers
async function saveProject(project) {
  await pool.query(
    `INSERT INTO projects (id, project_data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id)
     DO UPDATE SET project_data = EXCLUDED.project_data`,
    [project.id, JSON.stringify(project)]
  );

  return project;
}

async function getProject(id) {
  const result = await pool.query(
    "SELECT project_data FROM projects WHERE id = $1",
    [id]
  );

  return result.rows[0]?.project_data || null;
}

// Video upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".mp4", ".mov", ".webm", ".m4v", ".mkv"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error("Unsupported video format."));
  }
});

// Homepage
app.get("/", (req, res) => {
  res.json({
    name: "DIMASCLIP Backend",
    status: "online",
    version: "3.1"
  });
});

// Health check
app.get("/api/health", asyncHandler(async (req, res) => {
  await pool.query("SELECT 1");

  res.json({
    status: "ok",
    version: "3.1",
    engine: "connected",
    database: "connected",
    videoProcessing: Boolean(ffmpegPath)
  });
}));

// Import YouTube link
app.post("/api/import", asyncHandler(async (req, res) => {
  const { url } = req.body;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    const validHosts = [
      "youtube.com",
      "m.youtube.com",
      "youtu.be"
    ];

    if (!validHosts.includes(host)) {
      return res.status(400).json({
        error: "Please enter a valid YouTube link."
      });
    }

    const id = crypto.randomUUID();

    const project = {
      id,
      sourceUrl: url,
      status: "awaiting_video_file",
      video: null,
      clips: [],
      createdAt: new Date().toISOString()
    };

    await saveProject(project);

    res.json({
      success: true,
      message: "YouTube link accepted. Upload an authorized video file to continue.",
      project
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(400).json({ error: "Invalid URL." });
    }
    throw error;
  }
}));

// Upload video
app.post(
  "/api/upload",
  upload.single("video"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file received." });
    }

    let project = req.body.projectId
      ? await getProject(req.body.projectId)
      : null;

    if (!project) {
      project = {
        id: crypto.randomUUID(),
        sourceUrl: null,
        status: "video_uploaded",
        video: null,
        clips: [],
        createdAt: new Date().toISOString()
      };
    }

    project.video = {
      name: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    };

    project.status = "video_uploaded";

    await saveProject(project);

    res.json({
      success: true,
      message: "Video uploaded successfully.",
      project: {
        id: project.id,
        video: { name: project.video.name },
        status: project.status
      }
    });
  })
);

// Create video clip
app.post("/api/projects/:id/clip", asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);

  if (!project || !project.video) {
    return res.status(404).json({
      error: "Project or uploaded video not found."
    });
  }

  const startTime = Number(req.body.startTime);
  const duration = Number(req.body.duration);

  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(duration) ||
    startTime < 0 ||
    duration <= 0 ||
    duration > 180
  ) {
    return res.status(400).json({
      error: "Enter a valid start time and a duration up to 180 seconds."
    });
  }

  if (!fs.existsSync(project.video.path)) {
    return res.status(404).json({
      error: "Uploaded video file is no longer available. Please upload it again."
    });
  }

  const filename = crypto.randomUUID() + ".mp4";
  const outputPath = path.join(clipDir, filename);

  project.status = "processing";
  await saveProject(project);

  ffmpeg(project.video.path)
    .setStartTime(startTime)
    .setDuration(duration)
    .videoCodec("libx264")
    .audioCodec("aac")
    .outputOptions(["-movflags +faststart"])
    .on("end", async () => {
      try {
        const clip = {
          filename,
          url: `/api/clips/${filename}`,
          startTime,
          duration
        };

        project.clips.push(clip);
        project.status = "clip_created";

        await saveProject(project);

        res.json({
          success: true,
          message: "Your clip is ready!",
          clip
        });
      } catch (error) {
        console.error("Database save error:", error.message);

        if (!res.headersSent) {
          res.status(500).json({
            error: "Clip created, but saving its project record failed."
          });
        }
      }
    })
    .on("error", async (error) => {
      console.error("FFmpeg error:", error.message);

      try {
        project.status = "video_uploaded";
        await saveProject(project);
      } catch (dbError) {
        console.error("Database update error:", dbError.message);
      }

      if (!res.headersSent) {
        res.status(500).json({
          error: "Video processing failed. Please try another video."
        });
      }
    })
    .save(outputPath);
}));

// Download generated clip
app.get("/api/clips/:filename", (req, res) => {
  const filename = req.params.filename;

  if (!/^[a-f0-9-]+\.mp4$/i.test(filename)) {
    return res.status(400).json({ error: "Invalid filename." });
  }

  const filePath = path.join(clipDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Clip not found." });
  }

  res.download(filePath);
});

// Get all projects
app.get("/api/projects", asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT project_data FROM projects ORDER BY created_at DESC"
  );

  res.json({
    projects: result.rows.map(row => row.project_data)
  });
}));

// Get one project
app.get("/api/projects/:id", asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);

  if (!project) {
    return res.status(404).json({ error: "Project not found." });
  }

  res.json({ project });
}));

// Delete project
app.delete("/api/projects/:id", asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);

  if (!project) {
    return res.status(404).json({ error: "Project not found." });
  }

  if (project.video?.path && fs.existsSync(project.video.path)) {
    fs.unlinkSync(project.video.path);
  }

  await pool.query(
    "DELETE FROM projects WHERE id = $1",
    [req.params.id]
  );

  res.json({ success: true });
}));

// Error handler
app.use((error, req, res, next) => {
  console.error(error.message);

  if (res.headersSent) return next(error);

  res.status(error instanceof multer.MulterError ? 400 : 500).json({
    error: error.message || "Something went wrong."
  });
});

// Start server after database is ready
async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`DIMASCLIP backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start DIMASCLIP:", error.message);
    process.exit(1);
  }
}

startServer();
