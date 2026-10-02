import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeSettingsNavigation } from "@/hooks/useNativeSettingsNavigation";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const strictWrapper = ({ children }: PropsWithChildren) => (
  <StrictMode>{children}</StrictMode>
);

describe("useNativeSettingsNavigation", () => {
  let handlers: Array<() => void>;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = [];
    unlisten = vi.fn();
    invokeMock.mockReset().mockResolvedValue(false);
    listenMock.mockReset().mockImplementation((_event, handler) => {
      handlers.push(handler);
      return Promise.resolve(unlisten);
    });
  });

  it("listens before consuming a startup request", async () => {
    const registration = deferred<() => void>();
    listenMock.mockReturnValue(registration.promise);
    invokeMock.mockResolvedValueOnce(true);
    const openSettings = vi.fn();
    renderHook(() => useNativeSettingsNavigation(openSettings));

    expect(listenMock).toHaveBeenCalledWith(
      "native-menu-open-settings",
      expect.any(Function),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => registration.resolve(unlisten));
    expect(invokeMock).toHaveBeenCalledWith("take_pending_settings_navigation");
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("consumes active-window requests and leaves duplicate or idle drains harmless", async () => {
    const openSettings = vi.fn();
    renderHook(() => useNativeSettingsNavigation(openSettings));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(openSettings).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce(true);
    await act(async () => {
      handlers[0]();
      handlers[0]();
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("uses the current callback without reinstalling the listener", async () => {
    const original = vi.fn();
    const updated = vi.fn();
    const { rerender } = renderHook(
      ({ onOpen }) => useNativeSettingsNavigation(onOpen),
      { initialProps: { onOpen: original } },
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    rerender({ onOpen: updated });
    invokeMock.mockResolvedValueOnce(true);
    await act(async () => handlers[0]());
    expect(updated).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  it("unlistens on unmount and ignores callbacks from the disposed listener", async () => {
    const openSettings = vi.fn();
    const { unmount } = renderHook(() =>
      useNativeSettingsNavigation(openSettings),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
    await act(async () => handlers[0]());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("cleans up late registration without consuming the queued request", async () => {
    const registration = deferred<() => void>();
    listenMock.mockReturnValue(registration.promise);
    const openSettings = vi.fn();
    const { unmount } = renderHook(() =>
      useNativeSettingsNavigation(openSettings),
    );
    unmount();
    await act(async () => registration.resolve(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("preserves startup navigation under StrictMode and removes both listeners", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const openSettings = vi.fn();
    const { unmount } = renderHook(
      () => useNativeSettingsNavigation(openSettings),
      { wrapper: strictWrapper },
    );
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("delivers a consumed request when its drain crosses StrictMode cleanup", async () => {
    const request = deferred<boolean>();
    invokeMock.mockReturnValueOnce(request.promise);
    listenMock.mockImplementationOnce((_event, handler) => {
      // An event can arrive while registration is still resolving.
      handler();
      return Promise.resolve(unlisten);
    });
    const openSettings = vi.fn();
    renderHook(() => useNativeSettingsNavigation(openSettings), {
      wrapper: strictWrapper,
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await act(async () => request.resolve(true));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("does not navigate after an in-flight drain completes on an unmounted hook", async () => {
    const request = deferred<boolean>();
    invokeMock.mockReturnValueOnce(request.promise);
    const openSettings = vi.fn();
    const { unmount } = renderHook(() =>
      useNativeSettingsNavigation(openSettings),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => request.resolve(true));
    expect(openSettings).not.toHaveBeenCalled();
  });
});
