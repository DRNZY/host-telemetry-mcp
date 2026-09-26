import { execFile } from "child_process";
import { config } from "./config.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

/**
 * Resolves regardless of exit code. `systemctl is-active` exits non-zero for
 * perfectly ordinary states, and the discriminating output is on stdout, so
 * throwing would discard the very value the caller needs.
 */
export const execRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: config.commandTimeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          const code = (err as NodeJS.ErrnoException).code as string;
          if (code === "ENOENT") {
            reject(new Error(`${file} not found`));
            return;
          }
        }
        if (err && !isExitCodeError(err)) {
          reject(err);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode: err ? numericExitCode(err) : 0,
        });
      }
    );
  });

function isExitCodeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "number"
  );
}

function numericExitCode(err: unknown): number {
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : -1;
}
