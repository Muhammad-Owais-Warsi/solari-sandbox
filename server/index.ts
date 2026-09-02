import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { SandboxManager } from "./sandbox";
import { Agent, type AgentEvent } from "./agent";

const manager = new SandboxManager();
const agents = new Map<string, Agent>();

const app = express();
app.use(cors());
app.use(express.json());

// ─── SSE Helper ──────────────────────────────────────────────
async function sseStream(res: express.Response, generator: AsyncGenerator<any>) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  let alive = true;
  res.on("close", () => { alive = false; generator.return(undefined); });

  const write = (data: string) => {
    if (!alive) return;
    try { res.write(data); } catch {}
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  const heartbeat = setInterval(() => {
    write(": keepalive\n\n");
  }, 15000);

  try {
    for await (const event of generator) {
      if (!alive) break;
      write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (e) {
    write(`data: ${JSON.stringify({ type: "error", message: e instanceof Error ? e.message : "Stream failed" })}\n\n`);
  }

  clearInterval(heartbeat);
  if (alive) {
    write("data: [DONE]\n\n");
    res.end();
  }
}

// ─── Helpers ─────────────────────────────────────────────────
function githubIssueToApiUrl(url: string) {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/
  );
  if (!match) throw new Error("Invalid GitHub issue URL");
  const [, owner, repo] = match;
  return {
    api: `https://api.github.com/repos/${owner}/${repo}/issues/${match[3]}`,
    repo: `https://github.com/${owner}/${repo}`,
  };
}

// ─── Routes ──────────────────────────────────────────────────

// POST /issue
app.post("/issue", async (req, res) => {
  try {
    const { url } = req.body as { url: string };
    const { api, repo } = githubIssueToApiUrl(url);
    const ghRes = await fetch(api, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!ghRes.ok) return res.status(ghRes.status).json({ error: "Failed to fetch issue" });
    const issue = (await ghRes.json()) as Record<string, any>;
    res.json({
      title: issue.title,
      repoUrl: repo,
      body: issue.body,
      state: issue.state,
      author: issue.user?.login,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Bad request" });
  }
});

// POST /sandbox
app.post("/sandbox", async (req, res) => {
  try {
    const { repoUrl } = req.body as { repoUrl?: string };
    const sandbox = await manager.create();
    if (repoUrl) {
      await manager.cloneRepo(sandbox, repoUrl);
    }
    res.json({ sandboxId: sandbox.id });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// DELETE /sandbox/:id
app.delete("/sandbox/:id", async (req, res) => {
  const { id } = req.params;
  try {
    agents.delete(id);
    await manager.destroy(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// GET /sandbox/:id/exec?cmd=...
app.get("/sandbox/:id/exec", async (req, res) => {
  const { id } = req.params;
  const cmd = req.query.cmd as string;
  if (!cmd) return res.status(400).json({ error: "cmd required" });
  const sandbox = manager.get(id);
  if (!sandbox) return res.status(404).json({ error: "Sandbox not found" });
  try {
    const result = await manager.execute(sandbox, cmd);
    res.json({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// GET /sandbox/:id/files
app.get("/sandbox/:id/files", async (req, res) => {
  const { id } = req.params;
  const sandbox = manager.get(id);
  if (!sandbox) return res.status(404).json({ error: "Sandbox not found" });
  try {
    const entries = await sandbox.files.list("/work/repo");
    res.json({ files: entries.map((e: any) => e.name ?? e.path ?? String(e)) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// ─── Agent Routes ────────────────────────────────────────────

// GET /agent/test — verify Ollama is running
app.get("/agent/test", async (_req, res) => {
  try {
    const { default: OpenAI } = await import("openai");
    const llm = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
    const result = await llm.chat.completions.create({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "Say hello in one word" }],
      max_tokens: 10,
    });
    res.json({ ok: true, reply: result.choices[0]?.message?.content });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Is Ollama running?" });
  }
});

// POST /ollama/start
app.post("/ollama/start", async (_req, res) => {
  try {
    const { spawn } = await import("child_process");
    const ollamaPath = `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`;
    const child = spawn(ollamaPath, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    res.json({ ok: true, message: "Ollama started" });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to start" });
  }
});

// POST /ollama/stop
app.post("/ollama/stop", async (_req, res) => {
  try {
    const { execSync } = await import("child_process");
    execSync('taskkill /F /IM "ollama.exe" 2>nul', { stdio: "ignore" });
    res.json({ ok: true, message: "Ollama stopped" });
  } catch {
    res.json({ ok: true, message: "Ollama stopped (or was not running)" });
  }
});

// POST /agent/chat-direct — no sandbox, just LLM chat (JSON)
app.post("/agent/chat-direct", async (req, res) => {
  const { message } = req.body as { message: string };
  try {
    const { default: OpenAI } = await import("openai");
    const llm = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
    const result = await llm.chat.completions.create({
      model: "qwen2.5-coder:7b",
      messages: [
        { role: "system", content: "You are a helpful coding assistant. Be concise." },
        { role: "user", content: message },
      ],
      stream: false,
      temperature: 0.3,
    });
    res.json({ reply: result.choices[0]?.message?.content || "" });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed" });
  }
});

// POST /agent/start — run single-shot agent
app.post("/agent/start", async (req, res) => {
  const { sandboxId, issue } = req.body as {
    sandboxId: string;
    issue: { title: string; body: string | null; author: string; repoUrl: string };
  };

  const agent = new Agent(manager, sandboxId);
  agents.set(sandboxId, agent);

  const prompt = [issue.title, issue.body].filter(Boolean).join("\n\n") || issue.title;
  if (req.query.stream === "true") {
    return sseStream(res, agent.run(prompt, issue.repoUrl, "analyze"));
  }
  const events: any[] = [];
  for await (const event of agent.run(prompt, issue.repoUrl, "analyze")) events.push(event);
  res.json({ events });
});

// POST /agent/chat — follow-up message (conversational, reuses the same agent)
app.post("/agent/chat", async (req, res) => {
  const { sandboxId, message } = req.body as { sandboxId: string; message: string };
  const existing = agents.get(sandboxId);
  if (!existing) return res.status(400).json({ error: "No active analysis. Start fresh." });

  if (req.query.stream === "true") {
    return sseStream(res, existing.run(message));
  }
  const events: any[] = [];
  for await (const event of existing.run(message)) events.push(event);
  res.json({ events });
});

// GET /test — simple test page
app.get("/test", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html><head><title>Agent Test</title>
<style>
  body { font-family: monospace; background: #1a1b26; color: #a9b1d6; padding: 24px; max-width: 700px; margin: 0 auto; }
  h1 { color: #7aa2f7; }
  textarea { width: 100%; height: 80px; background: #1f2028; color: #a9b1d6; border: 1px solid #2e303a; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 14px; resize: vertical; }
  button { background: #7aa2f7; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; margin-top: 8px; }
  button:hover { opacity: 0.85; }
  .btn-stop { background: #f7768e; }
  .btn-start { background: #9ece6a; color: #1a1b26; }
  #output { background: #1f2028; border: 1px solid #2e303a; border-radius: 6px; padding: 16px; margin-top: 16px; min-height: 100px; white-space: pre-wrap; line-height: 1.6; }
  .label { font-size: 12px; color: #9ece6a; margin-bottom: 4px; }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; }
  #status { font-size: 12px; margin-left: 12px; line-height: 36px; }
</style></head><body>
<h1>Agent Test (No Sandbox)</h1>
<div class="controls">
  <button class="btn-start" onclick="startOllama()">Start Ollama</button>
  <button class="btn-stop" onclick="stopOllama()">Stop Ollama</button>
  <span id="status"></span>
</div>
<div class="label">Message:</div>
<textarea id="msg" placeholder="Ask me anything about coding...">Explain what a closure is in JavaScript</textarea>
<br>
<button onclick="send()">Send</button>
<div class="label">Response:</div>
<div id="output">Click Send to start...</div>
<script>
async function startOllama() {
  document.getElementById('status').textContent = 'Starting...';
  const res = await fetch('/ollama/start', { method: 'POST' });
  const data = await res.json();
  document.getElementById('status').textContent = data.message;
}
async function stopOllama() {
  document.getElementById('status').textContent = 'Stopping...';
  const res = await fetch('/ollama/stop', { method: 'POST' });
  const data = await res.json();
  document.getElementById('status').textContent = data.message;
}
async function send() {
  const msg = document.getElementById('msg').value;
  const output = document.getElementById('output');
  output.textContent = 'Thinking...';
  try {
    const res = await fetch('/agent/chat-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await res.json();
    output.textContent = data.reply || data.error || 'No response';
  } catch (e) { output.textContent = 'Error: ' + e.message; }
}
</script></body></html>`);
});

// ─── HTTP Server + WebSocket ─────────────────────────────────
const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (ws: WebSocket, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const sandboxId = url.searchParams.get("sandboxId");

  if (!sandboxId) {
    ws.send(JSON.stringify({ type: "error", message: "sandboxId required" }));
    ws.close();
    return;
  }

  const sandbox = manager.get(sandboxId);
  if (!sandbox) {
    ws.send(JSON.stringify({ type: "error", message: "Sandbox not found" }));
    ws.close();
    return;
  }

  try {
    const pty = await manager.createPty(sandbox, 80, 24);
    pty.onData((data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      ws.send(JSON.stringify({ type: "output", data: text }));
    });
    manager.trackPty(sandboxId, pty, ws);
    ws.send(JSON.stringify({ type: "connected", sandboxId }));
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY" }));
    ws.close();
  }

  ws.on("message", async (message) => {
    const session = manager.getPty(sandboxId);
    if (!session) return;
    try {
      const msg = JSON.parse(message.toString()) as { type: string; data?: string; cols?: number; rows?: number };
      if (msg.type === "input" && msg.data) {
        await session.pty.write(msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        await session.pty.resize(msg.cols, msg.rows);
      }
    } catch {}
  });

  ws.on("close", () => {
    manager.closePty(sandboxId);
  });
});

// ─── Start ───────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
