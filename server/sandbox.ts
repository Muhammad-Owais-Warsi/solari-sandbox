import { SandboxClient, type Sandbox } from "@solarisdk/sandbox";

export class SandboxManager {
  private client: SandboxClient;
  private sandboxes: Map<string, Sandbox> = new Map();
  private ptys: Map<string, { pty: any; ws: any }> = new Map();

  constructor() {
    this.client = new SandboxClient({
      apiKey: process.env.SOLARI_API_KEY!,
      baseUrl: "https://api.getsolari.com",
    });
  }

  async create() {
    const sandbox = await this.client.create({
      template: "base",
      cpu: 4,
      memMb: 8192,
      timeoutMs: 15 * 60 * 1000,
      lifecycle: { onTimeout: "kill" },
    });
    await sandbox.connect();
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  get(sandboxId: string): Sandbox | undefined {
    return this.sandboxes.get(sandboxId);
  }

  async cloneRepo(sandbox: Sandbox, repoUrl: string) {
    await sandbox.git.clone(repoUrl, { path: "/work/repo" });
  }

  async execute(sandbox: Sandbox, command: string) {
    return await sandbox.commands.run("sh", {
      args: ["-c", command],
      cwd: "/work/repo",
    });
  }

  async readFile(sandbox: Sandbox, path: string) {
    return await sandbox.files.readText(path);
  }

  async listFiles(sandbox: Sandbox, path: string) {
    const entries = await sandbox.files.list(path);
    return entries.map((e: any) => ({
      name: e.name ?? e.path ?? String(e),
      dir: e.dir ?? false,
      size: e.size ?? 0,
    }));
  }

  async searchCode(sandbox: Sandbox, query: string) {
    const results = await sandbox.files.search("/work/repo", query, 20);
    return results.map((r: any) => ({
      path: r.path ?? r.file ?? "",
      line: r.line ?? 0,
      match: r.line ?? r.match ?? "",
    }));
  }

  async gitStatus(sandbox: Sandbox) {
    return await sandbox.git.status("/work/repo");
  }

  async gitDiff(sandbox: Sandbox) {
    const result = await sandbox.commands.run("git", {
      args: ["diff"],
      cwd: "/work/repo",
    });
    return result.stdout;
  }

  async gitLog(sandbox: Sandbox) {
    return await sandbox.git.log({ cwd: "/work/repo", maxCount: 10 });
  }

  async gitAdd(sandbox: Sandbox, paths: string[]) {
    await sandbox.git.add(paths, "/work/repo");
  }

  async gitCommit(sandbox: Sandbox, message: string) {
    return await sandbox.git.commit(message, {
      cwd: "/work/repo",
      author: "Solari Agent",
      email: "agent@solari.dev",
    });
  }

  async gitPush(sandbox: Sandbox, branch?: string) {
    const token = process.env.GITHUB_TOKEN || process.env.GIT_PASSWORD;
    if (!token) throw new Error("No GITHUB_TOKEN set for push");
    // GitHub accepts a PAT as the password; username can be anything (use the token owner).
    await sandbox.git.push({
      cwd: "/work/repo",
      branch,
      username: process.env.GIT_USERNAME || "solari-agent",
      password: token,
    });
  }

  async checkoutBranch(sandbox: Sandbox, branch: string) {
    const result = await sandbox.commands.run("git", {
      args: ["checkout", "-b", branch],
      cwd: "/work/repo",
    });
    return result?.exitCode === 0;
  }

  async createPty(sandbox: Sandbox, cols: number, rows: number) {
    return await sandbox.pty.create({ cols, rows });
  }

  trackPty(sandboxId: string, pty: any, ws: any) {
    this.ptys.set(sandboxId, { pty, ws });
  }

  getPty(sandboxId: string) {
    return this.ptys.get(sandboxId);
  }

  closePty(sandboxId: string) {
    const session = this.ptys.get(sandboxId);
    if (session) {
      session.pty.kill?.();
      this.ptys.delete(sandboxId);
    }
  }

  async destroy(sandboxId: string) {
    this.closePty(sandboxId);
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      await sandbox.kill();
      this.sandboxes.delete(sandboxId);
    }
  }
}
