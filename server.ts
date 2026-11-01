import { Plugin } from "@opencode/plugin"
import { setupEnsemble } from "./src/native-setup"

/** Directory-native entry; it never imports the legacy dual-host bootstrap. */
export default Plugin.define({
  id: "ensemble",
  async setup(ctx) {
    const dbPath = ctx.options.dbPath
    const dashboardPort = ctx.options.dashboardPort ?? 0
    if (typeof dbPath !== "string" || !dbPath || dbPath === ":memory:") throw new Error("Native Ensemble requires an explicit private dbPath")
    if (typeof dashboardPort !== "number" || !Number.isInteger(dashboardPort) || dashboardPort < 0 || dashboardPort > 65535) throw new Error("Invalid Ensemble dashboardPort")
    const handle = await setupEnsemble(ctx, { dbPath, dashboardPort })
    return () => handle.dispose()
  },
})
