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

  if (!Number.isFinite(parsed)) return 0.35;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;

  return parsed;
}

async function getVideoDimensions(inputVideo) {
  try {
    const { stdout } = await runCommand("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      inputVideo
    ]);

    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] || {};

    const width = Number(stream.width);
    const height = Number(stream.height);

    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch (e) {
    // ffprobe başarısız olursa varsayılan 9:16 değerine düş
  }

  return { width: 1080, height: 1920 };
}

function isWeakLineEnd(word) {
  const weakWords = [
    "ON", "IN", "AT", "TO", "OF", "FOR", "FROM", "WITH", "BY",
    "AND", "OR", "THE", "A", "AN", "ITS", "MY", "YOUR", "HIS", "HER", "OUR", "THEIR",

    "VE", "İLE", "İÇİN", "GİBİ", "KADAR",
    "ÜSTÜNE", "ÜZERİNE", "İÇİNE", "DIŞINA", "ALTINA", "ARASINA",
    "SUYUN", "DENİZİN", "GÖKYÜZÜNÜN", "DAĞIN", "RUHUNU"
  ];

  return weakWords.includes(String(word || "").toLocaleUpperCase("tr-TR"));
}

function isWeakSingleLastLine(word) {
  const weakSingleWords = [
    "BIRAKIR", "KALIR", "DOKUNUR", "TAŞIR", "İNER", "GELİR", "GİDER",
    "AKAR", "AÇILIR", "SÜZÜLÜR", "PARLAR", "IŞILDAR", "DİNLER", "KONUŞUR"
  ];

  return weakSingleWords.includes(String(word || "").toLocaleUpperCase("tr-TR"));
}

function estimateTextWidthPx(text, fontSize) {
  const value = String(text || "");

  let width = 0;

  for (const char of value) {
    if (char === " ") {
      width += fontSize * 0.32;
    } else if ("İIıijlrtf".includes(char)) {
      width += fontSize * 0.38;
    } else if ("MWŞĞÜÖÇ".includes(char.toLocaleUpperCase("tr-TR"))) {
      width += fontSize * 0.72;
    } else {
      width += fontSize * 0.58;
    }
  }

  return width;
}

function balancedTwoLineSplitByWidth(words, fontSize, maxWidthPx) {
  if (words.length <= 1) return [words.join(" ")];

  let best = null;

  for (let i = 1; i < words.length; i++) {
    const firstWords = words.slice(0, i);
    const secondWords = words.slice(i);

    const line1 = firstWords.join(" ").trim();
    const line2 = secondWords.join(" ").trim();

    const line1Width = estimateTextWidthPx(line1, fontSize);
    const line2Width = estimateTextWidthPx(line2, fontSize);

    const lastWordLine1 = firstWords[firstWords.length - 1];
    const firstWordLine2 = secondWords[0];

    let score = 0;

    score += Math.abs(line1Width - line2Width) * 0.08;

    if (line1Width > maxWidthPx) score += (line1Width - maxWidthPx) * 2;
    if (line2Width > maxWidthPx) score += (line2Width - maxWidthPx) * 2;

    if (isWeakLineEnd(lastWordLine1)) score += 70;
    if (secondWords.length === 1) score += 90;
    if (firstWords.length === 1) score += 45;

    if (estimateTextWidthPx(line2, fontSize) < maxWidthPx * 0.28) score += 35;

    if (secondWords.length === 1 && isWeakSingleLastLine(firstWordLine2)) {
      score += 110;
    }

    if (!best || score < best.score) {
      best = {
        score,
        lines: [line1, line2],
        maxWidth: Math.max(line1Width, line2Width)
      };
    }
  }

  return best ? best.lines : [words.join(" ")];
}

function wrapTextByPixels(text, fontSize, maxWidthPx, maxLines = 2) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return [];

  if (estimateTextWidthPx(clean, fontSize) <= maxWidthPx || maxLines <= 1) {
    return [clean];
  }

  const words = clean.split(" ");

  if (maxLines === 2) {
    return balancedTwoLineSplitByWidth(words, fontSize, maxWidthPx)
      .map(line => line.trim())
      .filter(Boolean);
  }

  const lines = [];
  let current = "";

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;

    if (estimateTextWidthPx(next, fontSize) <= maxWidthPx || !current) {
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

  if (current) lines.push(current);

  return lines.slice(0, maxLines).map(line => line.trim()).filter(Boolean);
}

function chooseBestLayoutForText({ text, role, videoWidth }) {
  if (!text) return [];

  const maxWidthPx = Math.round(videoWidth * 0.90);

  const fontCandidates =
    role === "top"
      ? [92, 88, 84, 80, 76, 72, 68, 64, 60, 56, 52]
      : [76, 72, 68, 64, 60, 56, 52, 48, 44];

  for (const fontSize of fontCandidates) {
    const lines = wrapTextByPixels(text, fontSize, maxWidthPx, 2);
    const allFit = lines.every(line => estimateTextWidthPx(line, fontSize) <= maxWidthPx);

    if (allFit) {
      return lines.map(line => ({
        text: line,
        fontSize
      }));
    }
  }

  const fallbackFont = role === "top" ? 52 : 44;

  return wrapTextByPixels(text, fallbackFont, maxWidthPx, 2).map(line => ({
    text: line,
    fontSize: fallbackFont
  }));
}

function prepareTextLayout(textTop, textBottom, dimensions) {
  const videoWidth = dimensions.width || 1080;

  const topLines = chooseBestLayoutForText({
    text: textTop,
    role: "top",
    videoWidth
  });

  const bottomLines = chooseBestLayoutForText({
    text: textBottom,
    role: "bottom",
    videoWidth
  });

  const lineGap = 10;
  const groupGap = topLines.length && bottomLines.length ? 24 : 0;

  const lines = [];
  let cursor = 0;

  for (const line of topLines) {
    lines.push({
      ...line,
      yOffset: cursor
    });

    cursor += Math.round(line.fontSize * 1.16) + lineGap;
  }

  if (topLines.length && bottomLines.length) {
    cursor += groupGap;
  }

  for (const line of bottomLines) {
    lines.push({
      ...line,
      yOffset: cursor
    });

    cursor += Math.round(line.fontSize * 1.16) + lineGap;
  }

  if (lines.length) cursor -= lineGap;

  const totalHeight = Math.max(cursor, 0);
  const lineCount = lines.length;

  let anchor = "h*0.58";

  if (lineCount >= 4) {
    anchor = "h*0.55";
  } else if (lineCount === 3) {
    anchor = "h*0.57";
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

  const textEnable = "enable='between(t,1,5.5)'";

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

    const dimensions = await getVideoDimensions(inputVideo);

    const textLines = prepareTextLayout(
      safeTextTop,
      safeTextBottom,
      dimensions
    ).map((line, index) => {
      const file = path.join(WORK_DIR, `${id}-text-${index}.txt`);
      fs.writeFileSync(file, line.text, "utf8");
      textFiles.push(file);

      return {
        ...line,
        file
      };
    });

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
