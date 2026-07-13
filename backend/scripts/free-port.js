// Frees the server port before starting, so `npm run dev` never fails with
// EADDRINUSE from an orphaned watcher. Cross-platform, no dependencies.
import { execSync } from "node:child_process";

const port = Number(process.env.PORT ?? 4000);

function pidsOnPort(p) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // e.g.  TCP    0.0.0.0:4000   0.0.0.0:0   LISTENING   15364
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === p) pids.add(m[2]);
      }
      return [...pids];
    }
    const out = execSync(`lsof -ti tcp:${p} -s tcp:LISTEN`, { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return []; // nothing listening (command exits non-zero) -> no pids
  }
}

const pids = pidsOnPort(port);
for (const pid of pids) {
  try {
    if (process.platform === "win32") execSync(`taskkill /F /PID ${pid}`);
    else execSync(`kill -9 ${pid}`);
    console.log(`Freed port ${port} (killed PID ${pid}).`);
  } catch {
    console.warn(`Could not kill PID ${pid} on port ${port}.`);
  }
}
