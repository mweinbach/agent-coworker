import { ChevronDownIcon, FolderInputIcon } from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Spinner } from "../../components/ui/spinner";
import { isDesktopApiAvailable, pickDirectory } from "../../lib/desktopCommands";

/**
 * Picks a local folder via the native dialog and imports the skill(s) it
 * contains by copying (never symlinking) into the chosen scope. Reuses the
 * standard skill install pipeline (`installSkills`), which copies the bundle
 * and writes its install manifest.
 */
export function ImportDirectoryButton() {
  const installSkills = useAppStore((state) => state.installSkills);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isDesktopApiAvailable()) {
    return null;
  }

  const run = async (targetScope: "project" | "global") => {
    setError(null);
    let selectedPath: string | null = null;
    try {
      selectedPath = await pickDirectory({ title: "Select a skill folder to import" });
    } catch {
      setError("Unable to open the folder picker.");
      return;
    }
    if (!selectedPath) {
      return;
    }
    setBusy(true);
    try {
      await installSkills(selectedPath, targetScope);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Unable to import the selected folder. Make sure it contains a SKILL.md.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full px-4"
            type="button"
            disabled={busy}
          >
            {busy ? (
              <Spinner className="mr-1.5 h-4 w-4" />
            ) : (
              <FolderInputIcon className="mr-1.5 h-4 w-4" />
            )}
            Import directory
            <ChevronDownIcon className="ml-1 h-3.5 w-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => void run("global")}>Copy to Global</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void run("project")}>
            Copy to Workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <div className="absolute top-full right-0 z-50 mt-1.5 w-72 rounded-md border border-destructive/40 bg-popover px-3 py-2 text-xs text-destructive shadow-md">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setError(null)}
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
