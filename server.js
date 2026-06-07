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
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
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

function wrapText(text, maxCharsPerLine, maxLines = 2) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return [];

  if (clean.length <= maxCharsPerLine) {
    return [clean];
  }

  const words = clean.split(" ");
  const lines = [];
  let current = "";

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;

    if (next.length <= maxCharsPerLine || !current) {
      current = next;
      continue;
    }

    lines.push(current);

    if (lines.length >= maxLines - 1) {
      const rest = words.slice(i).join(" ");
      if (rest) lines.push(rest);
      current = "";
      break;
    }

    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, maxLines).map(line => line.trim()).filter(Boolean);
}

function chooseTextSizing(textTop, textBottom) {
  const longest = Math.max(
    String(textTop || "").length,
    String(textBottom || "").length
  );

  if (longest <= 28) {
    return {
      topFontSize: 92,
      bottomFontSize: 72,
      topMaxChars: 999,
      bottomMaxChars: 999,
      maxLinesPerText: 1
    };
  }

  if (longest <= 45) {
    return {
      topFontSize: 72,
      bottomFontSize: 60,
      topMaxChars: 28,
      bottomMaxChars: 26,
      maxLinesPerText: 2
    };
  }

  if (longest <= 70) {
    return {
      topFontSize: 60,
      bottomFontSize: 52,
      topMaxChars: 31,
      bottomMaxChars: 29,
      maxLinesPerText: 2
    };
  }

  return {
    topFontSize: 52,
    bottomFontSize: 46,
    topMaxChars: 34,
    bottomMaxChars: 32,
    maxLinesPerText: 2
  };
}

function prepareTextLayout(textTop, textBottom) {
  const sizing = chooseTextSizing(textTop, textBottom);

  const topLines = textTop
    ? wrapText(textTop, sizing.topMaxChars, sizing.maxLinesPerText)
    : [];

  const bottomLines = textBottom
    ? wrapText(textBottom, sizing.bottomMaxChars, sizing.maxLinesPerText)
    : [];

  const lineGap = 8;
  const groupGap = topLines.length && bottomLines.length ? 20 : 0;

  const lines = [];
  let cursor = 0;

  for (const line of topLines) {
    lines.push({
      text: line,
      fontSize: sizing.topFontSize,
      yOffset: cursor
    });

    cursor += Math.round(sizing.topFontSize * 1.18) + lineGap;
  }

  if (topLines.length && bottomLines.length) {
    cursor += groupGap;
  }

  for (const line of bottomLines) {
    lines.push({
      text: line,
      fontSize: sizing.bottomFontSize,
      yOffset: cursor
    });

    cursor += Math.round(sizing.bottomFontSize * 1.18) + lineGap;
  }

  if (lines.length) {
    cursor -= lineGap;
  }

  const totalHeight = Math.max(cursor, 0);
  const lineCount = lines.length;

  let anchor = "h*0.60";

  if (lineCount >= 4) {
    anchor = "h*0.53";
  } else if (lineCount === 3) {
    anchor = "h*0.56";
  } else if (lineCount === 2) {
    anchor = "h*0.59";
  }

  return lines.map(line => ({
    ...line,
    yBase: `${anchor}-${Math.round(totalHeight / 2)}+${Math.round(line.yOffset)}`
  }));
}

function buildVideoFilter({ textLines }) {
  const filters = [];

  const fontFile = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf";

  // Yazı 1.0 - 5.5 saniye arasında görünür
  const textEnable = "enable='between(t,1,5.5)'";

  // 1.0 - 1.8 fade-in, 4.8 - 5.5 fade-out
  const textAlpha =
    "alpha='if(lt(t\\,1.8)\\,(t-1)/0.8\\,if(lt(t\\,4.8)\\,1\\,(5.5-t)/0.7))'";

  for (const line of textLines) {
    const borderW = line.fontSize <= 48 ? 2 : 3;
    const shadow = line.fontSize <= 48 ? 2 : 3;

    const y =
      `y='if(lt(t\\,1.8)\\,${line.yBase}+38-(t-1)/0.8*38\\,` +
      `if(lt(t\\,4.8)\\,${line.yBase}\\,${line.yBase}-(t-4.8)/0.7*22))'`;

    filters.push(
      `drawtext=fontfile='${fontFile}':textfile='${line.file}':fontcolor=white:fontsize=${line.fontSize}:borderw=${borderW}:bordercolor=black@1:shadowcolor=black@0.75:shadowx=${shadow}:shadowy=${shadow}:x=(w-text_w)/2:${y}:${textAlpha}:${textEnable}`
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
  const safeTextTop = cleanText(textTop);
  const safeTextBottom = cleanText(textBottom);
  const safeMusicVolume = normalizeVolume(musicVolume);

  const textFiles = [];

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

    const textLines = prepareTextLayout(safeTextTop, safeTextBottom).map(
      (line, index) => {
        const file = path.join(WORK_DIR, `${id}-text-${index}.txt`);
        fs.writeFileSync(file, line.text, "utf8");
        textFiles.push(file);

        return {
          ...line,
          file
        };
      }
    );

    const videoFilter = buildVideoFilter({
      textLines
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
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath
    ]);
  } finally {
    for (const file of textFiles) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }

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
