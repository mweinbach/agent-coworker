import type { ChatRenderItem } from "./activityGroups";
import type { PendingServerRequest } from "./threadStore";

export type ThreadDetailListItem =
  | {
      type: "pending";
      key: "pending";
      revision: string;
      data: PendingServerRequest;
    }
  | {
      type: "render";
      key: string;
      revision: string;
      data: ChatRenderItem;
    };

const objectRevisions = new WeakMap<object, number>();
let nextObjectRevision = 1;

function objectRevision(value: object): number {
  const existing = objectRevisions.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const revision = nextObjectRevision;
  nextObjectRevision += 1;
  objectRevisions.set(value, revision);
  return revision;
}

export function chatRenderItemKey(item: ChatRenderItem): string {
  return item.kind === "activity-group" ? item.id : item.item.id;
}

export function chatRenderItemRevision(item: ChatRenderItem): string {
  if (item.kind === "feed-item") {
    return String(objectRevision(item.item));
  }
  return item.items.map((entry) => objectRevision(entry)).join(".");
}

export function buildThreadDetailList(
  renderItems: ChatRenderItem[],
  pendingRequest: PendingServerRequest | null,
): ThreadDetailListItem[] {
  const items = renderItems.map(
    (data): ThreadDetailListItem => ({
      type: "render",
      key: chatRenderItemKey(data),
      revision: chatRenderItemRevision(data),
      data,
    }),
  );
  if (pendingRequest) {
    items.push({
      type: "pending",
      key: "pending",
      revision: String(objectRevision(pendingRequest)),
      data: pendingRequest,
    });
  }
  return items;
}
