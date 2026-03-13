import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const distCliPath = join(repositoryRoot, "dist", "cli.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const buildResult = spawnSync(npmCommand, ["run", "build", "--silent"], {
  cwd: repositoryRoot,
  stdio: "inherit"
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const cliResult = spawnSync(process.execPath, [distCliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

if (cliResult.signal) {
  process.kill(process.pid, cliResult.signal);
}

process.exit(cliResult.status ?? 1);
