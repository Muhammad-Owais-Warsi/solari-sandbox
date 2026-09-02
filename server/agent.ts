import type { SandboxManager } from "./sandbox";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import { buildTools } from "./tools";

export type AgentEvent =
  | { type: "thinking" }
  | { type: "analysis"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, any> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "file_change"; path: string; content: string }
  | { type: "status"; message: string }
  | { type: "done"; filesChanged: number; answer?: string }
  | { type: "error"; message: string };

function geminiModel(): string {
  return process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
}

export class Agent {
  private manager: SandboxManager;
  private sandboxId: string;
  repoUrl = "";
  private history: BaseMessage[] = [];
  private agent: any;
  private knownPaths: Set<string> = new Set();

  constructor(manager: SandboxManager, sandboxId: string) {
    this.manager = manager;
    this.sandboxId = sandboxId;
  }

  async *run(text: string, repoUrl?: string, mode: "analyze" | "chat" = "chat"): AsyncGenerator<AgentEvent> {
    if (repoUrl) this.repoUrl = repoUrl;
    if (!this.agent) {
      const setup = this.setup(repoUrl || this.repoUrl);
      for await (const ev of setup) {
        if (ev.kind === "error") {
          yield { type: "error", message: ev.message };
          return;
        }
      }
      if (!this.agent) return;
    }

    const turn =
      mode === "analyze"
        ? `This is an issue that the user wants analyzed. Read it carefully and respond ONLY with a concise summary of what the issue is about and what you understand so far.

Do NOT use any tools, do NOT inspect files, and do NOT make, edit, or commit any changes, and do NOT open a pull request. Just explain your understanding.

Issue:
${text}`
        : text;

    this.history.push(new HumanMessage(turn));
    yield { type: "thinking" };

    const written = new Map<string, string>();
    let pendingWritePath: string | null = null;
    let streamed = "";
    let finalAnswer: string | null = null;

    try {
      for await (const event of this.agent.streamEvents(
        { messages: this.history },
        { version: "v2" }
      )) {
        const ev = event as any;
        const name = ev.event || ev.name;

        if (name === "on_chat_model_stream") {
          const chunk = ev.data?.chunk;
          const t =
            (typeof chunk?.content === "string" ? chunk.content : "") ||
            (chunk?.text ?? "");
          if (t) {
            streamed += t;
            yield { type: "analysis", content: t };
          }
        } else if (name === "on_tool_start") {
          const toolName = ev.name || ev.data?.name || "tool";
          let input = ev.data?.input ?? {};
          if (input && typeof input.input === "string") {
            try { input = JSON.parse(input.input); } catch {}
          }
          yield { type: "tool_call", name: toolName, args: input };
          if (toolName === "write_file" && typeof input.path === "string") {
            written.set(input.path, typeof input.content === "string" ? input.content : "");
            pendingWritePath = input.path;
          }
        } else if (name === "on_tool_end") {
          const output = ev.data?.output;
          const toolName = ev.name || output?.name || "tool";
          const resultStr = typeof output?.content === "string" ? output.content : JSON.stringify(output ?? {});
          yield { type: "tool_result", name: toolName, result: resultStr };
          if (pendingWritePath && toolName === "write_file") {
            const content = written.get(pendingWritePath);
            if (content !== undefined) {
              yield { type: "file_change", path: pendingWritePath, content };
            }
            pendingWritePath = null;
          }
        } else if (name === "on_chain_end") {
          try {
            const msgs = ev.data?.output?.messages;
            if (Array.isArray(msgs) && msgs.length > 0) {
              const last = msgs[msgs.length - 1];
              if (last?._getType?.() === "ai") {
                const content = last?.content;
                const lastText =
                  typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content.map((c: any) => c?.text || "").join("")
                      : "";
                if (lastText.trim()) finalAnswer = lastText.trim();
              }
            }
          } catch {}
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Agent failed";
      yield { type: "error", message: msg };
      return;
    }

    const finalText = finalAnswer || streamed.trim();
    if (finalText) {
      yield { type: "done", filesChanged: written.size, answer: finalText };
      // Persist the assistant reply so the next turn has conversational memory.
      this.history.push(new AIMessage(finalText));
    }
  }

  private async *setup(repoUrl: string): AsyncGenerator<
    | { kind: "error"; message: string }
  > {
    const sandbox = this.manager.get(this.sandboxId);
    if (!sandbox) { yield { kind: "error", message: "Sandbox not found" }; return; }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { yield { kind: "error", message: "GEMINI_API_KEY is not set. Add it to server/.env and restart." }; return; }

    const allFiles = await this.gatherRepoContext(sandbox);
    const files = allFiles.filter(f => f.path && f.content) as { path: string; content: string }[];
    if (files.length === 0) {
      yield { kind: "error", message: "No source files found in repository. Make sure a repo is cloned." };
      return;
    }

    this.knownPaths = new Set(files.map(f => f.path));

    const fileList = files
      .map(f => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`)
      .join("\n\n");

    const model = new ChatGoogleGenerativeAI({
      model: geminiModel(),
      apiKey,
      temperature: 0.3,
    });

    const { owner, repo } = Agent.parseRepoUrl(repoUrl) || {};

    const tools = buildTools({
      manager: this.manager,
      sandbox,
      knownPaths: this.knownPaths,
      owner,
      repo,
    });

    this.agent = createReactAgent({ llm: model, tools });

    this.history.push(new SystemMessage(
      `You are a helpful assistant working in the git repository at /work/repo.

You behave like a normal coding assistant: you converse with the user and take actions based on what they explicitly ask for. Never take unsolicited actions.

Repository overview (current contents, may be incomplete):
${fileList.slice(0, 12000)}

Available tools (only use when relevant to the user's request):
- search_directory, read_file: to inspect the code when asked or when needed to answer accurately.
- write_file: only to make code changes the user explicitly asked for.
- git_status, git_commit: only when the user asks to commit (git_commit accepts an optional branch name to create a feature branch).
- create_pr: only when the user explicitly asks to open a pull request; never push or open a PR unprompted.

Guidelines:
- If the user asks a question or for an explanation, just answer — do not edit, commit, or push anything.
- Only write files, commit, or create PRs when the user explicitly requests it.
- Be conversational and concise.`
    ));
  }

  static parseRepoUrl(url: string): { owner: string; repo: string } | null {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!m || !m[1] || !m[2]) return null;
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }

  private async gatherRepoContext(sandbox: any): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = [];
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".py", ".go", ".rs", ".css", ".html", ".yaml", ".yml", ".toml"];
    const skipDirs = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache"];

    const listFiles = async (dir: string): Promise<void> => {
      try {
        const entries = await this.manager.listFiles(sandbox, dir);
        for (const entry of entries) {
          const name = entry.name;
          if (!name) continue;
          const fullPath = dir === "/work/repo" ? `/work/repo/${name}` : `${dir}/${name}`;
          if (entry.dir) {
            if (!skipDirs.some(s => name.includes(s))) {
              await listFiles(fullPath);
            }
          } else {
            const ext = "." + name.split(".").pop();
            if (extensions.includes(ext) || name === "Dockerfile" || name === "Makefile") {
              try {
                const content = await this.manager.readFile(sandbox, fullPath);
                if (content && content.length < 50000) {
                  files.push({ path: fullPath, content });
                }
              } catch {}
            }
          }
        }
      } catch {}
    };

    await listFiles("/work/repo");
    return files;
  }
}
