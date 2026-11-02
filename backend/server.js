
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================
// DIMASCLIP CONFIGURATION
// ===================================

const uploadDir = "/tmp/dimasclip-uploads";

fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Temporary project storage.
// Production persistence will be added later.
const projects = new Map();

// ===================================
// VIDEO UPLOAD CONFIGURATION
// ===================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const allowedExtensions = [
  ".mp4",
  ".mov",
  ".webm",
  ".m4v",
  ".mkv"
];

const upload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (
      file.mimetype.startsWith("video/") &&
      allowedExtensions.includes(ext)
    ) {
      return cb(null, true);
    }

    cb(new Error("Unsupported video format."));
  }
});

// ===================================
// YOUTUBE LINK VALIDATION
// ===================================

function getYouTubeVideoId(input) {
  try {
    const parsed = new URL(input);

    const host = parsed.hostname.toLowerCase();

    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtube-nocookie.com",
      "youtube-nocookie.com"
    ];

    if (!allowedHosts.includes(host)) {
      return null;
    }

    let videoId = null;

    if (host === "youtu.be") {
      videoId = parsed.pathname.split("/")[1];
    } else if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v");
    } else {
      const match = parsed.pathname.match(
        /^\/(shorts|embed|live)\/([a-zA-Z0-9_-]+)/
      );

      if (match) {
        videoId = match[2];
      }
    }

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return null;
    }

    return videoId;

  } catch {
    return null;
  }
}

// ===================================
// CREATE PROJECT
// ===================================

function createProject(data) {
  const project = {
    id: crypto.randomUUID(),

    name: data.name || "Untitled Project",

    source: data.source,

    sourceUrl: data.sourceUrl || null,

    videoId: data.videoId || null,

    status: data.status || "created",

    createdAt: new Date().toISOString(),

    video: null
  };

  projects.set(project.id, project);

  return project;
}

// ===================================
// HOME
// ===================================

app.get("/", (req, res) => {
  res.json({
    name: "DIMASCLIP API",
    status: "online",
    version: "2.0",
    features: [
      "Video uploads",
      "YouTube link validation",
      "Project management",
      "Video metadata"
    ]
  });
});

// ===================================
// HEALTH CHECK
// ===================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "DIMASCLIP",
    version: "2.0",
    storage: "ready",
    timestamp: new Date().toISOString()
  });
});

// ===================================
// YOUTUBE IMPORT
// ===================================

app.post("/api/import", (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      success: false,
      error: "Please provide a YouTube video link."
    });
  }

  const videoId = getYouTubeVideoId(url);

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: "Invalid YouTube link. Please check your URL."
    });
  }

  const project = createProject({
    name: "YouTube Project " + videoId,
    source: "youtube",
    sourceUrl: url,
    videoId,
    status: "awaiting_video_file"
  });

  res.status(201).json({
    success: true,

    status: "awaiting_video_file",

    message:
      "YouTube link validated! Provide an authorized video file to continue processing.",

    project: {
      id: project.id,
      name: project.name,
      source: project.source,
      videoId: project.videoId,
      status: project.status
    }
  });
});

// ===================================
// UPLOAD VIDEO FILE
// ===================================

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "No video file uploaded."
    });
  }

  const projectId = req.body?.projectId;

  let project;

  if (projectId) {
    project = projects.get(projectId);

    if (!project) {
      fs.unlink(req.file.path, () => {});

      return res.status(404).json({
        success: false,
        error: "Project not found."
      });
    }
  } else {
    project = createProject({
      name: path.parse(req.file.originalname).name,
      source: "upload",
      status: "uploaded"
    });
  }

  project.video = {
    id: path.parse(req.file.filename).name,
    name: req.file.originalname,
    size: req.file.size,
    format: path.extname(req.file.originalname).toLowerCase()
  };

  project.status = "uploaded";

  res.status(201).json({
    success: true,

    message: "Video uploaded successfully!",

    project: {
      id: project.id,
      name: project.name,
      source: project.source,
      status: project.status,
      video: project.video
    }
  });
});

// ===================================
// GET ALL PROJECTS
// ===================================

app.get("/api/projects", (req, res) => {
  res.json({
    success: true,
    total: projects.size,
    projects: Array.from(projects.values())
  });
});

// ===================================
// GET ONE PROJECT
// ===================================

app.get("/api/projects/:id", (req, res) => {
  const project = projects.get(req.params.id);

  if (!project) {
    return res.status(404).json({
      success: false,
      error: "Project not found."
    });
  }

  res.json({
    success: true,
    project
  });
});

// ===================================
// DELETE PROJECT
// ===================================

app.delete("/api/projects/:id", (req, res) => {
  const project = projects.get(req.params.id);

  if (!project) {
    return res.status(404).json({
      success: false,
      error: "Project not found."
    });
  }

  if (project.video) {
    const filename = project.video.id;
    const videoPath = path.join(uploadDir, filename);

    if (fs.existsSync(videoPath)) {
      fs.unlink(videoPath, () => {});
    }
  }

  projects.delete(req.params.id);

  res.json({
    success: true,
    message: "Project deleted successfully."
  });
});

// ===================================
// ERROR HANDLING
// ===================================

app.use((err, req, res, next) => {
  console.error("DIMASCLIP ERROR:", err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Video exceeds the 100MB upload limit."
      });
    }
  }

  res.status(400).json({
    success: false,
    error: err.message || "Something went wrong."
  });
});

// ===================================
// START SERVER
// ===================================

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("DIMASCLIP API v2.0");
  console.log("Server running on port " + PORT);
  console.log("Video uploads: READY");
  console.log("YouTube validation: READY");
  console.log("Project management: READY");
  console.log("--------------------------------");
});
