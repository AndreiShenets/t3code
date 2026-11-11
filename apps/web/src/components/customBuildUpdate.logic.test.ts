import type { DesktopCustomBuildAction, DesktopCustomBuildState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { customBuildUpdatePresentation, performCustomBuildUpdate } from "./customBuildUpdate.logic";

const idle: DesktopCustomBuildState = {
  supported: true,
  status: "idle",
  currentBuild: "0.1.1 202610171200",
  availableBuild: null,
  message: null,
};

describe("custom-build controls", () => {
  it("keeps descriptions focused on the custom build source and version", () => {
    expect(customBuildUpdatePresentation(idle, false).description).toBe(
      "Releases from AndreiShenets/t3code. Installed: 0.1.1 202610171200.",
    );
    expect(customBuildUpdatePresentation({ ...idle, currentBuild: null }, false).description).toBe(
      "Releases from AndreiShenets/t3code.",
    );
    for (const status of ["available", "downloaded"] as const) {
      expect(
        customBuildUpdatePresentation(
          { ...idle, status, availableBuild: "0.1.1 202610171539" },
          false,
        ).description,
      ).toBe("Custom build 0.1.1 202610171539.");
    }
  });

  it("follows check, download, confirmed install with the same behavior for either entry point", async () => {
    const available = {
      ...idle,
      status: "available" as const,
      availableBuild: "0.1.1 202610171539",
    };
    const downloaded = { ...available, status: "downloaded" as const };
    const installing = { ...downloaded, status: "installing" as const };
    const steps: string[] = [];
    const act = vi.fn(async (action: DesktopCustomBuildAction) => {
      steps.push(action);
      return action === "check" ? available : action === "download" ? downloaded : installing;
    });
    const confirm = vi.fn(async (_message: string) => {
      steps.push("confirm");
      return true;
    });

    expect(customBuildUpdatePresentation(idle, false).label).toBe("Check for Custom Build");
    const checked = await performCustomBuildUpdate({ state: idle, act, confirm });
    expect(checked).toEqual(available);
    expect(customBuildUpdatePresentation(checked, false).label).toBe("Download Custom Build");
    const saved = await performCustomBuildUpdate({ state: checked!, act, confirm });
    expect(saved).toEqual(downloaded);
    expect(customBuildUpdatePresentation(saved, false).label).toBe("Install Custom Build");
    expect(confirm).not.toHaveBeenCalled();
    expect(await performCustomBuildUpdate({ state: saved!, act, confirm })).toEqual(installing);
    expect(steps).toEqual(["check", "download", "confirm", "install"]);
    expect(confirm.mock.calls[0]?.[0]).toContain("0.1.1 202610171539");
    expect(confirm.mock.calls[0]?.[0]).toContain("Running agents will be interrupted");
  });

  it("does not install if confirmation is cancelled or fails", async () => {
    const state = { ...idle, status: "downloaded" as const };
    const act = vi.fn(async () => idle);
    expect(await performCustomBuildUpdate({ state, act, confirm: async () => false })).toBeNull();
    await expect(
      performCustomBuildUpdate({
        state,
        act,
        confirm: async () => {
          throw new Error("dialog unavailable");
        },
      }),
    ).rejects.toThrow("dialog unavailable");
    expect(act).not.toHaveBeenCalled();
  });

  it.each(["checking", "downloading", "installing"] as const)(
    "blocks actions while %s",
    async (status) => {
      const state = { ...idle, status };
      const act = vi.fn(async () => idle);
      const confirm = vi.fn(async () => true);
      expect(customBuildUpdatePresentation(state, false)).toMatchObject({
        visible: true,
        disabled: true,
        busy: true,
      });
      expect(await performCustomBuildUpdate({ state, act, confirm })).toBeNull();
      expect(act).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("hides unsupported clients and disables both controls while confirmation is pending", () => {
    expect(customBuildUpdatePresentation(null, false).visible).toBe(false);
    expect(customBuildUpdatePresentation({ ...idle, supported: false }, false)).toMatchObject({
      visible: false,
      disabled: true,
    });
    expect(customBuildUpdatePresentation(idle, true).disabled).toBe(true);
  });

  it("can recheck a downloaded build without installing it", async () => {
    const act = vi.fn(async () => idle);
    const confirm = vi.fn(async () => true);
    expect(
      await performCustomBuildUpdate({
        state: { ...idle, status: "downloaded" },
        act,
        confirm,
        checkAgain: true,
      }),
    ).toEqual(idle);
    expect(act).toHaveBeenCalledWith("check");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("surfaces server failures instead of presenting a successful update", async () => {
    const failed = {
      ...idle,
      message: "Could not check custom releases on GitHub. Try again later.",
    };
    const next = await performCustomBuildUpdate({
      state: idle,
      act: async () => failed,
      confirm: async () => true,
    });
    expect(customBuildUpdatePresentation(next, false)).toMatchObject({
      disabled: false,
      description: failed.message,
    });
    await expect(
      performCustomBuildUpdate({
        state: idle,
        act: async () => {
          throw new Error("IPC disconnected");
        },
        confirm: async () => true,
      }),
    ).rejects.toThrow("IPC disconnected");
  });
});
