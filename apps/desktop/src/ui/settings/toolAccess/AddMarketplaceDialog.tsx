import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../../app/store";
import { MARKETPLACE_ADD_PENDING_KEY } from "../../../app/store.actions/marketplaces";
import { operationKey } from "../../../app/store.helpers";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { isImeComposing } from "../../../lib/keyboard";
import { OperationFeedback } from "../../OperationFeedback";

export function AddMarketplaceDialog({
  workspaceId,
  initialOpen = false,
  initialSourceInput = "",
  initialMutationSourceInput = null,
}: {
  workspaceId: string;
  initialOpen?: boolean;
  initialSourceInput?: string;
  initialMutationSourceInput?: string | null;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [sourceInput, setSourceInput] = useState(initialSourceInput);
  const [lastMutationSourceInput, setLastMutationSourceInput] = useState<string | null>(
    initialMutationSourceInput,
  );

  const runtime = useAppStore((state) => state.workspaceRuntimeById[workspaceId]);
  const addMarketplace = useAppStore((state) => state.addMarketplace);
  const addOperation = useAppStore(
    (state) => state.operationsByKey[operationKey("marketplace", "add")],
  );

  const addPending =
    runtime?.marketplaceMutationPendingKeys[MARKETPLACE_ADD_PENDING_KEY] === true ||
    addOperation?.status === "pending";
  const normalizedSourceInput = sourceInput.trim();
  const showMutationError =
    Boolean(runtime?.marketplaceMutationError) &&
    lastMutationSourceInput !== null &&
    normalizedSourceInput.length > 0 &&
    normalizedSourceInput === lastMutationSourceInput;
  const dialogError = showMutationError ? (runtime?.marketplaceMutationError ?? null) : null;

  const resetDialogState = () => {
    setSourceInput("");
    setLastMutationSourceInput(null);
  };

  const openDialog = () => {
    resetDialogState();
    setOpen(true);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && addPending) {
      return;
    }
    if (!nextOpen && !open) {
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      resetDialogState();
    }
  };

  const handleAdd = async () => {
    if (!normalizedSourceInput || addPending) return;
    setLastMutationSourceInput(normalizedSourceInput);
    const result = await addMarketplace(normalizedSourceInput);
    if (result.ok) {
      handleOpenChange(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onPointerDown={openDialog}
        onClick={openDialog}
      >
        <PlusIcon data-icon="inline-start" />
        Add marketplace
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Add marketplace</DialogTitle>
            <DialogDescription>
              Add a GitHub repository as a source of installable plugins and skills.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="marketplace-source-input">GitHub repository</Label>
              <Input
                id="marketplace-source-input"
                placeholder="owner/repo or https://github.com/owner/repo"
                value={sourceInput}
                aria-label="GitHub repository"
                disabled={addPending}
                onChange={(event) => {
                  setSourceInput(event.target.value);
                  setLastMutationSourceInput(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !isImeComposing(event.nativeEvent)) {
                    event.preventDefault();
                    void handleAdd();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                The repository must contain a marketplace manifest. Use the create-marketplace skill
                to make one.
              </p>
            </div>
            {dialogError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {dialogError}
              </div>
            ) : null}
            <OperationFeedback operation={addOperation} />
            <div className="flex justify-end">
              <Button
                size="sm"
                type="button"
                disabled={!normalizedSourceInput || addPending}
                onClick={() => void handleAdd()}
              >
                {addPending ? "Adding marketplace…" : "Add marketplace"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
