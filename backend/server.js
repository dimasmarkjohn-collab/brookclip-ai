
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = "/tmp/dimasclip-uploads";
fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Please upload a video file."));
    }
  }
});

app.get("/", (req, res) => {
  res.json({
    name: "DIMASCLIP API",
    status: "online",
    version: "1.1"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "healthy" });
});

// Upload an actual video file
app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "No video uploaded."
    });
  }

  res.json({
    success: true,
    message: "Video uploaded successfully!",
    file: {
      id: path.parse(req.file.filename).name,
      name: req.file.originalname,
      size: req.file.size,
      path: req.file.path
    }
  });
});

// Receive a video link
app.post("/api/import", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      error: "Please provide a video link."
    });
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({
      error: "Invalid video URL."
    });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({
      error: "Only HTTP and HTTPS links are supported."
    });
  }

  res.json({
    success: true,
    status: "link_received",
    message: "Video link received successfully. Ready for the next processing stage.",
    url: parsed.toString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  res.status(400).json({
    error: err.message || "Request failed."
  });
});

app.listen(PORT, () => {
  console.log(`DIMASCLIP running on port ${PORT}`);
});
