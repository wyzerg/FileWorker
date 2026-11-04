import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import type { DirectoryListing, FinderDropEvent } from "./types";

interface DragContext {
  paths: string[];
  sessionId: string;
  local: DirectoryListing;
  remote: DirectoryListing;
}

export function useFinderDrop(options: {
  available: boolean;
  enabled: boolean;
  sessionId: string | null;
  local: DirectoryListing | null;
  remote: DirectoryListing | null;
  onUpload: (paths: string[], sessionId: string, destinationDir: string) => void;
  onInternalDragClear: () => void;
  onNotice: (message: string) => void;
}) {
  const { available, enabled, sessionId, local, remote } = options;
  const dropRef = useRef<HTMLDivElement>(null);
  const current = useRef(options);
  const pending = useRef<DragContext | null>(null);
  const [target, setTarget] = useState(false);
  const clear = useCallback(() => { pending.current = null; setTarget(false); }, []);
  useLayoutEffect(() => { current.current = options; });
  useLayoutEffect(clear, [available, enabled, sessionId, local, remote, clear]);

  useEffect(() => {
    if (!available) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const inside = (position: FinderDropEvent["position"]) => {
      const element = dropRef.current;
      if (!element || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
        || position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1) return false;
      const x = position.x * window.innerWidth;
      const y = position.y * window.innerHeight;
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(x, y);
      return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
        && hit !== null && element.contains(hit);
    };
    const samePaths = (left: string[], right: string[]) => left.length === right.length
      && left.every((path) => right.includes(path));
    const valid = (drag: DragContext | null): drag is DragContext => {
      const live = current.current;
      return Boolean(drag && live.available && live.enabled && live.sessionId === drag.sessionId
        && live.local === drag.local && live.remote === drag.remote);
    };
    void api.listenFinderDrop((event) => {
      if (!active) return;
      const live = current.current;
      if (event.phase === "enter") {
        clear();
        live.onInternalDragClear();
        if (!live.available || !live.enabled || !live.sessionId || !live.local || !live.remote
          || !event.paths?.length || event.paths.length > 256
          || event.paths.some((path) => typeof path !== "string" || !path)) return;
        pending.current = { paths: [...event.paths], sessionId: live.sessionId, local: live.local, remote: live.remote };
        setTarget(inside(event.position));
      } else if (event.phase === "drop") {
        const drag = pending.current;
        clear();
        if (valid(drag) && event.paths && samePaths(drag.paths, event.paths) && inside(event.position)) {
          live.onUpload(drag.paths, drag.sessionId, drag.remote.path);
        }
      } else if (event.phase === "leave") {
        clear();
      } else if (event.phase === "over" && pending.current) {
        if (!valid(pending.current)) clear();
        else setTarget(inside(event.position));
      }
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch((cause) => { if (active) current.current.onNotice(errorMessage(cause)); });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("dragstart", clear);
    return () => {
      active = false;
      unlisten?.();
      pending.current = null;
      window.removeEventListener("keydown", escape);
      window.removeEventListener("dragstart", clear);
    };
  }, [available, clear]);
  return { dropRef, target };
}
