import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import axios from "axios";
import type { SandboxManager } from "./sandbox";

const REPO = "/work/repo";

export type ToolContext = {
  manager: SandboxManager;
  sandbox: any;
  knownPaths: Set<string>;
  owner?: string;
  repo?: string;
};

function resolvePath(inputPath?: string): string {
  const p = (inputPath || "").trim() || "";
  if (p === "" || p === "." || p === "/work/repo") return REPO;
  if (p.startsWith(REPO + "/")) return p;
  if (p.startsWith("/")) return p;
  return `${REPO}/${p.replace(/^\/+/, "")}`;
}

export function buildTools(ctx: ToolContext) {
  return [
    new DynamicStructuredTool({
      name: "search_directory",
      description:
        "List all files in a directory within the repository (recursively). " +
        "Use this to explore the repo structure. Provide a directory path relative to /work/repo.",
      schema: z.object({ path: z.string().optional().describe("Directory path relative to /work/repo") }),
      func: async ({ path }) => {
        const files: string[] = [];
        const walk = async (dirPath: string) => {
          let entries;
          try {
            entries = await ctx.manager.listFiles(ctx.sandbox, dirPath);
          } catch {
            return;
          }
          for (const e of entries) {
            const full = `${dirPath}/${e.name}`;
            if (e.dir) await walk(full);
            else files.push(full.replace(`${REPO}/`, ""));
          }
        };
        await walk(resolvePath(path));
        return { cwd: REPO, files };
      },
    }),

    new DynamicStructuredTool({
      name: "read_file",
      description: "Read the contents of a file in the repository. Provide a path relative to /work/repo.",
      schema: z.object({ path: z.string().describe("File path relative to /work/repo") }),
      func: async ({ path }) => {
        const fullPath = resolvePath(path);
        try {
          const content = await ctx.manager.readFile(ctx.sandbox, fullPath);
          return { path: fullPath, content };
        } catch (e) {
          return { path: fullPath, error: e instanceof Error ? e.message : "failed to read" };
        }
      },
    }),

    new DynamicStructuredTool({
      name: "write_file",
      description:
        "Write full content to an EXISTING file in the repository. Provide the entire new file content. " +
        "Only edit files that already exist. Provide a path relative to /work/repo.",
      schema: z.object({
        path: z.string().describe("File path relative to /work/repo"),
        content: z.string().describe("Full new file content"),
      }),
      func: async ({ path, content }) => {
        const fullPath = resolvePath(path);
        if (ctx.knownPaths && !ctx.knownPaths.has(fullPath)) {
          return {
            success: false,
            message: `Refused to write ${fullPath}: file does not exist in the repository. Only edit existing files.`,
          };
        }
        try {
          await ctx.sandbox.files.write(fullPath, content);
          return { success: true, message: `File written at ${fullPath}` };
        } catch (e) {
          return { success: false, message: `Failed to write ${fullPath}: ${e instanceof Error ? e.message : "unknown"}` };
        }
      },
    }),

    new DynamicStructuredTool({
      name: "get_cwd",
      description: "Get the current working directory path of the repository.",
      schema: z.object({}),
      func: async () => ({ cwd: REPO }),
    }),

    new DynamicStructuredTool({
      name: "git_commit",
      description:
        "Stage and commit all current changes in the repository, optionally on a new branch. " +
        "Call this once you have made code changes. Provide a short commit message and, " +
        "if you want a PR, a branch name (e.g. fix/issue-title).",
      schema: z.object({
        message: z.string().describe("Short commit message"),
        branch: z.string().optional().describe("Optional new branch name to create before committing"),
      }),
      func: async ({ message, branch }) => {
        try {
          if (branch) {
            await ctx.manager.checkoutBranch(ctx.sandbox, branch);
          }
          await ctx.manager.execute(ctx.sandbox, "git add -A");
          await ctx.manager.gitCommit(ctx.sandbox, message);
          if (branch) {
            return {
              committed: true,
              branch,
              message,
              next:
                "Changes committed on branch '" + branch +
                "'. Call create_pr when ready to open a pull request.",
            };
          }
          return { committed: true, message };
        } catch (e) {
          return { committed: false, message: e instanceof Error ? e.message : "commit failed" };
        }
      },
    }),

    new DynamicStructuredTool({
      name: "git_status",
      description: "Show the current git status of the repository (changed files and branch).",
      schema: z.object({}),
      func: async () => {
        try {
          const result = await ctx.manager.execute(ctx.sandbox, "git status --short && git branch --show-current");
          return { status: result?.stdout ?? "" };
        } catch (e) {
          return { status: e instanceof Error ? e.message : "git status failed" };
        }
      },
    }),

    new DynamicStructuredTool({
      name: "create_pr",
      description:
        "Create a pull request on GitHub from the current branch. Call this AFTER git_commit with a branch, " +
        "and only when the current branch has been pushed. Provide a title and body describing the change.",
      schema: z.object({
        title: z.string().describe("Pull request title"),
        body: z.string().optional().describe("Pull request description"),
        branch: z.string().optional().describe("Source branch (defaults to the current branch)"),
      }),
      func: async ({ title, body, branch }) => {
        try {
          const token = process.env.GITHUB_TOKEN || process.env.GIT_PASSWORD;
          if (!token) {
            return { created: false, message: "No GITHUB_TOKEN configured" };
          }
          // Determine current branch if not provided
          let headBranch = branch;
          if (!headBranch) {
            const r = await ctx.manager.execute(ctx.sandbox, "git branch --show-current");
            headBranch = (r?.stdout ?? "").trim();
          }
          if (!headBranch) return { created: false, message: "Could not determine current branch" };
          if (headBranch === "main" || headBranch === "master") {
            return { created: false, message: "Refusing to open a PR from the base branch (" + headBranch + "). Use git_commit with a branch first." };
          }

          // Push the branch
          await ctx.manager.gitPush(ctx.sandbox, headBranch);

          if (!ctx.owner || !ctx.repo) {
            return { created: false, message: "Repository owner/name unknown; cannot create PR.", pushed: headBranch };
          }

          const api = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/pulls`;
          const res = await axios.post(
            api,
            { title, body: body || "", head: headBranch, base: "main" },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            }
          );
          return {
            created: true,
            prUrl: res.data?.html_url,
            number: res.data?.number,
            branch: headBranch,
          };
        } catch (e: any) {
          const detail = e?.response?.data?.message || (e instanceof Error ? e.message : "create_pr failed");
          return { created: false, message: typeof detail === "string" ? detail : JSON.stringify(detail) };
        }
      },
    }),
  ];
}
