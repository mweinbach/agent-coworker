import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

export function CancelSubagentsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeChildAgentCount: number;
  onCancelWithScope: (includeSubagents: boolean) => void;
}) {
  const { open, onOpenChange, activeChildAgentCount, onCancelWithScope } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="max-w-md">
        <DialogHeader>
          <DialogTitle>Stop Subagents Too?</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This run currently has {activeChildAgentCount} active subagent
            {activeChildAgentCount === 1 ? "" : "s"}. You can stop only the main agent turn or
            cancel the subagents as well.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep running
            </Button>
            <Button type="button" variant="secondary" onClick={() => onCancelWithScope(false)}>
              Stop main agent only
            </Button>
            <Button type="button" variant="destructive" onClick={() => onCancelWithScope(true)}>
              Stop subagents too
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
