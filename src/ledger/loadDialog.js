/* Wraps a dialog's import() so every on-demand download is measured the same
   way, and so a rejection names the dialog rather than a bare chunk URL.

   Separate from LazyDialog.jsx only because that file exports a component and
   this is a plain function: mixing the two in one module breaks fast refresh. */

import { startLedgerTiming } from "../lib/ledgerStartup";

export function loadDialog(name, importer) {
  return async () => {
    const finish = startLedgerTiming(`feature.${name}_chunk`);
    try {
      const module = await importer();
      finish({ outcome: "ok" });
      return module;
    } catch (error) {
      finish({ outcome: "error" });
      throw error;
    }
  };
}
