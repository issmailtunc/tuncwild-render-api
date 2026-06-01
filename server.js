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
    .trim()
    .slice(0, 120);
}

function buildTextBlock(textTop, textBottom) {
  const safeTextTop = cleanText(textTop);
  const safeTextBottom = cleanText(textBottom);

  if (safeTextTop && safeTextBottom) {
    return `${safeTextTop}\n${safeTextBottom}`;
  }

  if (safeTextTop) return safeTextTop;
  if (safeTextBottom) return safeTextBottom;

  return "";
}

function buildVideoFilter({ textBlock, textBlockFile }) {
  if (!textBlock) {
    return "null";
  }

  // Alpine Linux + ttf-dejavu font path
  const fontFile = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf";

  return [
    "drawbox=x=iw*0.07:y=ih*0.56:w=iw*0.86:h=ih*0.17:color=black@0.52:t=fill",
    `drawtext=fontfile='${fontFile}':textfile='${textBlockFile}':fontcolor=white:fontsize='min(h*0.056,60)':line_spacing=14:x=(w-text_w)/2:y=h*0.595`
  ].join(",");
}

async function processRender({
  inputVideo,
  musicUrl,
  musicVolume,
  textTop,
  textBottom,
  outputPath,
  id
}) {
  const musicPath = path.join(WORK_DIR, `${id}-music.mp3`);
  const textBlockFile = path.join(WORK_DIR, `${id}-text-block.txt`);

  const textBlock = buildTextBlock(textTop, textBottom);

  if (textBlock) {
    fs.writeFileSync(textBlockFile, textBlock, "utf8");
  }

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-i", musicUrl,
      "-c", "copy",
      musicPath
    ]);

    const videoFilter = buildVideoFilter({
      textBlock,
      textBlockFile
    });

    await runCommand("ffmpeg", [
      "-y",
      "-i", inputVideo,
      "-i", musicPath,
      "-filter_complex",
      `[0:v]${videoFilter}[v];[1:a]volume=${musicVolume},afade=t=in:st=0:d=0.6[a]`,
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
    if (fs.existsSync(textBlockFile)) fs.unlinkSync(textBlockFile);
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

/**
 * Eski sistem:
 * videoUrl + musicUrl ile çalışır.
 * Bu endpoint textTop / textBottom destekler.
 */
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

/**
 * Yeni sistem:
 * n8n'den video dosyasını upload olarak alır.
 *
 * Beklenen multipart/form-data:
 * - video: MP4 dosyası
 * - musicUrl: müzik linki
 * - musicVolume: 0.35
 * - textTop: İngilizce yazı
 * - textBottom: Türkçe yazı
 */
app.post("/render-upload", upload.single("video"), async (req, res) => {
  const {
    musicUrl,
    musicVolume = 0.35,
    textTop = "",
    textBottom = ""
  } = req.body;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "video file is required. Field name must be 'video'."
    });
  }

  if (!isSafeUrl(musicUrl)) {
    return res.status(400).json({
      success: false,
      error: "musicUrl is required and must be http/https"
    });
  }

  const id = uuidv4();

  const uploadedVideoPath = req.file.path;
  const outputPath = path.join(WORK_DIR, `${id}-final.mp4`);
  const outputName = path.basename(outputPath);

  try {
    await processRender({
      inputVideo: uploadedVideoPath,
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
