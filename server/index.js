import { execFile } from "node:child_process";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const FIRMWARE_DIR = path.resolve(ROOT_DIR, "firmware");
const DIST_DIR = path.resolve(ROOT_DIR, "dist");
const MOVE_FIRMWARE_SCRIPT = path.join(ROOT_DIR, "move_firmware.py");
const FIRMWARE_SOURCE_DIR = process.env.FIRMWARE_SOURCE_DIR
  ? path.resolve(process.env.FIRMWARE_SOURCE_DIR)
  : path.join(os.homedir(), "MyGit");

const app = express();

app.get("/api/firmware", (req, res) => {
  fs.readdir(FIRMWARE_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) {
      if (err.code === "ENOENT") return res.json([]);
      return res.status(500).json({ error: "Failed to list firmware directory" });
    }

    const firmwares = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".bin"))
      .map((entry) => {
        const stat = fs.statSync(path.join(FIRMWARE_DIR, entry.name));
        return { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    res.json(firmwares);
  });
});

app.post("/api/firmware/sync", (req, res) => {
  execFile(
    "python3",
    [MOVE_FIRMWARE_SCRIPT, FIRMWARE_SOURCE_DIR, FIRMWARE_DIR],
    { timeout: 60_000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({ error: err.message, stdout, stderr });
      }
      res.json({ stdout, stderr });
    },
  );
});

app.delete("/api/firmware", (req, res) => {
  fs.readdir(FIRMWARE_DIR, { withFileTypes: true }, async (err, entries) => {
    if (err) {
      if (err.code === "ENOENT") return res.json({ deletedCount: 0 });
      return res.status(500).json({ error: "Failed to list firmware directory" });
    }

    const firmwareNames = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".bin"))
      .map((entry) => entry.name);

    try {
      await Promise.all(
        firmwareNames.map((name) => fs.promises.unlink(path.join(FIRMWARE_DIR, name))),
      );
      res.json({ deletedCount: firmwareNames.length });
    } catch {
      res.status(500).json({ error: "Failed to delete all firmware" });
    }
  });
});

app.get("/firmware/:name", (req, res) => {
  const requestedName = path.basename(req.params.name);

  if (!requestedName.toLowerCase().endsWith(".bin")) {
    return res.status(400).json({ error: "Only .bin files can be served" });
  }

  const filePath = path.join(FIRMWARE_DIR, requestedName);

  if (path.dirname(filePath) !== FIRMWARE_DIR) {
    return res.status(400).json({ error: "Invalid firmware name" });
  }

  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(err.status === 404 ? 404 : 500).json({ error: "Firmware not found" });
    }
  });
});

app.use(express.static(DIST_DIR));

const httpsKeyPath = process.env.TLS_KEY_PATH;
const httpsCertPath = process.env.TLS_CERT_PATH;

if (httpsKeyPath && httpsCertPath) {
  const port = Number(process.env.PORT) || 8443;
  const server = https.createServer(
    {
      key: fs.readFileSync(httpsKeyPath),
      cert: fs.readFileSync(httpsCertPath),
    },
    app,
  );
  server.listen(port, () => {
    console.log(`HTTPS server listening on https://0.0.0.0:${port}`);
  });
} else {
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app).listen(port, () => {
    console.log(`HTTP server listening on http://0.0.0.0:${port}`);
    console.log(
      "Note: Web Serial requires a secure context. Set TLS_KEY_PATH/TLS_CERT_PATH " +
        "(e.g. from `tailscale cert`) to serve over HTTPS for remote/Tailscale access.",
    );
  });
}
