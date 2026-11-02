
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
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, id + ext);
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
    status: "online"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "healthy" });
});

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
      size: req.file.size
    }
  });
});

app.use((err, req, res, next) => {
  res.status(400).json({
    error: err.message || "Upload failed."
  });
});

app.listen(PORT, () => {
  console.log(`DIMASCLIP running on port ${PORT}`);
});
