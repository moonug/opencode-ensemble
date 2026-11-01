const generated = Bun.spawn([process.execPath, "../opencode-v2-profile/.cache/v2-profile/evidence/ensemble-types.ts"], { stdout: "inherit", stderr: "inherit" })
const generation = await generated.exited
if (generation) process.exit(generation)
const check = Bun.spawn([process.execPath, "node_modules/typescript/bin/tsc", "--project", "tsconfig.check.json", "--noEmit"], { stdout: "inherit", stderr: "inherit" })
process.exit(await check.exited)
