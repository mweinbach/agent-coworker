import { useAppStore } from "../../app/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Switch } from "../../components/ui/switch";

export function ResearchSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useAppStore((s) => s.researchDraftSettings);
  const setResearchDraftSettings = useAppStore((s) => s.setResearchDraftSettings);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose className="w-[min(96vw,28rem)]">
        <DialogHeader>
          <DialogTitle>Research settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Plan Approval</div>
            </div>
            <Switch
              checked={settings.planApproval}
              aria-label="Plan Approval"
              onCheckedChange={(checked) => setResearchDraftSettings({ planApproval: checked })}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
