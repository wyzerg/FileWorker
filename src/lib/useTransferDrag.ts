import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isOrdinaryFile } from "./files";
import type { DirectoryListing, FileEntry, TransferRequest } from "./types";

const dragType = "application/x-fileworker-transfer";
type PaneSide = "local" | "remote";

interface ActiveDrag {
  token: string;
  side: PaneSide;
  sessionId: string;
  local: DirectoryListing;
  remote: DirectoryListing;
  entries: FileEntry[];
}

export interface FilePaneDrag {
  enabled: boolean;
  target: boolean;
  begin: (entries: FileEntry[], data: DataTransfer) => boolean;
  accepts: (data: DataTransfer) => boolean;
  drop: (data: DataTransfer) => void;
  end: () => void;
}

export function useTransferDrag({ enabled, sessionId, local, remote, onTransfer }: {
  enabled: boolean;
  sessionId: string | null;
  local: DirectoryListing | null;
  remote: DirectoryListing | null;
  onTransfer: (requests: TransferRequest[]) => void;
}) {
  const pending = useRef<ActiveDrag | null>(null);
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const clear = useCallback(() => {
    pending.current = null;
    setActive(null);
  }, []);

  // A reload invalidates the gesture even when it returns to the same path.
  useLayoutEffect(clear, [enabled, sessionId, local, remote, clear]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("dragend", clear);
      pending.current = null;
    };
  }, [clear]);

  const valid = (drag: ActiveDrag | null): drag is ActiveDrag => Boolean(
    drag && enabled && sessionId === drag.sessionId && local === drag.local && remote === drag.remote,
  );

  return {
    clear,
    pane: (side: PaneSide): FilePaneDrag => ({
      enabled: enabled && Boolean(sessionId && local && remote),
      target: valid(active) && active.side !== side,
      begin: (entries, data) => {
        clear();
        const listing = side === "local" ? local : remote;
        if (!enabled || !sessionId || !local || !remote || !listing || !entries.length
          || !entries.every((entry) => isOrdinaryFile(entry) && listing.entries.includes(entry))
          || new Set(entries.map((entry) => entry.path)).size !== entries.length) return false;
        const drag: ActiveDrag = { token: crypto.randomUUID(), side, sessionId, local, remote, entries: [...entries] };
        data.clearData();
        data.setData(dragType, drag.token);
        data.effectAllowed = "copy";
        pending.current = drag;
        setActive(drag);
        return true;
      },
      accepts: (data) => valid(pending.current) && pending.current.side !== side && Array.from(data.types).includes(dragType),
      drop: (data) => {
        const drag = pending.current;
        clear();
        if (!valid(drag) || drag.side === side || data.getData(dragType) !== drag.token) return;
        onTransfer(drag.entries.map((entry) => ({
          sessionId: drag.sessionId,
          direction: drag.side === "local" ? "upload" : "download",
          sourcePath: entry.path,
          destinationDir: side === "local" ? drag.local.path : drag.remote.path,
        })));
      },
      end: clear,
    }),
  };
}
