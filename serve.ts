// Local dev only — GitHub Pages does the serving in production.
// Needed because file:// blocks ES module imports, so you can't just open index.html.
Bun.serve({
  port: 3000,
  async fetch(req) {
    const p = new URL(req.url).pathname; // WHATWG URL already normalizes ../ away
    const file = Bun.file(`.${p.endsWith("/") ? `${p}index.html` : p}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log("http://localhost:3000");
