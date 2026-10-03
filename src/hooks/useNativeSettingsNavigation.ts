import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Drain native navigation only after listening, including requests queued while
 * the main webview was absent in lightweight mode. */
export function useNativeSettingsNavigation(openSettings: () => void): void {
  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    mountedRef.current = true;

    const deliverPending = () => {
      if (mountedRef.current && pendingRef.current) {
        pendingRef.current = false;
        openSettingsRef.current();
      }
    };
    deliverPending();

    const drain = async () => {
      if (disposed) return;
      try {
        const pending = await invoke<boolean>(
          "take_pending_settings_navigation",
        );
        if (pending) {
          // A request consumed by the previous StrictMode effect still belongs
          // to this mounted hook. Keep it until the current effect can deliver.
          pendingRef.current = true;
          deliverPending();
        }
      } catch (error) {
        console.error("Failed to drain native Settings navigation", error);
      }
    };

    void (async () => {
      try {
        const off = await listen("native-menu-open-settings", () => {
          void drain();
        });
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
        await drain();
      } catch (error) {
        console.error("Failed to subscribe native Settings navigation", error);
      }
    })();

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, []);
}
