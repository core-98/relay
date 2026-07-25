import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Relay application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Relay — Encrypted video sharing, direct from your device<\/title>/i,
  );
  assert.match(html, /Share a video without uploading it\./);
  assert.match(html, /Server = signalling only/);
  assert.match(html, /Join with a code/);
  assert.match(
    html,
    /accept="\.mp4,\.m4v,\.mov,\.mkv,\.webm,\.ogg,\.ogv,\.ts,\.mts,\.m2ts,video\/\*"/,
  );
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("renders the landing screen without reading the address bar", async () => {
  // The join screen is chosen from the URL on the client, so the server pass
  // must never emit it — that is what keeps hydration stable.
  const html = await (await render()).text();
  assert.doesNotMatch(html, /Enter the code you were given/);
});

test("ships an installable, storage-free PWA manifest", async () => {
  const [manifestSource, hostingSource] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const hosting = JSON.parse(hostingSource);

  assert.equal(manifest.name, "Relay — Encrypted video sharing");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 2);
  assert.equal(hosting.d1, null);
  assert.equal(hosting.r2, null);
});
