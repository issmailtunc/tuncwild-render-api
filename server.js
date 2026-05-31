const express = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

const WORK_DIR = path.join(__dirname, "renders");
fs.mkdirSync(WORK_DIR, { recursive: true });

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 180000 }, (error, stdout, stderr) => {
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

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "TUNC WILD Render API",
    endpoints: ["/render", "/files/:filename"]
  });
});

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

    const baseUrl = `${req.protocol}://${req.get("host")}`;

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
