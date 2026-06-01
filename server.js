const express = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

const WORK_DIR = path.join(__dirname, "renders");
fs.mkdirSync(WORK_DIR, { recursive: true });

const upload = multer({
  dest: WORK_DIR,
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1 GB
  }
});

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 600000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isSafeUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "TUNC WILD Render API",
    endpoints: ["/render", "/render-upload", "/files/:filename"]
  });
});

/**
 * Eski sistem:
 * videoUrl + musicUrl ile çalışır.
 * Bunu şimdilik bozmadık.
 */
app.post("/render", async (req, res) => {
  const { videoUrl, musicUrl, musicVolume = 0.35 } = req.body;

  if (!isSafeUrl(videoUrl)) {
    return res.status(400).json({ error: "videoUrl is required and must be http/https" });
  }

  if (!isSafeUrl(musicUrl)) {
    return res.status(400).json({ error: "musicUrl is required and must be http/https" });
  }

  const id = uuidv4();
  const videoPath = path.join(WORK_DIR, `${id}-video.mp4`);
  const musicPath = path.join(WORK_DIR, `${id}-music.mp3`);
  const outputPath = path.join(WORK_DIR, `${id}-final.mp4`);
  const outputName = path.basename(outputPath);

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-i", videoUrl,
      "-t", "8",
      "-c", "copy",
      videoPath
    ]);

    await runCommand("ffmpeg", [
      "-y",
      "-i", musicUrl,
      "-t", "8",
      "-c", "copy",
      musicPath
    ]);

    await runCommand("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", musicPath,
      "-filter_complex",
      `[1:a]volume=${musicVolume},afade=t=in:st=0:d=0.6,afade=t=out:st=7.2:d=0.8[a]`,
      "-map", "0:v:0",
      "-map", "[a]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      outputPath
    ]);

    const baseUrl = getBaseUrl(req);

    res.json({
      success: true,
      id,
      url: `${baseUrl}/files/${outputName}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Yeni sistem:
 * n8n'den video dosyasını upload olarak alır.
 *
 * Beklenen multipart/form-data:
 * - video: MP4 dosyası
 * - musicUrl: müzik linki
 * - musicVolume: 0.35
 */
app.post("/render-upload", upload.single("video"), async (req, res) => {
  const { musicUrl, musicVolume = 0.35 } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: "video file is required. Field name must be 'video'." });
  }

  if (!isSafeUrl(musicUrl)) {
    return res.status(400).json({ error: "musicUrl is required and must be http/https" });
  }

  const id = uuidv4();

  const uploadedVideoPath = req.file.path;
  const videoPath = path.join(WORK_DIR, `${id}-video.mp4`);
  const musicPath = path.join(WORK_DIR, `${id}-music.mp3`);
  const outputPath = path.join(WORK_DIR, `${id}-final.mp4`);
  const outputName = path.basename(outputPath);

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-i", uploadedVideoPath,
      "-t", "8",
      "-c", "copy",
      videoPath
    ]);

    await runCommand("ffmpeg", [
      "-y",
      "-i", musicUrl,
      "-t", "8",
      "-c", "copy",
      musicPath
    ]);

    await runCommand("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", musicPath,
      "-filter_complex",
      `[1:a]volume=${musicVolume},afade=t=in:st=0:d=0.6,afade=t=out:st=7.2:d=0.8[a]`,
      "-map", "0:v:0",
      "-map", "[a]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      outputPath
    ]);

    if (fs.existsSync(uploadedVideoPath)) {
      fs.unlinkSync(uploadedVideoPath);
    }

    const baseUrl = getBaseUrl(req);

    res.json({
      success: true,
      id,
      url: `${baseUrl}/files/${outputName}`
    });
  } catch (error) {
    if (fs.existsSync(uploadedVideoPath)) {
      fs.unlinkSync(uploadedVideoPath);
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/files/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WORK_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`TUNC WILD Render API running on port ${PORT}`);
});
