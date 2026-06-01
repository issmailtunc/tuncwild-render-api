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
    execFile(command, args, { timeout: 900000 }, (error, stdout, stderr) => {
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

function cleanText(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/[’‘]/g, "'")
    .trim()
    .slice(0, 120);
}

function normalizeVolume(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0.35;
  }

  if (parsed < 0) return 0;
  if (parsed > 1) return 1;

  return parsed;
}

function buildVideoFilter({ textTop, textBottom, textTopFile, textBottomFile }) {
  const filters = [];

  const fontFile = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf";

  // Yazı sadece bu zaman aralığında görünür
  const textEnable = "enable='between(t,1,5.5)'";

  if (textTop) {
    filters.push(
      `drawtext=fontfile='${fontFile}':textfile='${textTopFile}':fontcolor=white:fontsize=78:borderw=4:bordercolor=black@0.95:shadowcolor=black@0.65:shadowx=2:shadowy=2:x=(w-text_w)/2:y=h*0.62:${textEnable}`
    );
  }

  if (textBottom) {
    filters.push(
      `drawtext=fontfile='${fontFile}':textfile='${textBottomFile}':fontcolor=white:fontsize=62:borderw=4:bordercolor=black@0.95:shadowcolor=black@0.65:shadowx=2:shadowy=2:x=(w-text_w)/2:y=h*0.62+90:${textEnable}`
    );
  }

  return filters.length > 0 ? filters.join(",") : "null";
}

async function processRender({
  inputVideo,
  inputMusic,
  musicUrl,
  musicVolume,
  textTop,
  textBottom,
  outputPath,
  id
}) {
  const musicPath = path.join(WORK_DIR, `${id}-music.mp3`);
  const textTopFile = path.join(WORK_DIR, `${id}-text-top.txt`);
  const textBottomFile = path.join(WORK_DIR, `${id}-text-bottom.txt`);

  const safeTextTop = cleanText(textTop);
  const safeTextBottom = cleanText(textBottom);
  const safeMusicVolume = normalizeVolume(musicVolume);

  if (safeTextTop) {
    fs.writeFileSync(textTopFile, safeTextTop, "utf8");
  }

  if (safeTextBottom) {
    fs.writeFileSync(textBottomFile, safeTextBottom, "utf8");
  }

  try {
    if (inputMusic) {
      await runCommand("ffmpeg", [
        "-y",
        "-i", inputMusic,
        "-c", "copy",
        musicPath
      ]);
    } else if (isSafeUrl(musicUrl)) {
      await runCommand("ffmpeg", [
        "-y",
        "-i", musicUrl,
        "-c", "copy",
        musicPath
      ]);
    } else {
      throw new Error("music file or musicUrl is required");
    }

    const videoFilter = buildVideoFilter({
      textTop: safeTextTop,
      textBottom: safeTextBottom,
      textTopFile,
      textBottomFile
    });

    await runCommand("ffmpeg", [
      "-y",
      "-i", inputVideo,
      "-i", musicPath,
      "-filter_complex",
      `[0:v]${videoFilter}[v];[1:a]volume=${safeMusicVolume},afade=t=in:st=0:d=0.6[a]`,
      "-map", "[v]",
      "-map", "[a]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath
    ]);
  } finally {
    if (fs.existsSync(textTopFile)) fs.unlinkSync(textTopFile);
    if (fs.existsSync(textBottomFile)) fs.unlinkSync(textBottomFile);
    if (fs.existsSync(musicPath)) fs.unlinkSync(musicPath);
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "TUNC WILD Render API",
    endpoints: ["/render", "/render-upload", "/files/:filename"]
  });
});

app.post("/render", async (req, res) => {
  const {
    videoUrl,
    musicUrl,
    musicVolume = 0.35,
    textTop = "",
    textBottom = ""
  } = req.body;

  if (!isSafeUrl(videoUrl)) {
    return res.status(400).json({
      success: false,
      error: "videoUrl is required and must be http/https"
    });
  }

  if (!isSafeUrl(musicUrl)) {
    return res.status(400).json({
      success: false,
      error: "musicUrl is required and must be http/https"
    });
  }

  const id = uuidv4();
  const outputPath = path.join(WORK_DIR, `${id}-final.mp4`);
  const outputName = path.basename(outputPath);

  try {
    await processRender({
      inputVideo: videoUrl,
      musicUrl,
      musicVolume,
      textTop,
      textBottom,
      outputPath,
      id
    });

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

app.post(
  "/render-upload",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    const {
      musicUrl = "",
      musicVolume = 0.35,
      textTop = "",
      textBottom = ""
    } = req.body;

    const videoFile = req.files?.video?.[0];
    const musicFile = req.files?.music?.[0];

    if (!videoFile) {
      return res.status(400).json({
        success: false,
        error: "video file is required. Field name must be 'video'."
      });
    }

    if (!musicFile && !isSafeUrl(musicUrl)) {
      return res.status(400).json({
        success: false,
        error: "music file is required. Field name must be 'music'."
      });
    }

    const id = uuidv4();

    const uploadedVideoPath = videoFile.path;
    const uploadedMusicPath = musicFile ? musicFile.path : null;
    const outputPath = path.join(WORK_DIR, `${id}-final.mp4`);
    const outputName = path.basename(outputPath);

    try {
      await processRender({
        inputVideo: uploadedVideoPath,
        inputMusic: uploadedMusicPath,
        musicUrl,
        musicVolume,
        textTop,
        textBottom,
        outputPath,
        id
      });

      if (fs.existsSync(uploadedVideoPath)) {
        fs.unlinkSync(uploadedVideoPath);
      }

      if (uploadedMusicPath && fs.existsSync(uploadedMusicPath)) {
        fs.unlinkSync(uploadedMusicPath);
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

      if (uploadedMusicPath && fs.existsSync(uploadedMusicPath)) {
        fs.unlinkSync(uploadedMusicPath);
      }

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.get("/files/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WORK_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      error: "File not found"
    });
  }

  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`TUNC WILD Render API running on port ${PORT}`);
});
