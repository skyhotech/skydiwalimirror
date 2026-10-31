// Starts the Django backend and the Vite studio together for `npm run dev`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const python = join(root, "backend/.venv/bin/python");
const children = [];
const run = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  children.push(child);
  child.on("exit", (code) => {
    if (code) stop(code);
  });
  return child;
};
function stop(code = 0) {
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
// Skip Django if something (e.g. a runserver in another terminal) already has :8000.
const portBusy = await new Promise((resolve) => {
  const s = createConnection({ port: 8000, host: "127.0.0.1" });
  s.on("connect", () => (s.destroy(), resolve(true)));
  s.on("error", () => resolve(false));
});
if (portBusy) console.log("Backend already running on :8000");
else if (existsSync(python))
  run(python, ["manage.py", "runserver", "127.0.0.1:8000"], {
    cwd: join(root, "backend"),
  });
else
  console.warn(
    "backend/.venv missing — studio runs with built-in frames only. See README › Backend.",
  );
run(join(root, "node_modules/.bin/vite"), [
  "--host",
  "0.0.0.0",
  ...process.argv.slice(2),
]);
