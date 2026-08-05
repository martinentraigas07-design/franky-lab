// FRANKY LAB — Servidor estático mínimo, sin dependencias, fijado a public/.
// Existe para eliminar cualquier ambigüedad sobre "qué carpeta es la raíz"
// (la causa real de los 404 de sw.js con Live Server / carpetas mal configuradas).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "public");
const port = Number(process.env.PORT) || 4173;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/start.html";
    const filePath = join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end("Forbidden"); return; }
    const st = await stat(filePath).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); res.end("Not found: " + urlPath); return; }
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] || "application/octet-stream";
    // sw.js NUNCA debe cachearse: los navegadores usan su contenido para
    // decidir si hay una versión nueva del Service Worker (ver build/copy-to-public.mjs).
    const cacheControl = urlPath === "/sw.js" ? "no-store" : "no-cache";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cacheControl });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\nFRANKY LAB corriendo en http://127.0.0.1:${port}/`);
  console.log(`Abrí exactamente esta URL:  http://127.0.0.1:${port}/start.html\n`);
});
