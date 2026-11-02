
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = "/tmp/dimasclip-uploads";
const clipDir = path.join(uploadDir, "clips");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(clipDir, { recursive: true });

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json());

const projects = new Map();

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

app.get("/", (req, res) => {
  res.json({
    name: "DIMASCLIP Backend",
    status: "online",
    version: "3.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "3.0",
    engine: "connected",
    videoProcessing: Boolean(ffmpegPath)
  });
});

app.post("/api/import", (req, res) => {
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

    projects.set(id, project);

    res.json({
      success: true,
      message: "YouTube link accepted. Upload an authorized video file to continue.",
      project
    });
  } catch {
    res.status(400).json({ error: "Invalid URL." });
  }
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file received." });
  }

  let project = req.body.projectId
    ? projects.get(req.body.projectId)
    : null;

  if (!project) {
    const id = crypto.randomUUID();

    project = {
      id,
      sourceUrl: null,
      status: "video_uploaded",
      clips: [],
      createdAt: new Date().toISOString()
    };

    projects.set(id, project);
  }

  project.video = {
    name: req.file.originalname,
    filename: req.file.filename,
    path: req.file.path,
    size: req.file.size
  };

  project.status = "video_uploaded";

  res.json({
    success: true,
    message: "Video uploaded successfully.",
    project: {
      id: project.id,
      video: { name: project.video.name },
      status: project.status
    }
  });
});

// Create a video clip using start time and duration
app.post("/api/projects/:id/clip", (req, res) => {
  const project = projects.get(req.params.id);

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

  ffmpeg(project.video.path)
    .setStartTime(startTime)
    .setDuration(duration)
    .videoCodec("libx264")
    .audioCodec("aac")
    .outputOptions(["-movflags +faststart"])
    .on("end", () => {
      const clip = {
        filename,
        url: `/api/clips/${filename}`,
        startTime,
        duration
      };

      project.clips.push(clip);
      project.status = "clip_created";

      res.json({
        success: true,
        message: "Your clip is ready!",
        clip
      });
    })
    .on("error", (error) => {
      project.status = "video_uploaded";
      console.error("FFmpeg error:", error.message);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Video processing failed. Please try another video."
        });
      }
    })
    .save(outputPath);
});

// Download a generated clip
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

app.get("/api/projects", (req, res) => {
  res.json({ projects: Array.from(projects.values()) });
});

app.get("/api/projects/:id", (req, res) => {
  const project = projects.get(req.params.id);

  if (!project) {
    return res.status(404).json({ error: "Project not found." });
  }

  res.json({ project });
});

app.delete("/api/projects/:id", (req, res) => {
  const project = projects.get(req.params.id);

  if (project?.video?.path && fs.existsSync(project.video.path)) {
    fs.unlinkSync(project.video.path);
  }

  projects.delete(req.params.id);

  res.json({ success: true });
});

app.use((error, req, res, next) => {
  console.error(error.message);

  res.status(error instanceof multer.MulterError ? 400 : 500).json({
    error: error.message || "Something went wrong."
  });
});

app.listen(PORT, () => {
  console.log(`DIMASCLIP backend running on port ${PORT}`);
});
